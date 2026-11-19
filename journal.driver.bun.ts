import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  type BatchResult,
  ExpectChangesError,
  type JournalDriver,
  type Query,
  resoudreParametre,
  type SqlValue,
  type Statement,
} from "./journal.driver.ts";

const LECTURE = /^\s*(SELECT|WITH)\b/i;
/** `PRAGMA nom` ou `PRAGMA nom(argument)`, sans affectation. */
const PRAGMA_LECTURE = /^\s*PRAGMA\s+[\w.]+\s*(\(\s*[\w'"]*\s*\))?\s*;?\s*$/i;

/**
 * Pilote du journal sur `bun:sqlite` (serveur web et tests). Seul fichier du
 * journal à importer Bun ou Node. Les appels sont synchrones sous la
 * promesse : un lot ne s'entrelace jamais avec un autre.
 */
export class BunJournalDriver implements JournalDriver {
  readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  /** Exécute une requête de lecture ; refuse tout ce qui n'est pas une lecture. */
  private lire<T>(sql: string, params: SqlValue[] = []): T[] {
    if (!LECTURE.test(sql) && !PRAGMA_LECTURE.test(sql)) {
      throw new Error("read : seules les requêtes de lecture sont acceptées");
    }
    // `query` garde l'instruction préparée en cache.
    return this.db.query(sql).all(...params) as T[];
  }

  /**
   * Lit dans une transaction toujours annulée : un instantané cohérent, et
   * aucune écriture possible même si une requête en contenait une.
   */
  private enLecture<T>(lire: () => T): T {
    this.db.exec("BEGIN");
    try {
      return lire();
    } finally {
      this.db.exec("ROLLBACK");
    }
  }

  async read<T>(sql: string, params?: SqlValue[]): Promise<T[]> {
    return this.enLecture(() => this.lire<T>(sql, params));
  }

  async readMany(queries: readonly Query[]): Promise<unknown[][]> {
    return this.enLecture(() => queries.map((q) => this.lire(q.sql, q.params)));
  }

  async batch(statements: readonly Statement[]): Promise<BatchResult[]> {
    return this.db.transaction(() => {
      const resultats: BatchResult[] = [];
      statements.forEach((st, i) => {
        const params = (st.params ?? []).map((p) => resoudreParametre(p, i, resultats));
        const { changes, lastInsertRowid } = this.db.query(st.sql).run(...params);
        if (st.expectChanges !== undefined && changes !== st.expectChanges) {
          throw new ExpectChangesError(i, st.expectChanges, changes);
        }
        resultats.push({ changes, lastInsertRowid: Number(lastInsertRowid) });
      });
      return resultats;
    })();
  }

  close(): void {
    this.db.close();
  }
}

/** Ouvre (et crée au besoin, avec son dossier) la base du journal à `path`. */
export function ouvrirPiloteBun(path: string): BunJournalDriver {
  return new BunJournalDriver(path);
}
