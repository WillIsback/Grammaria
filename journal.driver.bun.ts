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
  verifierEcriture,
  verifierLecture,
  verifierParametre,
} from "./journal.driver.ts";

const SCHEMA = /^\s*(CREATE|DROP|ALTER|PRAGMA)\b/i;

/**
 * Pilote du journal sur `bun:sqlite` (serveur web et tests). Seul fichier du
 * journal à importer Bun ou Node. Il applique les mêmes refus que le pilote
 * Rust du bureau (voir `journal.driver.ts`) et lève les mêmes erreurs :
 * `Conflit : …` pour un `expectChanges` non respecté, `Instruction i : …`
 * pour les autres. Les appels sont synchrones sous la promesse : un lot ne
 * s'entrelace jamais avec un autre.
 */
export class BunJournalDriver implements JournalDriver {
  readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    // Posés par le pilote à l'ouverture, jamais par le journal.
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  /** Exécute une requête de lecture ; refuse tout ce qui n'est pas une lecture. */
  private lire<T>(sql: string, params: SqlValue[] = [], index = 0): T[] {
    try {
      verifierLecture(sql);
      // `query` garde l'instruction préparée en cache.
      return this.db.query(sql).all(...params.map(verifierParametre)) as T[];
    } catch (error) {
      throw new Error(`Instruction ${index} : ${(error as Error).message}`, { cause: error });
    }
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
    return this.enLecture(() => queries.map((q, i) => this.lire(q.sql, q.params, i)));
  }

  async batch(statements: readonly Statement[]): Promise<BatchResult[]> {
    // Le lot EST la transaction (IMMEDIATE) : tout ou rien.
    return this.db
      .transaction(() => {
        const resultats: BatchResult[] = [];
        statements.forEach((st, i) => {
          let changes: number;
          let lastInsertRowid: number | bigint;
          try {
            verifierEcriture(st.sql);
            const params = (st.params ?? []).map((p) =>
              verifierParametre(resoudreParametre(p, i, resultats)),
            );
            ({ changes, lastInsertRowid } = this.db.query(st.sql).run(...params));
            // Comme le pilote Rust : 0 ligne modifiée pour une instruction de schéma.
            if (SCHEMA.test(st.sql)) changes = 0;
          } catch (error) {
            throw new Error(`Instruction ${i} : ${(error as Error).message}`, { cause: error });
          }
          if (st.expectChanges !== undefined && changes !== st.expectChanges) {
            throw new ExpectChangesError(i, st.expectChanges, changes);
          }
          resultats.push({ changes, lastInsertRowid: Number(lastInsertRowid) });
        });
        return resultats;
      })
      .immediate();
  }

  close(): void {
    this.db.close();
  }
}

/** Ouvre (et crée au besoin, avec son dossier) la base du journal à `path`. */
export function ouvrirPiloteBun(path: string): BunJournalDriver {
  return new BunJournalDriver(path);
}
