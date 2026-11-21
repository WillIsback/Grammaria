/**
 * Application de bureau simulée pour les tests du pont : `invoke` et `Channel` de Tauri, avec
 * le comportement des commandes Rust (src-tauri/src/{db,store,llm}.rs) qui compte pour la page :
 *  - `db_read` / `db_read_many` / `db_batch` sur une vraie base SQLite en mémoire (node:sqlite) :
 *    lot dans UNE transaction, `{ $rowid: n }`, `expectChanges` (« Conflit : … »), erreurs
 *    renvoyées comme Rust, en chaînes ;
 *  - réglages (la clé ne sort jamais), mots valides ;
 *  - relais du modèle : fragments par Channel, fin ou erreur par le Channel APRÈS la réponse
 *    d'`invoke` (le pire ordre possible), annulation par `llm_cancel`.
 */
import type * as Sqlite from "node:sqlite";
import type { ApiTauri, CanalTauri } from "../../../src/desktop/tauri";

type Valeur = string | number | null;
type Evenement =
  | { event: "delta"; data: string }
  | { event: "done"; data: Record<string, unknown> }
  | { event: "error"; data: { status?: number; message: string; cancelled: boolean } };

export class CanalSimule<T> implements CanalTauri<T> {
  onmessage: (message: T) => void = () => {};
}

const ECRITURE =
  /^\s*(insert|update|delete|replace|create|drop|alter|begin|commit|attach|vacuum)\b/i;

export interface OptionsSimulation {
  /** Délai avant l'enregistrement d'une requête du modèle côté « Rust » (annulation tardive). */
  delaiEnregistrementMs?: number;
}

export function tauriSimule(options: OptionsSimulation = {}) {
  // Sans `import` : les tests jsdom (environnement « navigateur ») ne peuvent pas importer de
  // module intégré de Node, mais tournent bien dans Node.
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof Sqlite;
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const appels: { commande: string; args?: Record<string, unknown> }[] = [];
  const reglages = {
    llmTarget: "",
    llmApiKey: "",
    llmModelName: "",
    llmDisableThinking: true,
  };
  let mots: string[] = [];
  /** Panne simulée de l'enregistrement des mots valides. */
  const pannes = { mots: null as string | null, modeles: null as string | null };
  /** Corps reçus par `llm_chat`, dans l'ordre. */
  const corpsModele: Record<string, unknown>[] = [];
  /** Requêtes du modèle en cours (annulables) et requêtes annulées. */
  const enCours = new Map<number, () => void>();
  const annulees: number[] = [];
  /** Appelé avant chaque lot (simule une écriture concurrente). */
  let avantLot: ((sqls: string[]) => void) | null = null;

  const vue = () => ({
    editable: true,
    configured: reglages.llmTarget !== "",
    llmTarget: reglages.llmTarget,
    llmModelName: reglages.llmModelName,
    llmDisableThinking: reglages.llmDisableThinking,
    hasApiKey: reglages.llmApiKey !== "",
  });

  const lire = (sql: string, params: Valeur[] = []) => {
    if (ECRITURE.test(sql) || /^\s*pragma\s+\w+\s*=/i.test(sql)) {
      throw "Instruction refusée : seule la lecture est permise ici.";
    }
    return db.prepare(sql).all(...params);
  };

  function lot(statements: { sql: string; params?: unknown[]; expectChanges?: number }[]) {
    avantLot?.(statements.map((s) => s.sql));
    const resultats: { changes: number; lastInsertRowid: number }[] = [];
    db.exec("BEGIN IMMEDIATE");
    try {
      statements.forEach((st, i) => {
        const params = (st.params ?? []).map((p) => {
          if (p !== null && typeof p === "object") {
            const n = (p as { $rowid: number }).$rowid;
            if (!(n >= 0 && n < i)) throw `Instruction ${i} : $rowid ${n} invalide`;
            return resultats[n].lastInsertRowid;
          }
          return p as Valeur;
        });
        let r;
        try {
          r = db.prepare(st.sql).run(...params);
        } catch (error) {
          throw `Instruction ${i} : ${(error as Error).message}`;
        }
        const changes = Number(r.changes);
        if (st.expectChanges !== undefined && changes !== st.expectChanges) {
          throw `Conflit : l'instruction ${i} du lot a modifié ${changes} ligne(s) au lieu de ${st.expectChanges}`;
        }
        resultats.push({ changes, lastInsertRowid: Number(r.lastInsertRowid) });
      });
      db.exec("COMMIT");
      return resultats;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Scénarios du faux modèle, selon `body.model`. */
  function relayer(
    requestId: number,
    body: Record<string, unknown>,
    canal: CanalSimule<Evenement>,
  ) {
    const envoyer = (e: Evenement) => setTimeout(() => canal.onmessage(e), 0);
    const modele = String(body.model);
    let annule = false;
    let minuteur: ReturnType<typeof setTimeout> | undefined;
    const fin = (e: Evenement) => {
      enCours.delete(requestId);
      clearTimeout(minuteur);
      envoyer(e);
    };
    const demarrer = () => {
      if (annule) return;
      if (modele === "rejet" && "chat_template_kwargs" in body) {
        fin({
          event: "error",
          data: {
            status: 400,
            message: "Unrecognized request argument: chat_template_kwargs",
            cancelled: false,
          },
        });
        return;
      }
      if (modele === "panne") {
        envoyer({ event: "delta", data: "Début" });
        fin({ event: "error", data: { message: "Connexion au modèle coupée.", cancelled: false } });
        return;
      }
      if (modele === "lent" || modele === "muet") {
        let n = 0;
        const tic = () => {
          if (annule) return;
          if (modele === "lent") envoyer({ event: "delta", data: `m${n++} ` });
          minuteur = setTimeout(tic, 10);
        };
        minuteur = setTimeout(tic, modele === "muet" ? 1_000_000 : 5);
        return;
      }
      for (const d of ["Bonjour", " à ", "tous."]) envoyer({ event: "delta", data: d });
      fin({
        event: "done",
        data: { durationMs: 3, firstTokenMs: 1, reasoningChunks: 2, contentChunks: 3 },
      });
    };
    const enregistrer = () => {
      enCours.set(requestId, () => {
        annule = true;
        annulees.push(requestId);
        fin({ event: "error", data: { message: "Requête annulée.", cancelled: true } });
      });
      demarrer();
    };
    if (options.delaiEnregistrementMs) setTimeout(enregistrer, options.delaiEnregistrementMs);
    else enregistrer();
  }

  /** Lignes reçues par `log_page` (journal technique). */
  const journalTechnique: { niveau: string; message: string }[] = [];

  async function invokeBrut(
    commande: string,
    args: Record<string, unknown> = {},
  ): Promise<unknown> {
    switch (commande) {
      case "db_read":
        return lire(args.sql as string, args.params as Valeur[]);
      case "db_read_many":
        return (args.queries as { sql: string; params?: Valeur[] }[]).map((q) =>
          lire(q.sql, q.params),
        );
      case "db_batch":
        return lot(args.statements as never);
      case "db_compacter":
        db.exec("VACUUM");
        return null;
      case "settings_get":
        return vue();
      case "settings_set": {
        const update = args.update as Partial<typeof reglages>;
        if (update.llmTarget === "http://refuse.test") throw "Adresse refusée par l'application.";
        Object.assign(reglages, update);
        return vue();
      }
      case "valid_words_get":
        return mots;
      case "valid_words_add": {
        if (pannes.mots) throw pannes.mots;
        const word = args.word as string;
        if (!mots.includes(word)) mots = [...mots, word];
        return mots;
      }
      case "llm_models":
        if (pannes.modeles) throw { message: pannes.modeles, cancelled: false };
        return { data: [{ id: "normal", type: "text-generation" }] };
      case "llm_chat": {
        const body = args.body as Record<string, unknown>;
        corpsModele.push(body);
        relayer(args.requestId as number, body, args.onEvent as CanalSimule<Evenement>);
        // Rust répond à la fin du flux ; ici tout de suite : la page ne doit pas s'y fier.
        return null;
      }
      case "log_page":
        journalTechnique.push({ niveau: args.niveau as string, message: args.message as string });
        return null;
      case "llm_cancel": {
        const annuler = enCours.get(args.requestId as number);
        if (!annuler) return false;
        annuler();
        return true;
      }
      default:
        throw `Commande ${commande} non autorisée`;
    }
  }

  const invoke = async <T>(commande: string, args?: Record<string, unknown>): Promise<T> => {
    appels.push({ commande, args });
    return (await invokeBrut(commande, args)) as T;
  };
  const api: ApiTauri = { invoke, Channel: CanalSimule };

  return {
    api,
    db,
    appels,
    reglages,
    pannes,
    corpsModele,
    annulees,
    enCours,
    journalTechnique,
    commandes: () => appels.map((a) => a.commande),
    set avantLot(f: ((sqls: string[]) => void) | null) {
      avantLot = f;
    },
  };
}
