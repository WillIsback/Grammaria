import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Analysis } from "./src/analysis/analyze.ts";
import { noteSur20 } from "./src/analysis/score.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

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
 * Journal des fautes : une ligne par texte corrigé, une ligne par faute.
 * Le texte complet n'est jamais conservé, seulement la phrase contenant la faute.
 */
export class Journal {
  private db: Database;

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
  }

  record(analysis: Analysis, now: number = Date.now()): void {
    const insertText = this.db.prepare(
      `INSERT INTO texts (created_at, word_count, fault_count, unclassified_count, score)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const insertFault = this.db.prepare(
      `INSERT INTO faults (text_id, created_at, rule_key, source, category_id, category_name,
         issue_type, message, word, replacement, sentence, counted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
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
    })();
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

  purge(): void {
    this.db.exec("DELETE FROM faults; DELETE FROM texts;");
  }

  close(): void {
    this.db.close();
  }
}
