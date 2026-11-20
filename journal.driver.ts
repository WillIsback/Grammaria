/**
 * Pilote de la base du journal : la seule porte d'accès du journal à SQLite.
 *
 * Le journal (`journal.ts`, `journal.rules.ts`, `journal.badges.ts`) ne fait
 * jamais de transaction interactive : il LIT un instantané (`readMany`),
 * CALCULE en pur, puis ÉCRIT un lot atomique (`batch`). Deux implémentations :
 * `journal.driver.bun.ts` (serveur, `bun:sqlite`) et les commandes Rust du
 * bureau (`db_read`, `db_read_many`, `db_batch`), derrière un pont asynchrone.
 *
 * Ce fichier contient les types et les règles communes aux pilotes (une
 * instruction par entrée, pas de transaction dans un lot, lecture seule pour
 * `read`, erreurs « Conflit : » et « Instruction i : ») : aucun import de Bun
 * ni de Node, il se compile pour le navigateur.
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
    // Même préfixe que le pilote Rust : « Conflit : ».
    super(
      `Conflit : l'instruction ${index} du lot a modifié ${actual} ligne(s) au lieu de ${expected}`,
    );
    this.name = "ExpectChangesError";
  }
}

/** Message d'une erreur reçue d'un pilote (une `Error`, ou une chaîne pour `invoke`). */
function message(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return String(error);
}

/**
 * Vrai si un lot a été refusé parce qu'un `expectChanges` n'était pas
 * respecté : même réponse quel que soit le pilote (`Conflit : …`).
 */
export function estConflit(error: unknown): boolean {
  return error instanceof ExpectChangesError || message(error).startsWith("Conflit :");
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
    throw new Error(`$rowid ${n} invalide : il doit désigner une instruction antérieure du lot`);
  }
  return resultats[n].lastInsertRowid;
}

/*
 * Règles communes aux deux pilotes, appliquées par le pilote Rust du bureau et
 * reproduites par le pilote Bun, pour qu'un écart se voie dans les tests.
 */

/**
 * Plus haute `PRAGMA user_version` qu'un lot peut écrire : la version du schéma
 * connue de cette version de Grammaria. À tenir égale à `SCHEMA_VERSION` de
 * `journal.ts` et à `USER_VERSION_MAX` du pilote Rust (`src-tauri/src/db.rs`) ;
 * un test de chaque côté vérifie l'égalité.
 */
export const USER_VERSION_MAX = 2;

/**
 * Pragmas lisibles par `read` et `readMany`. Le journal ne lit que
 * `user_version` ; les autres servent aux tests et aux vérifications. Chacun
 * doit figurer dans `PRAGMAS_LECTURE` du pilote Rust (`src-tauri/src/db.rs`) :
 * un test le vérifie en lisant ce fichier.
 */
export const PRAGMAS_LISIBLES: readonly string[] = [
  "user_version",
  "schema_version",
  "journal_mode",
  "foreign_keys",
  "table_info",
  "index_list",
  "index_info",
];

/**
 * Parmi eux, ceux qui prennent un nom de table ou d'index en argument
 * (`PRAGMA table_info(badges)`). Pour les autres, un argument serait une
 * valeur à écrire (`PRAGMA journal_mode(DELETE)`). Chacun doit figurer dans
 * `PRAGMAS_A_ARGUMENT` du pilote Rust.
 */
export const PRAGMAS_A_ARGUMENT: readonly string[] = ["table_info", "index_list", "index_info"];

/**
 * Supprime chaînes, identifiants entre délimiteurs et commentaires d'une
 * instruction : il ne reste que les mots-clés et la ponctuation.
 */
function squelette(sql: string): string {
  let out = "";
  for (let i = 0; i < sql.length;) {
    const c = sql[i];
    const fin = c === "'" ? "'" : c === '"' ? '"' : c === "`" ? "`" : c === "[" ? "]" : null;
    if (fin) {
      const j = sql.indexOf(fin, i + 1);
      i = j < 0 ? sql.length : j + 1;
      out += " ? ";
    } else if (sql.startsWith("--", i)) {
      const j = sql.indexOf("\n", i);
      i = j < 0 ? sql.length : j + 1;
      out += " ";
    } else if (sql.startsWith("/*", i)) {
      const j = sql.indexOf("*/", i + 2);
      i = j < 0 ? sql.length : j + 2;
      out += " ";
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * Vérifie qu'une entrée ne contient qu'UNE instruction SQL et la renvoie
 * sans commentaires ni chaînes, en majuscules, sans le `;` final.
 */
function uneSeuleInstruction(sql: string): string {
  const s = squelette(sql).trim().replace(/;\s*$/, "");
  if (!s) throw new Error("instruction vide");
  if (s.includes(";")) throw new Error("une seule instruction SQL par entrée");
  return s.toUpperCase();
}

const INTERDITES = /^(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|ATTACH|DETACH|VACUUM)\b/;

/** Refuse ce qu'un pilote n'accepte pas en lecture (`read`, `readMany`). */
export function verifierLecture(sql: string): void {
  const s = uneSeuleInstruction(sql);
  if (/^(SELECT|WITH)\b/.test(s)) {
    // Un SELECT n'écrit pas ; un WITH peut précéder une écriture.
    if (/^WITH\b/.test(s) && /\b(INSERT|UPDATE|DELETE|REPLACE)\b/.test(s)) {
      throw new Error("read : instruction d'écriture refusée");
    }
    return;
  }
  const pragma = s.match(/^PRAGMA\s+(\w+)\s*(\(\s*[^)]*\))?$/);
  if (pragma) {
    const nom = pragma[1].toLowerCase();
    const admis = pragma[2] === undefined ? PRAGMAS_LISIBLES : PRAGMAS_A_ARGUMENT;
    if (admis.includes(nom)) return;
  }
  throw new Error("read : seules les requêtes de lecture sont acceptées");
}

/** Refuse ce qu'un pilote n'accepte pas dans un lot (`batch`). */
export function verifierEcriture(sql: string): void {
  const s = uneSeuleInstruction(sql);
  if (INTERDITES.test(s)) {
    throw new Error("le lot est la transaction : BEGIN, SAVEPOINT, ATTACH… sont refusés");
  }
  if (/^PRAGMA\b/.test(s)) {
    const version = s.match(/^PRAGMA\s+USER_VERSION\s*=\s*(\d+)$/);
    if (!version) throw new Error("seul PRAGMA user_version peut être écrit");
    // Dans la plage des versions connues : un lot ne fait jamais passer le
    // journal pour celui d'une version future.
    if (Number(version[1]) > USER_VERSION_MAX) {
      throw new Error(`PRAGMA user_version doit rester entre 0 et ${USER_VERSION_MAX}`);
    }
  }
  if (/^CREATE\s+VIRTUAL\b/.test(s)) throw new Error("tables virtuelles refusées");
  // Jamais envoyés par le journal (CREATE TABLE et CREATE INDEX IF NOT EXISTS
  // seulement) : un déclencheur ou une vue ferait exécuter du SQL caché aux
  // écritures et lectures suivantes, un DROP ou un ALTER détruirait le journal.
  if (/^CREATE\s+(TEMP\s+|TEMPORARY\s+)?(TRIGGER|VIEW)\b/.test(s)) {
    throw new Error("déclencheurs et vues refusés");
  }
  if (/^(DROP|ALTER)\b/.test(s)) throw new Error("DROP et ALTER sont refusés");
  if (/\bSQLITE_(MASTER|SCHEMA)\b/.test(s) && !/^(SELECT|WITH)\b/.test(s)) {
    throw new Error("sqlite_master est protégé en écriture");
  }
}

/** Paramètre accepté par les pilotes : null, nombre, texte, booléen (0/1). Pas de BLOB. */
export function verifierParametre(valeur: unknown): SqlValue {
  if (valeur === null || typeof valeur === "string") return valeur;
  if (typeof valeur === "number" && Number.isFinite(valeur)) return valeur;
  if (typeof valeur === "boolean") return valeur ? 1 : 0;
  throw new Error(`paramètre refusé : ${typeof valeur}`);
}
