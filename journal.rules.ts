import type { Database } from "bun:sqlite";
import type { Analysis } from "./src/analysis/analyze.ts";
import { FICHES, type Fiche, libelleSansFiche } from "./src/analysis/fiches.ts";
import {
  appliquerEvenement,
  entreDansLeCycle,
  type EtatCycle,
  type RuleContext,
  type RuleEvent,
  type RuleState,
  type Transition,
  type TransitionType,
} from "./src/analysis/regles/cycle.ts";
import {
  type Candidat,
  choisirIntervention,
  type Intervention,
  type Reussite,
} from "./src/analysis/regles/intervention.ts";
import { JOUR_MS, SEUILS } from "./src/analysis/regles/seuils.ts";

/** Une règle telle que l'expose `GET /api/rules`. */
export interface RuleView extends RuleState {
  /** Nom lisible : titre de la fiche, sinon message du correcteur grammatical. */
  label: string;
  categoryName: string;
  /** Fiche de règle (titre, astuce) quand la règle en possède une. */
  fiche: Fiche | null;
}

/** Type d'une ligne de l'historique : transition du cycle ou sollicitation. */
export type RuleHistoryType =
  | TransitionType
  | "astuce"
  | "choix"
  | "reponse_juste"
  | "reponse_fausse";

/** Une ligne datée de l'historique d'une règle (`GET /api/rules/events`). */
export interface RuleHistoryEntry {
  id: number;
  ruleKey: string;
  at: number;
  type: RuleHistoryType;
  /** États avant et après, pour les transitions ; null sinon. */
  from: EtatCycle | null;
  to: EtatCycle | null;
}

/** Issue de l'enregistrement d'une réponse à un choix à deux formes. */
export type AnswerResult = "recorded" | "unknown" | "conflict";

/** Ce que le serveur demande d'afficher près du bouton Copier pour un texte. */
export interface Suivi {
  intervention: Intervention | null;
  reussites: Reussite[];
}

export interface FollowOptions {
  /** Texte d'origine, pour proposer les deux formes sur la phrase de l'utilisateur. */
  original?: string;
  /** Tirage de l'ordre des deux formes ; injectable pour les tests. */
  random?: () => number;
}

/**
 * Champs de `RuleState`, dans l'ordre des colonnes de `rule_states` : la
 * colonne est le nom du champ en snake_case (`tipsShown` → `tips_shown`).
 */
const CHAMPS_ETAT = [
  "ruleKey",
  "state",
  "stateSince",
  "occurrences",
  "firstFaultAt",
  "lastFaultAt",
  "tipsShown",
  "choicesShown",
  "choicesCorrect",
  "choicesWrong",
  "lastSolicitedAt",
  "solicitationsThatDay",
  "acquiredAt",
  "relapses",
] as const satisfies readonly (keyof RuleState)[];

const colonne = (champ: string) => champ.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
/** Colonnes de `rule_states` lues sous le nom des champs de `RuleState`. */
const SELECT_ETAT = CHAMPS_ETAT.map((c) => `${colonne(c)} AS ${c}`).join(", ");

/**
 * État des règles dans la base du journal : une ligne par règle
 * (`rule_states`) et l'historique daté des transitions et des sollicitations
 * (`rule_events`). Toute la logique est dans `src/analysis/regles/` ; cette
 * classe ne fait que lui fournir les faits et conserver le résultat.
 */
export class RuleStore {
  constructor(private db: Database) {}

  /** Crée les tables de la Phase 2. Idempotent. */
  createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rule_states (
        rule_key TEXT NOT NULL PRIMARY KEY,
        state TEXT NOT NULL,
        state_since INTEGER NOT NULL,
        occurrences INTEGER NOT NULL,
        first_fault_at INTEGER NOT NULL,
        last_fault_at INTEGER NOT NULL,
        tips_shown INTEGER NOT NULL DEFAULT 0,
        choices_shown INTEGER NOT NULL DEFAULT 0,
        choices_correct INTEGER NOT NULL DEFAULT 0,
        choices_wrong INTEGER NOT NULL DEFAULT 0,
        last_solicited_at INTEGER,
        solicitations_that_day INTEGER NOT NULL DEFAULT 0,
        acquired_at INTEGER,
        relapses INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS rule_events (
        id INTEGER PRIMARY KEY,
        rule_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        type TEXT NOT NULL,
        from_state TEXT,
        to_state TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_rule_events_rule ON rule_events(rule_key, created_at);
      CREATE INDEX IF NOT EXISTS idx_rule_events_created ON rule_events(created_at);
    `);
  }

  /**
   * Migration d'une base v0.2.0 : reconstruit l'état des règles, s'il n'en
   * existe aucun, en rejouant le journal texte par texte, dans l'ordre
   * chronologique et avec les dates d'origine : les fautes du texte, puis
   * l'usage (acquisition). Une règle acquise depuis longtemps l'est donc dès
   * la migration, à sa date historique, sans message de réussite au premier
   * texte corrigé ensuite. Les tables `texts` et `faults` ne sont pas modifiées.
   */
  replay(): void {
    const { n } = this.db.query("SELECT COUNT(*) AS n FROM rule_states").get() as { n: number };
    if (n > 0) return;
    const faults = this.db
      .query(
        `SELECT text_id AS textId, rule_key AS ruleKey, COUNT(*) AS count
         FROM faults WHERE counted = 1
         GROUP BY text_id, rule_key ORDER BY text_id, MIN(id)`,
      )
      .all() as { textId: number; ruleKey: string; count: number }[];
    const byText = new Map<number, { ruleKey: string; count: number }[]>();
    for (const fault of faults) {
      if (!entreDansLeCycle({ ruleKey: fault.ruleKey, counted: true })) continue;
      const list = byText.get(fault.textId);
      if (list) list.push(fault);
      else byText.set(fault.textId, [fault]);
    }
    const texts = this.db
      .query("SELECT id, created_at AS at FROM texts ORDER BY created_at, id")
      .all() as { id: number; at: number }[];
    for (const text of texts) {
      for (const fault of byText.get(text.id) ?? []) {
        this.applyFault(fault.ruleKey, fault.count, text.id, text.at);
      }
      this.checkAcquisitions(text.at);
    }
  }

  private load(ruleKey: string): RuleState | null {
    return this.db
      .query(`SELECT ${SELECT_ETAT} FROM rule_states WHERE rule_key = ?`)
      .get(ruleKey) as RuleState | null;
  }

  private save(s: RuleState): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO rule_states (${CHAMPS_ETAT.map(colonne).join(", ")})
         VALUES (${CHAMPS_ETAT.map(() => "?").join(", ")})`,
      )
      .run(...CHAMPS_ETAT.map((c) => s[c]));
  }

  private log(
    ruleKey: string,
    at: number,
    type: RuleHistoryType,
    from: EtatCycle | null = null,
    to: EtatCycle | null = null,
  ): number {
    const { lastInsertRowid } = this.db
      .query(
        `INSERT INTO rule_events (rule_key, created_at, type, from_state, to_state)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(ruleKey, at, type, from, to);
    return Number(lastInsertRowid);
  }

  /** Applique un événement, enregistre l'état et ses transitions. */
  private apply(
    ruleKey: string,
    event: RuleEvent,
    context: RuleContext,
    now: number,
    known?: RuleState,
  ): { state: RuleState; transitions: Transition[] } | null {
    const result = appliquerEvenement(ruleKey, known ?? this.load(ruleKey), event, context, now);
    if (!result) return null;
    this.save(result.state);
    for (const t of result.transitions) this.log(t.ruleKey, t.at, t.type, t.from, t.to);
    return result;
  }

  private applyFault(ruleKey: string, count: number, textId: number, now: number): RuleState {
    const previous = this.db
      .query(
        `SELECT created_at AS at FROM faults
         WHERE rule_key = ? AND counted = 1 AND text_id < ? AND created_at > ?`,
      )
      .all(ruleKey, textId, now - SEUILS.signalementFenetreJours * JOUR_MS) as { at: number }[];
    const { n: otherWorkedRules } = this.db
      .query("SELECT COUNT(*) AS n FROM rule_states WHERE state = 'travaillee' AND rule_key != ?")
      .get(ruleKey) as { n: number };
    const result = this.apply(
      ruleKey,
      { type: "faute", count },
      { previousFaultTimes: previous.map((p) => p.at), otherWorkedRules },
      now,
    );
    // Une faute crée toujours l'état : le résultat n'est jamais null ici.
    return (result as { state: RuleState }).state;
  }

  /** Règles « signalées » ou « travaillées » devenues « acquises » avec ce texte. */
  private checkAcquisitions(now: number): Reussite[] {
    const states = this.db
      .query(
        `SELECT ${SELECT_ETAT} FROM rule_states
         WHERE state IN ('signalee', 'travaillee') AND last_fault_at <= ?
         ORDER BY rule_key`,
      )
      .all(now - SEUILS.acquisitionJoursSansFaute * JOUR_MS) as RuleState[];
    if (states.length === 0) return [];
    const oldest = Math.min(...states.map((s) => s.lastFaultAt));
    const texts = (
      this.db
        .query("SELECT created_at AS at FROM texts WHERE created_at > ? AND created_at <= ?")
        .all(oldest, now) as { at: number }[]
    ).map((t) => t.at);

    const reussites: Reussite[] = [];
    for (const state of states) {
      const result = this.apply(
        state.ruleKey,
        { type: "usage" },
        { textTimesSinceLastFault: texts },
        now,
        state,
      );
      if (result?.state.state === "acquise") {
        reussites.push({ ruleKey: state.ruleKey, titre: this.label(state.ruleKey).label });
      }
    }
    return reussites;
  }

  private label(ruleKey: string): { label: string; categoryName: string } {
    const row = this.db
      .query(
        `SELECT message, category_name AS categoryName FROM faults
         WHERE rule_key = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(ruleKey) as { message: string; categoryName: string } | null;
    return {
      label: FICHES[ruleKey]?.titre ?? libelleSansFiche(ruleKey, row),
      categoryName: row?.categoryName ?? "",
    };
  }

  /**
   * Met à jour l'état des règles pour un texte qui vient d'être journalisé
   * (`textId`) et décide de l'intervention à afficher. À appeler dans la même
   * transaction que l'enregistrement du texte.
   */
  follow(analysis: Analysis, textId: number, now: number, options: FollowOptions = {}): Suivi {
    // Seules les fautes classées et comptées dans la note entrent dans le cycle.
    const candidats = new Map<string, Candidat & { count: number }>();
    for (const correction of analysis.corrections) {
      for (const fault of correction.faults) {
        if (!entreDansLeCycle(fault)) continue;
        let candidat = candidats.get(fault.ruleKey);
        if (!candidat) {
          candidat = {
            // remplacé juste après par l'état à jour
            state: undefined as unknown as RuleState,
            titre: correction.fiche?.titre ?? libelleSansFiche(fault.ruleKey, fault),
            astuce: correction.fiche?.astuce ?? null,
            passages: [],
            count: 0,
          };
          candidats.set(fault.ruleKey, candidat);
        }
        candidat.count++;
        candidat.passages.push({
          start: correction.start,
          end: correction.end,
          avant: correction.avant,
          apres: correction.apres,
        });
      }
    }
    for (const [ruleKey, candidat] of candidats) {
      candidat.state = this.applyFault(ruleKey, candidat.count, textId, now);
    }

    const reussites = this.checkAcquisitions(now);

    const proposee = choisirIntervention(
      [...candidats.values()],
      options.original ?? "",
      now,
      options.random,
    );
    if (!proposee) return { intervention: null, reussites };
    this.apply(proposee.ruleKey, { type: proposee.type }, {}, now);
    const eventId = this.log(proposee.ruleKey, now, proposee.type);
    // L'événement « choix » identifie ce choix précis : la réponse s'y rattache.
    const intervention: Intervention =
      proposee.type === "choix" ? { ...proposee, choiceId: eventId } : proposee;
    return { intervention, reussites };
  }

  /**
   * Enregistre la réponse à un choix à deux formes précis, une seule fois.
   * « unknown » : aucun choix ne porte cet identifiant. « conflict » : le choix
   * a déjà reçu sa réponse, ou un choix plus récent l'a remplacé pour la règle.
   */
  answer(choiceId: number, correct: boolean, now: number): AnswerResult {
    return this.db.transaction((): AnswerResult => {
      const choix = this.db
        .query("SELECT rule_key AS ruleKey FROM rule_events WHERE id = ? AND type = 'choix'")
        .get(choiceId) as { ruleKey: string } | null;
      if (!choix) return "unknown";
      // Les événements d'une règle se suivent : un choix est en attente tant
      // qu'aucun autre choix ni aucune réponse ne le suit.
      const { n } = this.db
        .query(
          `SELECT COUNT(*) AS n FROM rule_events
           WHERE rule_key = ? AND id > ? AND type IN ('choix', 'reponse_juste', 'reponse_fausse')`,
        )
        .get(choix.ruleKey, choiceId) as { n: number };
      const state = this.load(choix.ruleKey);
      if (n > 0 || !state) return "conflict";
      this.apply(choix.ruleKey, { type: "reponse", correct }, {}, now, state);
      this.log(choix.ruleKey, now, correct ? "reponse_juste" : "reponse_fausse");
      return "recorded";
    })();
  }

  /** Toutes les règles suivies, de la plus récemment fautive à la plus ancienne. */
  list(): RuleView[] {
    const states = this.db
      .query(`SELECT ${SELECT_ETAT} FROM rule_states ORDER BY last_fault_at DESC, rule_key`)
      .all() as RuleState[];
    return states.map((state) => ({
      ...state,
      ...this.label(state.ruleKey),
      fiche: FICHES[state.ruleKey] ?? null,
    }));
  }

  /** Historique daté, du plus récent au plus ancien ; toutes les règles sans `ruleKey`. */
  events(options: { limit?: number; ruleKey?: string } = {}): RuleHistoryEntry[] {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 200), 1), 1000);
    return this.db
      .query(
        `SELECT id, rule_key AS ruleKey, created_at AS at, type,
                from_state AS "from", to_state AS "to"
         FROM rule_events WHERE (?1 IS NULL OR rule_key = ?1) ORDER BY id DESC LIMIT ?2`,
      )
      .all(options.ruleKey || null, limit) as RuleHistoryEntry[];
  }

  purge(): void {
    this.db.exec("DELETE FROM rule_events; DELETE FROM rule_states;");
  }
}
