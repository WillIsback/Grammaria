/**
 * Correcteur grammatical de l'application de bureau, côté page.
 *
 * Façade du Worker `lt/worker.js` (lt.worker.ts) : même contrat que `GrammarChecker` du serveur
 * (grammar.ts), pour que le gestionnaire de POST /api/check partagé l'utilise tel quel :
 * `check(text)` rend les détections au format de la réponse du serveur.
 *
 * - Le Worker n'est créé qu'à la première demande (ou par `prechauffer()`).
 * - Une seule analyse à la fois dans le Worker ; les autres attendent leur tour dans l'ordre.
 * - Délais maximaux : chargement des règles, puis chaque analyse. Un Worker qui ne répond plus
 *   (boucle, mémoire épuisée : le navigateur ne le signale pas toujours) est arrêté ; le suivant
 *   est recréé pour les demandes restantes.
 * - Un Worker tombé pendant une analyse est recréé et l'analyse relancée une fois.
 * - Archive absente ou abîmée : les demandes sont rejetées avec un message lisible ; la demande
 *   suivante retente le chargement.
 *
 * Ce module ne référence pas le script du Worker par `new URL(…, import.meta.url)` : l'importer
 * n'ajoute ni le Worker ni l'archive au build web (ils ne sont produits que par le build du
 * bureau, voir vite.config.ts).
 */
import type { LTMatch } from "../types.ts";
import {
  CHEMIN_WORKER,
  type MesuresChargement,
  type MessageDuWorker,
  type MessageVersWorker,
} from "./protocole-lt.ts";

export type { MesuresChargement } from "./protocole-lt.ts";

/** `arrete` : pas de Worker (pas encore démarré, arrêté ou à recréer). */
export type EtatCorrecteur = "arrete" | "chargement" | "pret" | "erreur";

/** Ce dont la façade a besoin d'un Worker (un faux en tests). */
export interface WorkerCorrecteur {
  postMessage(message: MessageVersWorker): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<MessageDuWorker>) => void) | null;
  onerror: ((event: Event) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
}

export interface OptionsCorrecteur {
  /** Script du Worker (défaut : `lt/worker.js` relatif à la page). */
  urlWorker?: string | URL;
  /** Délai maximal du chargement des règles (défaut : 60 s). */
  delaiChargementMs?: number;
  /** Délai maximal d'une analyse, une fois les règles chargées (défaut : 30 s, comme le serveur). */
  delaiControleMs?: number;
  /** Fabrique du Worker (tests). */
  creerWorker?: (url: URL) => WorkerCorrecteur;
  /** Appelé à chaque changement d'état. */
  onEtat?: (etat: EtatCorrecteur, correcteur: CorrecteurBureau) => void;
}

const DELAI_CHARGEMENT_MS = 60_000;
const DELAI_CONTROLE_MS = 30_000;
/** Relances d'une analyse interrompue par la chute du Worker. */
const RELANCES_MAX = 1;

type Demande = {
  id: number;
  texte: string;
  relances: number;
  resolve: (matches: LTMatch[]) => void;
  reject: (error: Error) => void;
};

type Attente = { resolve: () => void; reject: (error: Error) => void };

export class CorrecteurBureau {
  etat: EtatCorrecteur = "arrete";
  /** Mesures du dernier chargement réussi. */
  mesures: MesuresChargement | null = null;
  /** Message de la dernière erreur de chargement. */
  erreur: string | null = null;

  private readonly options: OptionsCorrecteur;
  private worker: WorkerCorrecteur | null = null;
  private minuteur: ReturnType<typeof setTimeout> | null = null;
  private readonly file: Demande[] = [];
  private enCours: Demande | null = null;
  private attentes: Attente[] = [];
  private diagnostics: ((absentes: string[]) => void)[] = [];
  private prochainId = 1;

  constructor(options: OptionsCorrecteur = {}) {
    this.options = options;
  }

  /** Charge les règles en arrière-plan ; la promesse se résout quand le correcteur est prêt. */
  prechauffer(): Promise<void> {
    if (this.etat === "pret") return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.attentes.push({ resolve, reject });
      this.demarrer();
    });
  }

  /** Détections de LanguageTool sur `text`, au format de POST /api/check. */
  check(text: string): Promise<LTMatch[]> {
    return new Promise((resolve, reject) => {
      this.file.push({ id: this.prochainId++, texte: text, relances: 0, resolve, reject });
      if (this.worker) this.suivante();
      else this.demarrer();
    });
  }

  /** Ressources demandées par le moteur et absentes de l'archive (vérification). */
  diagnostic(): Promise<string[]> {
    return new Promise((resolve) => {
      this.demarrer();
      if (!this.worker) {
        resolve([]);
        return;
      }
      this.diagnostics.push(resolve);
      this.worker.postMessage({ type: "diagnostic" });
    });
  }

  /** Arrête le Worker et rejette les demandes en attente. */
  close(): void {
    this.arreterWorker();
    this.echouerTout(new Error("Le correcteur grammatical a été arrêté."));
    this.changerEtat("arrete");
  }

  private demarrer(): void {
    if (this.worker) return;
    const url = new URL(
      this.options.urlWorker ?? CHEMIN_WORKER,
      globalThis.location?.href ?? "http://localhost/",
    );
    let worker: WorkerCorrecteur;
    try {
      worker = this.options.creerWorker
        ? this.options.creerWorker(url)
        : (new Worker(url, { type: "module" }) as unknown as WorkerCorrecteur);
    } catch (error) {
      this.echecChargement(error instanceof Error ? error.message : String(error));
      return;
    }
    this.worker = worker;
    worker.onmessage = (event) => {
      if (this.worker === worker) this.recevoir(event.data);
    };
    worker.onerror = (event) => {
      if (this.worker !== worker) return;
      event.preventDefault?.();
      const message = (event as ErrorEvent).message;
      this.chute(message || "le script du Worker est introuvable ou invalide");
    };
    worker.onmessageerror = () => {
      if (this.worker === worker) this.chute("message illisible");
    };
    this.changerEtat("chargement");
    this.armer(this.options.delaiChargementMs ?? DELAI_CHARGEMENT_MS, () =>
      this.echecChargement("le chargement des règles a dépassé le délai"),
    );
  }

  private recevoir(message: MessageDuWorker): void {
    switch (message.type) {
      case "pret": {
        this.desarmer();
        this.mesures = message.mesures;
        this.erreur = null;
        this.changerEtat("pret");
        for (const attente of this.attentes.splice(0)) attente.resolve();
        this.suivante();
        return;
      }
      case "erreur":
        this.echecChargement(message.message);
        return;
      case "diagnostic":
        for (const resolve of this.diagnostics.splice(0)) resolve(message.absentes);
        return;
      case "resultat":
      case "echec": {
        const demande = this.enCours;
        if (!demande || demande.id !== message.id) return;
        this.desarmer();
        this.enCours = null;
        if (message.type === "resultat") {
          demande.resolve(JSON.parse(message.json) as LTMatch[]);
        } else {
          demande.reject(new Error(`Le correcteur grammatical a échoué : ${message.message}`));
        }
        this.suivante();
      }
    }
  }

  /** Envoie la demande suivante si le Worker est prêt et libre. */
  private suivante(): void {
    if (this.etat !== "pret" || this.enCours || !this.worker) return;
    const demande = this.file.shift();
    if (!demande) return;
    this.enCours = demande;
    this.armer(this.options.delaiControleMs ?? DELAI_CONTROLE_MS, () => {
      // Worker bloqué : on l'arrête ; le suivant sera recréé pour les demandes restantes.
      this.enCours = null;
      this.arreterWorker();
      this.changerEtat("arrete");
      demande.reject(new Error("Le correcteur grammatical ne répond pas."));
      if (this.file.length > 0) this.demarrer();
    });
    this.worker.postMessage({ type: "controle", id: demande.id, texte: demande.texte });
  }

  /** Le Worker est tombé (erreur non rattrapée, script introuvable…). */
  private chute(cause: string): void {
    if (this.etat !== "pret") {
      this.echecChargement(cause);
      return;
    }
    const demande = this.enCours;
    this.enCours = null;
    this.arreterWorker();
    this.changerEtat("arrete");
    if (demande) {
      if (demande.relances < RELANCES_MAX) {
        demande.relances++;
        this.file.unshift(demande);
      } else {
        demande.reject(new Error(`Le correcteur grammatical s'est arrêté : ${cause}.`));
      }
    }
    if (this.file.length > 0) this.demarrer();
  }

  /** Chargement impossible : toutes les demandes en attente sont rejetées. */
  private echecChargement(cause: string): void {
    this.arreterWorker();
    this.erreur = `Le correcteur grammatical n'a pas pu charger ses règles : ${cause}`;
    this.echouerTout(new Error(this.erreur));
    this.changerEtat("erreur");
  }

  private echouerTout(error: Error): void {
    const demandes = [...(this.enCours ? [this.enCours] : []), ...this.file.splice(0)];
    this.enCours = null;
    for (const demande of demandes) demande.reject(error);
    for (const attente of this.attentes.splice(0)) attente.reject(error);
    for (const resolve of this.diagnostics.splice(0)) resolve([]);
  }

  private arreterWorker(): void {
    this.desarmer();
    const worker = this.worker;
    this.worker = null;
    worker?.terminate();
  }

  private armer(delai: number, action: () => void): void {
    this.desarmer();
    this.minuteur = setTimeout(() => {
      this.minuteur = null;
      action();
    }, delai);
  }

  private desarmer(): void {
    if (this.minuteur !== null) clearTimeout(this.minuteur);
    this.minuteur = null;
  }

  private changerEtat(etat: EtatCorrecteur): void {
    if (this.etat === etat) return;
    this.etat = etat;
    this.options.onEtat?.(etat, this);
  }
}
