import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BunJournalDriver, ouvrirPiloteBun } from "../journal.driver.bun.ts";
import {
  estConflit,
  ExpectChangesError,
  PRAGMAS_A_ARGUMENT,
  PRAGMAS_LISIBLES,
  USER_VERSION_MAX,
} from "../journal.driver.ts";
import { SCHEMA_VERSION } from "../journal.ts";
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

describe("Pilote bun:sqlite — mêmes refus que le pilote Rust du bureau", () => {
  /** Message d'erreur d'un lot d'une seule instruction refusé ; null s'il passe. */
  const refus = async (
    pilote: BunJournalDriver,
    sql: string,
    params?: (string | number | null)[],
  ) => ((await echec(pilote.batch([{ sql, params }]))) as Error | null)?.message ?? null;

  it("une seule instruction SQL par entrée, en lecture comme en écriture", async () => {
    const pilote = piloteAvecTables();
    expect(await refus(pilote, "DELETE FROM parents; DELETE FROM enfants")).toStartWith(
      "Instruction 0 : ",
    );
    expect(String(await echec(pilote.read("SELECT 1; DELETE FROM parents")))).toContain(
      "une seule instruction",
    );
    // Un `;` final, ou dans une chaîne ou un commentaire, reste une seule instruction.
    expect(await refus(pilote, "INSERT INTO parents (nom) VALUES ('a;b');")).toBeNull();
    expect(
      await refus(pilote, "INSERT INTO parents (nom) VALUES ('c') -- ; DROP TABLE x"),
    ).toBeNull();
    expect(await pilote.read("SELECT nom FROM parents WHERE nom = 'a;b';")).toEqual([
      { nom: "a;b" },
    ]);
  });

  it("refuse BEGIN, COMMIT, ROLLBACK, SAVEPOINT, RELEASE dans un lot : le lot est la transaction", async () => {
    const pilote = piloteAvecTables();
    for (const sql of [
      "BEGIN",
      "BEGIN IMMEDIATE",
      "COMMIT",
      "END",
      "ROLLBACK",
      "SAVEPOINT s",
      "RELEASE s",
      "  begin transaction",
    ]) {
      const erreur = await echec(
        pilote.batch([{ sql: "INSERT INTO parents (nom) VALUES ('x')" }, { sql }]),
      );
      expect(String(erreur)).toContain("Instruction 1 : ");
    }
    expect(await pilote.read("SELECT COUNT(*) AS n FROM parents")).toEqual([{ n: 0 }]);
  });

  it("n'écrit que le pragma user_version ; refuse ATTACH, VACUUM, tables virtuelles, sqlite_master", async () => {
    const pilote = piloteAvecTables();
    expect(await refus(pilote, `PRAGMA user_version = ${USER_VERSION_MAX}`)).toBeNull();
    expect(await pilote.read("PRAGMA user_version")).toEqual([{ user_version: USER_VERSION_MAX }]);
    for (const sql of [
      "PRAGMA foreign_keys = OFF",
      "PRAGMA journal_mode = DELETE",
      "ATTACH DATABASE ':memory:' AS autre",
      "VACUUM",
      "CREATE VIRTUAL TABLE v USING fts5(x)",
      "UPDATE sqlite_master SET sql = ''",
    ]) {
      expect(await refus(pilote, sql)).toStartWith("Instruction 0 : ");
    }
    expect(await pilote.read("PRAGMA foreign_keys")).toEqual([{ foreign_keys: 1 }]);
    // sqlite_master reste lisible ; un pragma hors de la liste ne l'est pas.
    expect((await pilote.read("SELECT name FROM sqlite_master WHERE type = 'table'")).length).toBe(
      2,
    );
    expect(String(await echec(pilote.read("PRAGMA cache_size")))).toContain("Instruction 0 : ");
  });

  it("préfixe les erreurs : « Conflit : » pour expectChanges, « Instruction i : » sinon", async () => {
    const pilote = piloteAvecTables();
    const conflit = await echec(
      pilote.batch([
        { sql: "INSERT INTO parents (nom) VALUES ('a')" },
        { sql: "DELETE FROM parents WHERE nom = 'absent'", expectChanges: 1 },
      ]),
    );
    expect(String((conflit as Error).message)).toStartWith("Conflit : ");
    expect(estConflit(conflit)).toBe(true);
    // Le pilote Rust renvoie une chaîne à travers invoke : même classement.
    expect(estConflit("Conflit : l'instruction 1 du lot")).toBe(true);
    const autre = await echec(
      pilote.batch([
        { sql: "INSERT INTO parents (nom) VALUES ('a')" },
        { sql: "INSERT INTO parents (nom) VALUES ('a')" },
      ]),
    );
    expect((autre as Error).message).toStartWith("Instruction 1 : ");
    expect(estConflit(autre)).toBe(false);
    expect(
      String(await echec(pilote.readMany([{ sql: "SELECT 1" }, { sql: "SELECT * FROM absente" }]))),
    ).toContain("Instruction 1 : ");
  });

  it("ne lit que des pragmas que le pilote Rust lit aussi (listes de db.rs)", async () => {
    const dbRs = readFileSync(join(import.meta.dir, "../src-tauri/src/db.rs"), "utf-8");
    const listeRust = (nom: string): string[] => {
      const bloc = dbRs.match(new RegExp(`const ${nom}: &\\[&str\\] = &\\[([^\\]]*)\\];`));
      if (!bloc) throw new Error(`${nom} introuvable dans db.rs`);
      return [...bloc[1].matchAll(/"(\w+)"/g)].map((m) => m[1]);
    };
    const lectureRust = listeRust("PRAGMAS_LECTURE");
    const argumentRust = listeRust("PRAGMAS_A_ARGUMENT");
    expect(lectureRust).toContain("user_version");
    // Tout ce que le pilote Bun accepte, le pilote Rust l'accepte aussi.
    expect(PRAGMAS_LISIBLES.filter((p) => !lectureRust.includes(p))).toEqual([]);
    expect(PRAGMAS_A_ARGUMENT.filter((p) => !argumentRust.includes(p))).toEqual([]);
    expect(PRAGMAS_LISIBLES).toContain("user_version");

    const pilote = piloteAvecTables();
    expect(await pilote.read("PRAGMA table_info(parents)")).toHaveLength(2);
    for (const sql of [
      "PRAGMA table_list",
      "PRAGMA journal_mode(DELETE)",
      "PRAGMA user_version(1)",
    ]) {
      expect(String(await echec(pilote.read(sql)))).toContain("seules les requêtes de lecture");
    }
    expect(await pilote.read("PRAGMA journal_mode")).toEqual([{ journal_mode: "memory" }]);
    expect(await pilote.read("PRAGMA user_version")).toEqual([{ user_version: 0 }]);
  });

  it("borne PRAGMA user_version aux versions connues, comme le pilote Rust", async () => {
    // Même plage des deux côtés : un test Rust compare USER_VERSION_MAX de db.rs à SCHEMA_VERSION.
    expect(USER_VERSION_MAX).toBe(SCHEMA_VERSION);
    const pilote = piloteAvecTables();
    for (let version = 0; version <= USER_VERSION_MAX; version++) {
      expect(await refus(pilote, `PRAGMA user_version = ${version}`)).toBeNull();
    }
    for (const sql of [
      `PRAGMA user_version = ${USER_VERSION_MAX + 1}`,
      "PRAGMA user_version = 99",
      "PRAGMA user_version = -1",
    ]) {
      expect(await refus(pilote, sql)).toStartWith("Instruction 0 : ");
    }
    expect(await pilote.read("PRAGMA user_version")).toEqual([{ user_version: USER_VERSION_MAX }]);
  });

  it("refuse déclencheurs, vues, DROP et ALTER dans un lot, comme le pilote Rust", async () => {
    const pilote = piloteAvecTables();
    for (const sql of [
      "CREATE TRIGGER t AFTER INSERT ON parents BEGIN DELETE FROM enfants; END",
      "CREATE TEMP TRIGGER t AFTER INSERT ON parents BEGIN DELETE FROM enfants; END",
      "CREATE TRIGGER IF NOT EXISTS t AFTER INSERT ON parents BEGIN SELECT 1; END",
      "CREATE VIEW v AS SELECT nom FROM parents",
      "CREATE TEMPORARY VIEW v AS SELECT nom FROM parents",
      "DROP TABLE enfants",
      "DROP TABLE IF EXISTS parents",
      "DROP INDEX IF EXISTS idx",
      "DROP TRIGGER t",
      "DROP VIEW v",
      "ALTER TABLE parents ADD COLUMN age INTEGER",
      "ALTER TABLE parents RENAME TO anciens",
      "/* migration */ drop table parents",
    ]) {
      expect(await refus(pilote, sql)).toStartWith("Instruction 0 : ");
    }
    // Rien n'a changé ; les créations du journal restent permises.
    expect(
      await pilote.read("SELECT name FROM sqlite_master WHERE type <> 'index' ORDER BY name"),
    ).toEqual([{ name: "enfants" }, { name: "parents" }]);
    expect(await refus(pilote, "CREATE TABLE IF NOT EXISTS autres (id INTEGER)")).toBeNull();
    expect(await refus(pilote, "CREATE INDEX IF NOT EXISTS idx_autres ON autres (id)")).toBeNull();
    // Le mot DROP dans une valeur n'est pas une instruction.
    expect(await refus(pilote, "INSERT INTO parents (nom) VALUES ('DROP TABLE x')")).toBeNull();
  });

  it("accepte null, entiers, réels, texte et booléens (0/1) ; refuse les BLOB", async () => {
    const pilote = piloteAvecTables();
    pilote.db.exec("CREATE TABLE valeurs (v)");
    const valeurs = [null, 3, 2.5, "texte", true, false];
    await pilote.batch(
      valeurs.map((v) => ({ sql: "INSERT INTO valeurs (v) VALUES (?)", params: [v as never] })),
    );
    expect((await pilote.read<{ v: unknown }>("SELECT v FROM valeurs")).map((r) => r.v)).toEqual([
      null,
      3,
      2.5,
      "texte",
      1,
      0,
    ]);
    expect(
      await refus(pilote, "INSERT INTO valeurs (v) VALUES (?)", [new Uint8Array([1]) as never]),
    ).toStartWith("Instruction 0 : ");
  });

  it("compte 0 ligne modifiée pour une instruction de schéma", async () => {
    const pilote = piloteAvecTables();
    const resultats = await pilote.batch([
      { sql: "INSERT INTO parents (nom) VALUES ('a')" },
      { sql: "CREATE TABLE IF NOT EXISTS autre (x)" },
      { sql: "CREATE INDEX IF NOT EXISTS idx_autre ON autre(x)" },
      { sql: "PRAGMA user_version = 1" },
    ]);
    expect(resultats.map((r) => r.changes)).toEqual([1, 0, 0, 0]);
  });
});
