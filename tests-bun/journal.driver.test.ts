import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BunJournalDriver, ouvrirPiloteBun } from "../journal.driver.bun.ts";
import { ExpectChangesError } from "../journal.driver.ts";
import { avecBase } from "./helpers.ts";

function piloteAvecTables(path = ":memory:"): BunJournalDriver {
  const pilote = ouvrirPiloteBun(path);
  pilote.db.exec(`
    CREATE TABLE parents (id INTEGER PRIMARY KEY, nom TEXT NOT NULL UNIQUE);
    CREATE TABLE enfants (
      id INTEGER PRIMARY KEY,
      parent_id INTEGER NOT NULL REFERENCES parents(id),
      nom TEXT NOT NULL
    );
  `);
  return pilote;
}

/** Erreur d'une promesse rejetée ; null si elle est tenue. */
const echec = (promesse: Promise<unknown>) =>
  promesse.then(
    () => null,
    (error: unknown) => error,
  );

describe("Pilote bun:sqlite du journal", () => {
  it("lit des lignes avec des paramètres", async () => {
    const pilote = piloteAvecTables();
    pilote.db.exec("INSERT INTO parents (nom) VALUES ('a'), ('b')");
    expect(await pilote.read("SELECT nom FROM parents WHERE id > ? ORDER BY id", [1])).toEqual([
      { nom: "b" },
    ]);
    expect(await pilote.read("PRAGMA user_version")).toEqual([{ user_version: 0 }]);
  });

  it("refuse une écriture dans read et readMany", async () => {
    const pilote = piloteAvecTables();
    expect(await echec(pilote.read("INSERT INTO parents (nom) VALUES ('x')"))).toBeInstanceOf(
      Error,
    );
    expect(await echec(pilote.read("PRAGMA user_version = 3"))).toBeInstanceOf(Error);
    expect(
      await echec(pilote.readMany([{ sql: "SELECT 1" }, { sql: "DELETE FROM parents" }])),
    ).toBeInstanceOf(Error);
    expect(await pilote.read("SELECT COUNT(*) AS n FROM parents")).toEqual([{ n: 0 }]);
    expect(await pilote.read("PRAGMA user_version")).toEqual([{ user_version: 0 }]);
  });

  it("readMany renvoie les lignes de chaque requête, dans l'ordre", async () => {
    const pilote = piloteAvecTables();
    pilote.db.exec("INSERT INTO parents (nom) VALUES ('a')");
    expect(
      await pilote.readMany([
        { sql: "SELECT COUNT(*) AS n FROM parents" },
        { sql: "SELECT nom FROM parents WHERE nom = ?", params: ["a"] },
        { sql: "SELECT nom FROM parents WHERE 0" },
      ]),
    ).toEqual([[{ n: 1 }], [{ nom: "a" }], []]);
  });

  it("readMany lit un seul instantané, même si une autre connexion écrit", async () => {
    await avecBase(async (path) => {
      const pilote = piloteAvecTables(path);
      const autre = ouvrirPiloteBun(path);
      let n = 0;
      // Entre les deux requêtes, une autre connexion ajoute une ligne.
      const lignes = await pilote.readMany([
        { sql: "SELECT COUNT(*) AS n FROM parents" },
        {
          get sql() {
            if (n++ === 0) autre.db.exec("INSERT INTO parents (nom) VALUES ('concurrent')");
            return "SELECT COUNT(*) AS n FROM parents";
          },
        },
      ]);
      expect(lignes).toEqual([[{ n: 0 }], [{ n: 0 }]]);
      expect(await pilote.read("SELECT COUNT(*) AS n FROM parents")).toEqual([{ n: 1 }]);
      autre.close();
      pilote.close();
    });
  });

  it("batch exécute un lot et remplace $rowid par l'id inséré par l'instruction n", async () => {
    const pilote = piloteAvecTables();
    pilote.db.exec("INSERT INTO parents (nom) VALUES ('déjà là')");
    const resultats = await pilote.batch([
      { sql: "INSERT INTO parents (nom) VALUES (?)", params: ["p1"] },
      { sql: "INSERT INTO parents (nom) VALUES (?)", params: ["p2"] },
      { sql: "INSERT INTO enfants (parent_id, nom) VALUES (?, ?)", params: [{ $rowid: 0 }, "e1"] },
      { sql: "INSERT INTO enfants (parent_id, nom) VALUES (?, ?)", params: [{ $rowid: 1 }, "e2"] },
      { sql: "UPDATE parents SET nom = nom || '!' WHERE id >= ?", params: [{ $rowid: 0 }] },
    ]);
    expect(resultats.map((r) => r.changes)).toEqual([1, 1, 1, 1, 2]);
    expect(resultats.slice(0, 4).map((r) => r.lastInsertRowid)).toEqual([2, 3, 1, 2]);
    expect(
      await pilote.read(
        "SELECT e.nom AS enfant, p.nom AS parent FROM enfants e JOIN parents p ON p.id = e.parent_id ORDER BY e.id",
      ),
    ).toEqual([
      { enfant: "e1", parent: "p1!" },
      { enfant: "e2", parent: "p2!" },
    ]);
  });

  it("refuse un $rowid qui ne désigne pas une instruction précédente, sans rien écrire", async () => {
    const pilote = piloteAvecTables();
    const erreur = await echec(
      pilote.batch([
        { sql: "INSERT INTO parents (nom) VALUES ('a')" },
        { sql: "INSERT INTO enfants (parent_id, nom) VALUES (?, 'e')", params: [{ $rowid: 1 }] },
      ]),
    );
    expect(String(erreur)).toContain("$rowid");
    expect(await pilote.read("SELECT COUNT(*) AS n FROM parents")).toEqual([{ n: 0 }]);
  });

  it("annule tout le lot à la première erreur SQL", async () => {
    const pilote = piloteAvecTables();
    const erreur = await echec(
      pilote.batch([
        { sql: "INSERT INTO parents (nom) VALUES ('a')" },
        { sql: "INSERT INTO enfants (parent_id, nom) VALUES (?, 'e')", params: [{ $rowid: 0 }] },
        // Clé étrangère activée : parent inexistant.
        { sql: "INSERT INTO enfants (parent_id, nom) VALUES (999, 'orphelin')" },
      ]),
    );
    expect(String(erreur)).toContain("FOREIGN KEY");
    expect(await pilote.read("SELECT COUNT(*) AS n FROM parents")).toEqual([{ n: 0 }]);
    expect(await pilote.read("SELECT COUNT(*) AS n FROM enfants")).toEqual([{ n: 0 }]);
  });

  it("annule tout le lot quand expectChanges n'est pas respecté", async () => {
    const pilote = piloteAvecTables();
    pilote.db.exec("INSERT INTO parents (nom) VALUES ('a')");
    const lot = (nom: string) => [
      { sql: "INSERT INTO parents (nom) VALUES ('b')" },
      { sql: "UPDATE parents SET nom = 'c' WHERE nom = ?", params: [nom], expectChanges: 1 },
    ];
    const erreur = await pilote.batch(lot("absent")).catch((e: unknown) => e);
    expect(erreur).toBeInstanceOf(ExpectChangesError);
    expect(erreur).toMatchObject({ index: 1, expected: 1, actual: 0 });
    expect(await pilote.read("SELECT nom FROM parents ORDER BY id")).toEqual([{ nom: "a" }]);

    // Respecté : le lot passe.
    expect((await pilote.batch(lot("a"))).map((r) => r.changes)).toEqual([1, 1]);
    expect(await pilote.read("SELECT nom FROM parents ORDER BY id")).toEqual([
      { nom: "c" },
      { nom: "b" },
    ]);
  });

  it("crée le dossier de la base, en WAL avec les clés étrangères", async () => {
    await avecBase(async (path) => {
      const fichier = join(path, "sous", "dossier", "journal.db");
      const pilote = ouvrirPiloteBun(fichier);
      expect(existsSync(fichier)).toBe(true);
      expect(await pilote.read("PRAGMA journal_mode")).toEqual([{ journal_mode: "wal" }]);
      expect(await pilote.read("PRAGMA foreign_keys")).toEqual([{ foreign_keys: 1 }]);
      pilote.close();
    });
  });
});
