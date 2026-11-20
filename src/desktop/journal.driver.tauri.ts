/**
 * Pilote du journal de l'application de bureau : les commandes Rust `db_read`, `db_read_many` et
 * `db_batch` (src-tauri/src/db.rs), derrière l'interface `JournalDriver` (journal.driver.ts).
 *
 * Aucune règle ici : Rust refuse les écritures en lecture, les transactions dans un lot, les
 * pragmas hors liste, et annule le lot entier à la première erreur ou au premier `expectChanges`
 * non respecté. Le message d'erreur de Rust est transmis tel quel (`Conflit : …` pour un
 * `expectChanges`, reconnu par `estConflit`).
 */
import type { JournalDriver } from "../../journal.driver.ts";
import { type Invoke, invokeSur } from "./tauri.ts";

export function creerPiloteTauri(invoke: Invoke): JournalDriver {
  const appeler = invokeSur(invoke);
  return {
    read: (sql, params) => appeler("db_read", { sql, params: params ?? [] }),
    readMany: (queries) =>
      appeler("db_read_many", {
        queries: queries.map(({ sql, params }) => ({ sql, params: params ?? [] })),
      }),
    batch: (statements) =>
      appeler("db_batch", {
        statements: statements.map(({ sql, params, expectChanges }) => ({
          sql,
          params: params ?? [],
          ...(expectChanges === undefined ? {} : { expectChanges }),
        })),
      }),
    // La base reste ouverte côté Rust pendant toute la vie de l'application.
  };
}
