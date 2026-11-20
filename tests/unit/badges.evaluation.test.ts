import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  BADGES,
  FAMILLES_BADGES,
  MOTS_MIN_SANS_FAUTE,
  NOTE_MOYENNE,
} from "../../src/analysis/badges/catalogue";
import {
  type EtatBadge,
  evaluerBadges,
  type FaitEvenement,
  type FaitsBadges,
} from "../../src/analysis/badges/evaluation";
import { vueCatalogue } from "../../src/analysis/badges/vue";
import { debutSemaine, type LigneTexte } from "../../src/analysis/progression/calcul";

const DAY = 24 * 60 * 60 * 1000;
/** Lundi 5 octobre 2026, midi, heure locale. */
const J0 = new Date(2026, 9, 5, 12).getTime();
const jour = (n: number) => J0 + n * DAY;

const texte = (at: number, faults = 1, words = 50): LigneTexte => ({ at, faults, words });
const faits = (textes: LigneTexte[] = [], evenements: FaitEvenement[] = []): FaitsBadges => ({
  textes,
  evenements,
});
const etat = (etats: EtatBadge[], id: string) => {
  const e = etats.find((x) => x.id === id);
  if (!e) throw new Error(`badge inconnu : ${id}`);
  return e;
};
const evaluer = (f: FaitsBadges, now: number, id: string) => etat(evaluerBadges(f, now), id);

describe("Catalogue des badges", () => {
  it("compte une quinzaine de badges aux identifiants uniques et stables", () => {
    expect(BADGES.length).toBeGreaterThanOrEqual(15);
    expect(new Set(BADGES.map((b) => b.id)).size).toBe(BADGES.length);
    for (const b of BADGES) expect(b.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("répartit les badges dans les cinq familles, chacune non vide", () => {
    const familles = FAMILLES_BADGES.map((f) => f.id);
    expect(familles).toEqual([
      "premiers-pas",
      "regularite",
      "justesse",
      "maitrise",
      "perseverance",
    ]);
    for (const f of familles) expect(BADGES.some((b) => b.famille === f)).toBe(true);
  });

  it("décrit chaque badge en clair, sans série qui se casse", () => {
    for (const b of BADGES) {
      expect(b.titre.length).toBeGreaterThan(0);
      expect(b.critere).toMatch(/\.$/);
      expect(b.seuil).toBeGreaterThan(0);
      expect(`${b.titre} ${b.description} ${b.critere}`).not.toMatch(/d'affilée|série/i);
    }
  });

  it("figure entièrement dans la page « Badges » de la documentation", () => {
    const page = readFileSync(
      join(import.meta.dirname, "../../docs/src/content/docs/docs/utiliser/badges.mdx"),
      "utf-8",
    );
    for (const b of BADGES) {
      expect(page, `${b.id} absent de la documentation`).toContain(`\`${b.id}\``);
      expect(page, `${b.titre} absent de la documentation`).toContain(b.titre);
    }
  });
});

describe("Évaluation des badges — premiers pas", () => {
  it("rien n'est obtenu sur un journal vide", () => {
    for (const e of evaluerBadges(faits(), jour(0))) {
      expect(e.rempliLe).toBeNull();
      expect(e.valeur).toBe(0);
    }
  });

  it("date chaque palier du fait qui le franchit", () => {
    const textes = Array.from({ length: 50 }, (_, i) => texte(jour(0) + i * 1000));
    const etats = evaluerBadges(faits(textes), jour(1));
    expect(etat(etats, "premier-texte").rempliLe).toBe(jour(0));
    expect(etat(etats, "textes-10").rempliLe).toBe(jour(0) + 9000);
    expect(etat(etats, "textes-50").rempliLe).toBe(jour(0) + 49_000);
    expect(etat(etats, "textes-200")).toMatchObject({ rempliLe: null, valeur: 50, seuil: 200 });
  });

  it("ignore les faits postérieurs à l'horloge injectée", () => {
    const f = faits([texte(jour(5))]);
    expect(evaluer(f, jour(4), "premier-texte")).toMatchObject({ rempliLe: null, valeur: 0 });
    expect(evaluer(f, jour(5), "premier-texte").rempliLe).toBe(jour(5));
  });
});

describe("Évaluation des badges — régularité cumulative", () => {
  it("compte les jours distincts, même espacés", () => {
    // Plusieurs textes le même jour ne comptent qu'une fois ; les pauses ne cassent rien.
    const textes = [0, 0, 3, 10, 40, 41].map((n, i) => texte(jour(n) + i));
    const e = evaluer(faits(textes), jour(50), "jours-5");
    expect(e).toMatchObject({ valeur: 5, rempliLe: jour(41) + 5 });
  });

  it("compte les semaines distinctes, du lundi au dimanche", () => {
    expect(debutSemaine(jour(0))).toBe(debutSemaine(jour(6)));
    expect(debutSemaine(jour(6))).not.toBe(debutSemaine(jour(7)));
    // Lundi et dimanche de la même semaine, puis trois autres semaines, non consécutives.
    const textes = [0, 6, 14, 35, 70].map((n) => texte(jour(n)));
    expect(evaluer(faits(textes), jour(80), "semaines-4")).toMatchObject({
      valeur: 4,
      rempliLe: jour(70),
    });
    expect(evaluer(faits(textes), jour(80), "semaines-12")).toMatchObject({
      valeur: 4,
      rempliLe: null,
    });
  });
});

describe("Évaluation des badges — justesse", () => {
  it(`ne compte comme sans-faute que les textes d'au moins ${MOTS_MIN_SANS_FAUTE} mots`, () => {
    const textes = [
      texte(jour(0), 0, MOTS_MIN_SANS_FAUTE - 1),
      texte(jour(1), 1, 100),
      texte(jour(2), 0, MOTS_MIN_SANS_FAUTE),
    ];
    expect(evaluer(faits(textes), jour(3), "premier-sans-faute")).toMatchObject({
      valeur: 1,
      rempliLe: jour(2),
    });
  });

  it("obtient « Dix sans-faute » au dixième", () => {
    const textes = Array.from({ length: 10 }, (_, i) => texte(jour(i), 0, 40));
    expect(evaluer(faits(textes), jour(10), "sans-faute-10").rempliLe).toBe(jour(9));
  });

  it("exige un minimum de textes dans la fenêtre pour la note moyenne", () => {
    const textes = Array.from({ length: NOTE_MOYENNE.textesMin - 1 }, (_, i) => texte(jour(i), 0));
    const e = evaluer(faits(textes), jour(10), "note-18");
    expect(e).toMatchObject({ rempliLe: null, valeur: 20, seuil: 18, ratio: 0.9 });
    expect(e.detail).toContain("(10 au minimum)");
  });

  it("obtient la note moyenne sur une fenêtre glissante, à la première fenêtre qui convient", () => {
    // 100 mots, 1 faute : 18/20 par texte. Les textes faibles du début sortent de la fenêtre.
    const faibles = [0, 1].map((n) => texte(jour(n), 10, 100));
    const bons = Array.from({ length: 10 }, (_, i) => texte(jour(22 + i), 1, 100));
    const e = evaluer(faits([...faibles, ...bons]), jour(40), "note-18");
    // Au 9ᵉ bon texte (jour 30), le texte faible du jour 1 est encore dans la fenêtre.
    expect(e.rempliLe).toBe(jour(31));
    expect(e.valeur).toBe(18);
  });

  it("ne retient pas une note moyenne trop basse", () => {
    const textes = Array.from({ length: 12 }, (_, i) => texte(jour(i), 2, 100)); // 16/20
    expect(evaluer(faits(textes), jour(12), "note-18")).toMatchObject({
      rempliLe: null,
      valeur: 16,
    });
  });
});

const ev = (ruleKey: string, n: number, type: FaitEvenement["type"]): FaitEvenement => ({
  ruleKey,
  at: jour(n),
  type,
});

describe("Évaluation des badges — maîtrise", () => {
  it("compte les règles distinctes acquises, une seule fois chacune", () => {
    const evenements = [
      ev("PAIRE:on/ont", 1, "acquise"),
      ev("PAIRE:on/ont", 2, "rechute"),
      ev("PAIRE:on/ont", 3, "acquise"),
      ev("ACCORD_SUJET_VERBE", 4, "acquise"),
      ev("PAIRE:a/à", 5, "acquise"),
    ];
    const etats = evaluerBadges(faits([], evenements), jour(6));
    expect(etat(etats, "premiere-regle").rempliLe).toBe(jour(1));
    expect(etat(etats, "regles-3")).toMatchObject({ valeur: 3, rempliLe: jour(5) });
    expect(etat(etats, "regles-5")).toMatchObject({ valeur: 3, rempliLe: null });
    expect(etat(etats, "regles-10").rempliLe).toBeNull();
  });

  it("ne compte pour les homophones que les fiches `PAIRE:`", () => {
    const evenements = [
      ev("PAIRE:on/ont", 1, "acquise"),
      ev("TERMINAISON:er/é", 2, "acquise"),
      ev("PAIRE:a/à", 3, "acquise"),
      ev("PAIRE:inconnue", 4, "acquise"),
      ev("PAIRE:et/est", 5, "acquise"),
    ];
    expect(evaluer(faits([], evenements), jour(6), "homophones-3")).toMatchObject({
      valeur: 3,
      rempliLe: jour(5),
    });
  });
});

describe("Évaluation des badges — persévérance", () => {
  it("ne compte une rechute surmontée qu'après une nouvelle acquisition", () => {
    const enRechute = [ev("PAIRE:on/ont", 1, "acquise"), ev("PAIRE:on/ont", 2, "rechute")];
    expect(evaluer(faits([], enRechute), jour(3), "rechute-surmontee").rempliLe).toBeNull();
    const surmontee = [
      ...enRechute,
      ev("PAIRE:a/à", 3, "acquise"),
      ev("PAIRE:on/ont", 4, "acquise"),
    ];
    expect(evaluer(faits([], surmontee), jour(5), "rechute-surmontee")).toMatchObject({
      valeur: 1,
      rempliLe: jour(4),
    });
  });

  it("compte les bonnes réponses au choix à deux formes", () => {
    const reponses = Array.from({ length: 10 }, (_, i) => ev("PAIRE:on/ont", i, "reponse_juste"));
    expect(evaluer(faits([], reponses.slice(0, 9)), jour(20), "choix-10")).toMatchObject({
      valeur: 9,
      rempliLe: null,
    });
    expect(evaluer(faits([], reponses), jour(20), "choix-10").rempliLe).toBe(jour(9));
  });
});

describe("Vue du catalogue", () => {
  it("prend la date d'obtention dans le journal, jamais dans le recalcul", () => {
    const etats = evaluerBadges(faits(), jour(0));
    const vue = vueCatalogue(etats, new Map([["textes-10", jour(-3)]]));
    expect(vue.total).toBe(BADGES.length);
    expect(vue.obtenus).toBe(1);
    // Obtenu malgré un journal vide : un recalcul ne retire jamais un badge.
    expect(vue.badges.find((b) => b.id === "textes-10")).toMatchObject({
      obtenu: true,
      obtenuLe: jour(-3),
      progression: { valeur: 0, seuil: 10 },
    });
  });

  it("garde la forme de GET /api/badges, unité comprise", () => {
    const vue = vueCatalogue(evaluerBadges(faits(), jour(0)), new Map());
    expect(Object.keys(vue.badges[0])).toEqual([
      "id",
      "famille",
      "titre",
      "description",
      "critere",
      "mesure",
      "unite",
      "obtenu",
      "obtenuLe",
      "progression",
    ]);
    const unite = (id: string) => vue.badges.find((b) => b.id === id)?.unite;
    expect(unite("premier-sans-faute")).toEqual({ singulier: "texte", pluriel: "textes" });
    expect(unite("note-18")).toEqual({ singulier: "sur 20", pluriel: "sur 20" });
    expect(unite("choix-10")).toEqual({ singulier: "bonne réponse", pluriel: "bonnes réponses" });
  });

  it("ignore un badge enregistré qui n'existe plus au catalogue", () => {
    const vue = vueCatalogue(evaluerBadges(faits(), jour(0)), new Map([["ancien-badge", 1]]));
    expect(vue.obtenus).toBe(0);
  });
});

describe("Évaluation d'une partie du catalogue", () => {
  it("donne pour chaque badge le même état que le catalogue entier", () => {
    // Faits variés : textes sur plusieurs semaines, acquisitions, rechute, bonnes réponses.
    const textes = Array.from({ length: 60 }, (_, i) =>
      texte(jour(Math.floor(i * 1.7)), i % 4 === 0 ? 0 : 1, i % 3 === 0 ? 40 : 12),
    );
    const evenements: FaitEvenement[] = [
      { ruleKey: "PAIRE:on/ont", at: jour(20), type: "acquise" },
      { ruleKey: "PAIRE:on/ont", at: jour(30), type: "rechute" },
      { ruleKey: "PAIRE:a/à", at: jour(35), type: "acquise" },
      { ruleKey: "PAIRE:on/ont", at: jour(50), type: "acquise" },
      ...Array.from({ length: 12 }, (_, i): FaitEvenement => ({
        ruleKey: "PAIRE:et/est",
        at: jour(i * 3),
        type: "reponse_juste",
      })),
    ];
    const f = faits(textes, evenements);
    for (const now of [jour(10), jour(60), jour(200)]) {
      const complet = evaluerBadges(f, now);
      for (const [i, def] of BADGES.entries()) {
        expect(evaluerBadges(f, now, [def])).toEqual([complet[i]]);
      }
      const impairs = BADGES.filter((_, i) => i % 2 === 1);
      expect(evaluerBadges(f, now, impairs)).toEqual(complet.filter((_, i) => i % 2 === 1));
    }
  });
});
