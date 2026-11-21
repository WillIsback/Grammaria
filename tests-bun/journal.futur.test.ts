import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal, JournalFuturError, SCHEMA_VERSION } from "../journal.ts";
import { ouvrirPiloteBun } from "../journal.driver.bun.ts";
import type { JournalDriver } from "../journal.driver.ts";

/** Base écrite par une version future : schéma inconnu, `user_version` plus haute. */
function baseFuture(dir: string, version = SCHEMA_VERSION + 1): string {
  const path = join(dir, "grammaria.db");
  const db = new Database(path);
  db.exec("CREATE TABLE nouveautes (id INTEGER PRIMARY KEY, x TEXT)");
  db.exec(`PRAGMA user_version = ${version}`);
  db.close();
  return path;
}

function tables(path: string): string[] {
  const db = new Database(path, { readonly: true });
  const noms = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((ligne) => (ligne as { name: string }).name);
  db.close();
  return noms;
}

describe("Journal d'une version future de Grammaria", () => {
  it("refuse de l'ouvrir, avec un message clair, sans rien y écrire", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grammaria-futur-"));
    try {
      const path = baseFuture(dir);
      const erreur: unknown = await Journal.ouvrir(ouvrirPiloteBun(path)).then(
        () => null,
        (e: unknown) => e,
      );
      expect(erreur).toBeInstanceOf(JournalFuturError);
      expect((erreur as Error).message).toContain(
        "Ce journal a été créé par une version plus récente de Grammaria",
      );
      // Ni les tables du journal, ni la nouvelle version : la base est intacte.
      expect(tables(path)).toEqual(["nouveautes"]);
      const db = new Database(path, { readonly: true });
      expect(db.query("PRAGMA user_version").get()).toEqual({
        user_version: SCHEMA_VERSION + 1,
      });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lit la version avant toute écriture", async () => {
    const pilote = ouvrirPiloteBun(":memory:");
    const ordre: string[] = [];
    const espion: JournalDriver = {
      read: (sql, params) => (ordre.push(`read ${sql}`), pilote.read(sql, params)),
      readMany: (queries) => (ordre.push("readMany"), pilote.readMany(queries)),
      batch: (statements) => (ordre.push("batch"), pilote.batch(statements)),
      compacter: () => (ordre.push("compacter"), pilote.compacter()),
    };
    await Journal.ouvrir(espion);
    expect(ordre[0]).toBe("read PRAGMA user_version");
  });

  it("ouvre normalement un journal de la version courante", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grammaria-futur-"));
    try {
      const path = join(dir, "grammaria.db");
      const premier = await Journal.ouvrir(ouvrirPiloteBun(path));
      await premier.close();
      const second = await Journal.ouvrir(ouvrirPiloteBun(path));
      expect(await second.period(7)).toMatchObject({ texts: 0 });
      await second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("le serveur web refuse de démarrer sur un tel journal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grammaria-futur-"));
    try {
      const path = baseFuture(dir);
      const processus = Bun.spawn(["bun", "run", "server.ts"], {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...process.env,
          PORT: String(30_000 + Math.floor(Math.random() * 2000)),
          HOST: "127.0.0.1",
          JOURNAL_PATH: path,
          GRAMMARIA_DIST_DIR: dir,
          OTEL_EXPORTER_OTLP_ENDPOINT: "",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const code = await processus.exited;
      const sortie = await new Response(processus.stderr).text();
      expect(code).not.toBe(0);
      expect(sortie).toContain("Ce journal a été créé par une version plus récente de Grammaria");
      // Arrêt propre : code 1, la cause sur une ligne, pas de pile d'appels.
      expect(code).toBe(1);
      expect(sortie).toContain(`[Journal] Impossible d'ouvrir ${path} : `);
      expect(sortie).not.toMatch(/^\s+at /m);
      expect(sortie).not.toContain("JournalFuturError");
      expect(tables(path)).toEqual(["nouveautes"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
