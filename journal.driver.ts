/**
 * Pilote de la base du journal : la seule porte d'accès du journal à SQLite.
 *
 * Le journal (`journal.ts`, `journal.rules.ts`, `journal.badges.ts`) ne fait
 * jamais de transaction interactive : il LIT un instantané (`readMany`),
 * CALCULE en pur, puis ÉCRIT un lot atomique (`batch`). Deux implémentations :
 * `journal.driver.bun.ts` (serveur, `bun:sqlite`) et les commandes Rust du
 * bureau (`db_read`, `db_read_many`, `db_batch`), derrière un pont asynchrone.
 *
 * Ce fichier ne contient que des types : aucun import de Bun ni de Node, il se
 * compile pour le navigateur.
 */

export type SqlValue = string | number | null;

/**
 * Paramètre d'une instruction d'un lot : une valeur, ou `{ $rowid: n }`, qui
 * vaut le `lastInsertRowid` de l'instruction d'indice `n` du même lot
 * (`n` inférieur à l'indice de l'instruction courante).
 */
export type BatchParam = SqlValue | { $rowid: number };

export interface Query {
  sql: string;
  params?: SqlValue[];
}

export interface Statement {
  /** Une seule instruction SQL. */
  sql: string;
  params?: BatchParam[];
  /**
   * Nombre de lignes que l'instruction doit modifier. S'il diffère, le lot
   * entier est annulé et `batch` échoue.
   */
  expectChanges?: number;
}

export interface BatchResult {
  changes: number;
  lastInsertRowid: number;
}

export interface JournalDriver {
  /** Lignes d'une requête de lecture ; refusée si l'instruction écrit. */
  read<T>(sql: string, params?: SqlValue[]): Promise<T[]>;
  /** Lignes de plusieurs requêtes de lecture, lues sur un même instantané. */
  readMany(queries: readonly Query[]): Promise<unknown[][]>;
  /**
   * Exécute les instructions dans UNE transaction, dans l'ordre. Tout est
   * annulé à la première erreur ou au premier `expectChanges` non respecté.
   */
  batch(statements: readonly Statement[]): Promise<BatchResult[]>;
  /** Ferme la base (facultatif : le pilote du bureau la garde ouverte). */
  close?(): void | Promise<void>;
}

/** Erreur d'un lot dont une instruction n'a pas modifié le nombre de lignes attendu. */
export class ExpectChangesError extends Error {
  constructor(
    readonly index: number,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(
      `expectChanges : l'instruction ${index} du lot a modifié ${actual} ligne(s) au lieu de ${expected}`,
    );
    this.name = "ExpectChangesError";
  }
}

/** Valeur d'un paramètre de lot, `{ $rowid: n }` remplacé par le résultat de l'instruction n. */
export function resoudreParametre(
  param: BatchParam,
  index: number,
  resultats: readonly BatchResult[],
): SqlValue {
  if (param === null || typeof param !== "object") return param;
  const n = param.$rowid;
  if (!Number.isInteger(n) || n < 0 || n >= index || n >= resultats.length) {
    throw new Error(`$rowid ${n} invalide pour l'instruction ${index} du lot`);
  }
  return resultats[n].lastInsertRowid;
}
