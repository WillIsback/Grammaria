import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BadgeAnnonce, CatalogueBadges } from "../src/analysis/badges/vue.ts";

/**
 * Routes des badges, sur un vrai serveur lancé dans un processus à part avec
 * un journal temporaire. Le mode bureau est activé pour vérifier que les
 * badges sont soumis aux mêmes contrôles que les autres routes du journal.
 */
const PORT = 25_000 + Math.floor(Math.random() * 2000) + 3000;
const BASE = `http://127.0.0.1:${PORT}`;
let dir: string;
let server: ReturnType<typeof Bun.spawn>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "grammaria-routes-"));
  server = Bun.spawn(["bun", "run", "server.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      GRAMMARIA_DESKTOP: "1",
      JOURNAL_PATH: join(dir, "journal.db"),
      GRAMMARIA_SETTINGS_PATH: join(dir, "settings.json"),
      GRAMMARIA_DIST_DIR: dir,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${BASE}/api/badges`);
      return;
    } catch {
      await Bun.sleep(100);
    }
  }
  throw new Error("Le serveur n'a pas démarré");
});

afterAll(() => {
  server.kill();
  rmSync(dir, { recursive: true, force: true });
});

const analyser = async (original: string, corrected: string) =>
  (await (
    await fetch(`${BASE}/api/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ original, corrected, matches: [] }),
    })
  ).json()) as { nouveauxBadges: BadgeAnnonce[]; score: number };

const catalogue = async () => (await (await fetch(`${BASE}/api/badges`)).json()) as CatalogueBadges;

describe("Routes des badges", () => {
  it("annonce les badges obtenus dans la réponse de /api/analyze", async () => {
    const premier = await analyser("Ils on vu le film.", "Ils ont vu le film.");
    expect(premier.score).toBe(0);
    expect(premier.nouveauxBadges).toEqual([
      {
        id: "premier-texte",
        titre: "Premier texte",
        description: "Votre premier texte est corrigé : le journal de progression commence.",
      },
    ]);
    expect((await analyser("Tout va bien.", "Tout va bien.")).nouveauxBadges).toEqual([]);
  });

  it("GET /api/badges renvoie le catalogue complet", async () => {
    const reponse = await catalogue();
    expect(reponse.obtenus).toBe(1);
    expect(reponse.familles.map((f) => f.id)).toEqual([
      "premiers-pas",
      "regularite",
      "justesse",
      "maitrise",
      "perseverance",
    ]);
    expect(reponse.badges.find((b) => b.id === "textes-10")).toMatchObject({
      obtenu: false,
      obtenuLe: null,
      progression: { valeur: 2, seuil: 10 },
    });
    expect(reponse.badges.find((b) => b.id === "premier-texte")?.obtenuLe).toBeNumber();
  });

  it("POST /api/rules/answer porte aussi les badges obtenus", async () => {
    const reponse = await fetch(`${BASE}/api/rules/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ruleKey: "PAIRE:on/ont", correct: true }),
    });
    // Aucun choix n'attend de réponse : rien n'est enregistré, aucun badge.
    expect(await reponse.json()).toEqual({ recorded: false, nouveauxBadges: [] });
  });

  it("applique les contrôles du mode bureau et refuse les autres méthodes", async () => {
    const etranger = await fetch(`${BASE}/api/badges`, { headers: { Host: "evil.example" } });
    expect(etranger.status).toBe(403);
    const post = await fetch(`${BASE}/api/badges`, { method: "POST" });
    expect(post.status).toBe(405);
  });

  it("DELETE /api/journal efface aussi les badges", async () => {
    const purge = await fetch(`${BASE}/api/journal`, { method: "DELETE" });
    expect(await purge.json()).toEqual({ purged: true });
    const apres = await catalogue();
    expect(apres.obtenus).toBe(0);
    expect(apres.badges.every((b) => !b.obtenu && b.obtenuLe === null)).toBe(true);
  });
});
