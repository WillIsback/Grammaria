/**
 * Dépendances du gestionnaire d'API (`api/deps.ts`) dans l'application de bureau : réglages,
 * mots valides et modèle passent par les commandes Rust (src-tauri/src/{store,llm}.rs), le
 * journal par son pilote Tauri (journal.driver.tauri.ts), le correcteur par le moteur Rust de
 * l'application (correcteur.ts, commandes de src-tauri/src/correcteur.rs). Le gestionnaire, lui, est le même que celui du serveur Bun.
 */
import type {
  CorrecteurDeps,
  DependancesApi,
  ErreurModele,
  FragmentModele,
  JournalDeps,
  ModeleDeps,
  MotsValidesDeps,
  OptionsGestionnaire,
  ReglagesDeps,
} from "../../api/deps.ts";
import type { ServerSettings } from "../../api/reglages.ts";
import { type ApiTauri, type Invoke, invokeSur, messageErreur } from "./tauri.ts";

/** Statistiques de fin de flux du relais Rust (`LlmStats`). */
export interface StatsLlm {
  durationMs: number;
  firstTokenMs: number | null;
  reasoningChunks: number;
  contentChunks: number;
}

/** Message du Channel de `llm_chat` (`LlmEvent` de llm.rs). */
export type EvenementLlm =
  | { event: "delta"; data: string }
  | { event: "done"; data: StatsLlm }
  | { event: "error"; data: { status?: number; message: string; cancelled: boolean } };

export function creerReglages(invoke: Invoke): ReglagesDeps {
  const appeler = invokeSur(invoke);
  return {
    vuePublique: () => appeler<ServerSettings>("settings_get"),
    // Erreur de validation de Rust : message en français, renvoyé en 400 par le gestionnaire.
    mettreAJour: (update) => appeler<ServerSettings>("settings_set", { update }),
  };
}

export function creerMotsValides(invoke: Invoke): MotsValidesDeps {
  const appeler = invokeSur(invoke);
  return {
    lire: () => appeler<string[]>("valid_words_get"),
    // « Invalid word » (400) ou « Failed to save word » (500) : voir le gestionnaire.
    ajouter: (word) => appeler<string[]>("valid_words_add", { word }),
  };
}

/** File d'attente des messages du Channel, lus un par un par le flux. */
class FileEvenements {
  private readonly recus: EvenementLlm[] = [];
  private attente: ((evenement: EvenementLlm) => void) | null = null;

  pousser(evenement: EvenementLlm): void {
    const attente = this.attente;
    if (attente) {
      this.attente = null;
      attente(evenement);
    } else {
      this.recus.push(evenement);
    }
  }

  suivant(): Promise<EvenementLlm> {
    const evenement = this.recus.shift();
    if (evenement) return Promise.resolve(evenement);
    return new Promise((resolve) => (this.attente = resolve));
  }
}

function erreurModele(data: { status?: number; message: string; cancelled: boolean }) {
  const erreur: Error & ErreurModele & { cancelled?: boolean } = new Error(data.message);
  erreur.status = data.status ?? null;
  erreur.cancelled = data.cancelled;
  return erreur;
}

const attendre = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface OptionsModele {
  /** Premier identifiant de requête (défaut : tiré au hasard, pour survivre à un rechargement). */
  premierId?: number;
  /** Pause entre deux tentatives d'annulation (défaut : 20 ms). */
  pauseAnnulationMs?: number;
}

/**
 * Le modèle par le relais Rust : `llm_models`, `llm_chat` (fragments par Channel) et
 * `llm_cancel`. Pas de `relayer` : les autres routes /v1/* répondent 404.
 */
export function creerModele(api: ApiTauri, options: OptionsModele = {}): ModeleDeps {
  const appeler = invokeSur(api.invoke);
  // Identifiants uniques pour la vie du processus Rust, même si la page est rechargée pendant
  // qu'une requête précédente se termine.
  let prochainId = options.premierId ?? Math.floor(Math.random() * 2 ** 40) + 1;
  const pause = options.pauseAnnulationMs ?? 20;

  /**
   * `llm_cancel` répond faux si la requête n'est pas (encore) enregistrée côté Rust : l'appel
   * `llm_chat` peut ne pas y être arrivé. On réessaie tant que le flux n'est pas terminé.
   */
  async function annuler(requestId: number, termine: () => boolean): Promise<void> {
    for (let essai = 0; essai < 100 && !termine(); essai++) {
      const annulee = await api.invoke<boolean>("llm_cancel", { requestId }).catch(() => false);
      if (annulee) return;
      await attendre(pause);
    }
  }

  return {
    listerModeles: () => appeler<unknown>("llm_models"),

    async ouvrirFlux(corps, signal) {
      const requestId = prochainId++;
      const file = new FileEvenements();
      const canal = new api.Channel<EvenementLlm>();
      // Vrai dès que Rust a envoyé la fin ou l'erreur : plus rien à annuler.
      let termine = false;
      canal.onmessage = (evenement) => {
        if (evenement.event !== "delta") termine = true;
        file.pousser(evenement);
      };
      const surAbandon = () => void annuler(requestId, () => termine);

      // La fin et l'erreur arrivent par le Channel ; un rejet d'invoke (commande refusée,
      // arguments invalides) n'envoie rien sur le Channel : il devient une erreur du flux.
      api.invoke("llm_chat", { requestId, body: corps, onEvent: canal }).catch((error) => {
        termine = true;
        file.pousser({ event: "error", data: { message: messageErreur(error), cancelled: false } });
      });
      if (signal.aborted) surAbandon();
      else signal.addEventListener("abort", surAbandon, { once: true });

      // Refus avant le premier fragment (400 sur `chat_template_kwargs`…) : la promesse est
      // rejetée, le gestionnaire peut relancer sans le paramètre.
      const premier = await file.suivant();
      if (premier.event === "error") {
        signal.removeEventListener("abort", surAbandon);
        throw erreurModele(premier.data);
      }

      return (async function* (): AsyncGenerator<FragmentModele> {
        let evenement: EvenementLlm = premier;
        try {
          for (;;) {
            if (evenement.event === "delta") {
              yield { content: evenement.data };
            } else if (evenement.event === "done") {
              // Le relais compte le raisonnement sans le transmettre.
              yield { reasoningChunks: evenement.data.reasoningChunks };
              return;
            } else {
              throw erreurModele(evenement.data);
            }
            evenement = await file.suivant();
          }
        } finally {
          signal.removeEventListener("abort", surAbandon);
          // Lecture abandonnée avant la fin : la requête au modèle est annulée.
          if (!termine) surAbandon();
        }
      })();
    },
  };
}

export interface DependancesBureau {
  api: ApiTauri;
  journal: JournalDeps;
  correcteur: CorrecteurDeps;
  modele?: OptionsModele;
  /** Ligne de fin de correction du journal technique (`grammaria.log`). */
  surFinCorrection?: OptionsGestionnaire["surFinCorrection"];
}

/** Toutes les dépendances du gestionnaire sur le bureau. */
export function dependancesBureau({
  api,
  journal,
  correcteur,
  modele,
  surFinCorrection,
}: DependancesBureau): DependancesApi {
  return {
    journal,
    correcteur,
    reglages: creerReglages(api.invoke),
    motsValides: creerMotsValides(api.invoke),
    modele: creerModele(api, modele),
    // Réglages modifiables ; pas d'autre origine que la page ; `top_k` non envoyé ; l'abandon
    // d'une requête par l'interface annule la requête au modèle.
    options: {
      bureau: true,
      // La version de l'application installée, telle que Tauri la connaît.
      versionApplication: async () =>
        (await api.invoke<{ currentVersion: string }>("update_status")).currentVersion,
      originesCors: [],
      llmTopK: -1,
      suivreAbandonRequete: true,
      surFinCorrection,
    },
  };
}
