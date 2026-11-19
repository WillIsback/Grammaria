import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { BadgeAnnonce, CatalogueBadges } from "../src/analysis/badges/vue.ts";
import { lancerServeur, type ServeurDeTest } from "./serveur.ts";

/**
 * Routes des badges, sur un vrai serveur lancé dans un processus à part avec
 * un journal temporaire. Le mode bureau est activé pour vérifier que les
 * badges sont soumis aux mêmes contrôles que les autres routes du journal.
 */
let serveur: ServeurDeTest;
let BASE: string;

beforeAll(async () => {
  serveur = await lancerServeur();
  BASE = serveur.base;
}, 20_000);

afterAll(() => serveur?.arreter());

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

  it("POST /api/rules/answer n'attribue aucun badge pour un choix inconnu", async () => {
    const reponse = await fetch(`${BASE}/api/rules/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ choiceId: 999_999, correct: true }),
    });
    // Choix inconnu : rien n'est enregistré, aucun badge n'est attribué.
    expect(reponse.status).toBe(404);
    expect(await reponse.json()).not.toHaveProperty("nouveauxBadges");
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
