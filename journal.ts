import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Analysis } from "./src/analysis/analyze.ts";
import { noteSur20 } from "./src/analysis/score.ts";
import { BadgeStore } from "./journal.badges.ts";
import {
  calculerProgression,
  debutPremiereSemaine,
  type Progression,
} from "./src/analysis/progression/calcul.ts";
import { lireFautes, lireTextes } from "./journal.progress.ts";
import {
  type AnswerResult,
  type FollowOptions,
  type RuleHistoryEntry,
  RuleStore,
  type RuleView,
  type Suivi,
} from "./journal.rules.ts";

export type { RuleHistoryEntry, RuleHistoryType, RuleView, Suivi } from "./journal.rules.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Version du schéma, conservée dans `PRAGMA user_version` : 0 pour une base
 * v0.2.0, 1 avec le cycle de vie des règles, 2 avec les badges.
 */
export const SCHEMA_VERSION = 2;

export interface PeriodSummary {
  texts: number;
  words: number;
  faults: number;
  score: number | null;
}

export interface RuleCount {
  ruleKey: string;
  categoryName: string;
  message: string;
  count: number;
}

export interface WordCount {
  word: string;
  replacement: string;
  count: number;
}

export interface JournalSummary {
  days: number;
  period: PeriodSummary;
  unclassified: number;
  rules: RuleCount[];
  words: WordCount[];
}

/**
 * Journal des fautes : une ligne par texte corrigé, une ligne par faute, et
 * l'état de chaque règle dans son cycle de vie (voir `journal.rules.ts`).
 * Le texte complet n'est jamais conservé, seulement la phrase contenant la faute.
 */
export class Journal {
  private db: Database;
  private ruleStore: RuleStore;
  /** Badges de progression (voir `journal.badges.ts`). */
  readonly badges: BadgeStore;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS texts (
        id INTEGER PRIMARY KEY,
        user_id TEXT NOT NULL DEFAULT 'local',
        created_at INTEGER NOT NULL,
        word_count INTEGER NOT NULL,
        fault_count INTEGER NOT NULL,
        unclassified_count INTEGER NOT NULL,
        score REAL
      );
      CREATE TABLE IF NOT EXISTS faults (
        id INTEGER PRIMARY KEY,
        text_id INTEGER NOT NULL REFERENCES texts(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL DEFAULT 'local',
        created_at INTEGER NOT NULL,
        rule_key TEXT NOT NULL,
        source TEXT NOT NULL,
        category_id TEXT NOT NULL,
        category_name TEXT NOT NULL,
        issue_type TEXT NOT NULL,
        message TEXT NOT NULL,
        word TEXT NOT NULL,
        replacement TEXT NOT NULL,
        sentence TEXT NOT NULL,
        counted INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_texts_created ON texts(created_at);
      CREATE INDEX IF NOT EXISTS idx_faults_rule ON faults(rule_key, created_at);
      CREATE INDEX IF NOT EXISTS idx_faults_word ON faults(word, created_at);
    `);
    this.ruleStore = new RuleStore(this.db);
    this.badges = new BadgeStore(this.db);
    this.migrate();
  }

  /**
   * Crée les tables manquantes et met le schéma à la version courante, en une
   * transaction. Idempotent. Sur une base v0.2.0, l'état des règles est
   * reconstruit à partir des fautes journalisées ; sur une base antérieure aux
   * badges, les badges déjà mérités sont attribués à leur date réelle, sans
   * notification. Les tables `texts` et `faults` ne sont jamais modifiées.
   */
  private migrate(): void {
    this.ruleStore.createTables();
    this.badges.createTable();
    const { user_version: version } = this.db.query("PRAGMA user_version").get() as {
      user_version: number;
    };
    if (version >= SCHEMA_VERSION) return;
    this.db.transaction(() => {
      if (version < 1) this.ruleStore.replay();
      // Attribution rétroactive : le résultat (badges nouveaux) n'est pas annoncé.
      if (version < 2) this.badges.award();
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    })();
  }

  /**
   * Journalise un texte corrigé, met à jour l'état des règles et renvoie
   * l'intervention à afficher près du bouton Copier.
   */
  record(analysis: Analysis, now: number = Date.now(), options: FollowOptions = {}): Suivi {
    const insertText = this.db.prepare(
      `INSERT INTO texts (created_at, word_count, fault_count, unclassified_count, score)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const insertFault = this.db.prepare(
      `INSERT INTO faults (text_id, created_at, rule_key, source, category_id, category_name,
         issue_type, message, word, replacement, sentence, counted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    return this.db.transaction(() => {
      const { lastInsertRowid } = insertText.run(
        now,
        analysis.wordCount,
        analysis.faultCount,
        analysis.unclassifiedCount,
        analysis.score,
      );
      for (const correction of analysis.corrections) {
        for (const f of correction.faults) {
          insertFault.run(
            lastInsertRowid,
            now,
            f.ruleKey,
            f.source,
            f.categoryId,
            f.categoryName,
            f.issueType,
            f.message,
            f.word,
            f.replacement,
            f.sentence,
            f.counted ? 1 : 0,
          );
        }
      }
      // Le suivi des règles ne doit jamais faire perdre le texte journalisé :
      // transaction imbriquée (point de sauvegarde), annulée seule en cas d'échec.
      try {
        return this.db.transaction(() =>
          this.ruleStore.follow(analysis, Number(lastInsertRowid), now, options),
        )();
      } catch (error) {
        console.error("[journal] suivi des règles annulé pour ce texte :", error);
        return { intervention: null, reussites: [] };
      }
    })();
  }

  /** État de chaque règle suivie dans son cycle de vie. */
  rules(): RuleView[] {
    return this.ruleStore.list();
  }

  /** Historique daté des transitions et des sollicitations. */
  ruleEvents(options: { limit?: number; ruleKey?: string } = {}): RuleHistoryEntry[] {
    return this.ruleStore.events(options);
  }

  /** Réponse de l'utilisateur à un choix à deux formes précis (`choiceId`). */
  answerChoice(choiceId: number, correct: boolean, now: number = Date.now()): AnswerResult {
    return this.ruleStore.answer(choiceId, correct, now);
  }

  period(days: number, now: number = Date.now()): PeriodSummary {
    const row = this.db
      .query(
        `SELECT COUNT(*) AS texts, COALESCE(SUM(word_count), 0) AS words,
                COALESCE(SUM(fault_count), 0) AS faults
         FROM texts WHERE created_at > ?`,
      )
      .get(now - days * DAY_MS) as { texts: number; words: number; faults: number };
    return { ...row, score: noteSur20(row.faults, row.words) };
  }

  summary(days: number, now: number = Date.now()): JournalSummary {
    const since = now - days * DAY_MS;
    const unclassified = this.db
      .query("SELECT COALESCE(SUM(unclassified_count), 0) AS n FROM texts WHERE created_at > ?")
      .get(since) as { n: number };
    const rules = this.db
      .query(
        `SELECT rule_key AS ruleKey, MAX(category_name) AS categoryName,
                MAX(message) AS message, COUNT(*) AS count
         FROM faults WHERE created_at > ? AND counted = 1
         GROUP BY rule_key ORDER BY count DESC, rule_key LIMIT 20`,
      )
      .all(since) as RuleCount[];
    const words = this.db
      .query(
        `SELECT word, MAX(replacement) AS replacement, COUNT(*) AS count
         FROM faults WHERE created_at > ? AND counted = 1 AND word != ''
         GROUP BY word ORDER BY count DESC, word LIMIT 20`,
      )
      .all(since) as WordCount[];
    return { days, period: this.period(days, now), unclassified: unclassified.n, rules, words };
  }

  /** Écran « Progression » : tout est calculé par `src/analysis/progression/`. */
  progress(now: number = Date.now()): Progression {
    return calculerProgression(
      {
        texts: lireTextes(this.db),
        faults: lireFautes(this.db, debutPremiereSemaine(now)),
        rules: this.rules(),
      },
      now,
    );
  }

  /** Efface le journal, remet à zéro l'état des règles et retire les badges. */
  purge(): void {
    this.db.transaction(() => {
      this.db.exec("DELETE FROM faults; DELETE FROM texts;");
      this.ruleStore.purge();
      this.badges.purge();
    })();
  }

  close(): void {
    this.db.close();
  }
}
