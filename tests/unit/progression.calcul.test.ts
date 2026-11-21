import { describe, expect, it } from "vite-plus/test";
import {
  calculerProgression,
  debutSemaine,
  type LigneFaute,
  type LigneTexte,
  palier,
  type RegleSuivie,
  reglesFrequentes,
  scoreMaitrise,
  tendance,
  volume,
} from "../../src/analysis/progression/calcul";
import { PROGRESSION } from "../../src/analysis/progression/reglages";

/** Jeudi 19 novembre 2026, 15 h, heure locale : horloge injectée. */
const NOW = new Date(2026, 10, 19, 15).getTime();
/** Lundi 16 novembre 2026, 0 h : début de la semaine en cours. */
const LUNDI = new Date(2026, 10, 16).getTime();
/** Midi du jour `n` relatif au lundi courant (négatif : dans le passé). */
const jour = (n: number) => new Date(2026, 10, 16 + n, 12).getTime();

const texte = (at: number, words = 100, faults = 2): LigneTexte => ({ at, words, faults });

const faute = (
  at: number,
  ruleKey: string,
  label: string | null = `Libellé ${ruleKey}`,
): LigneFaute => ({
  at,
  ruleKey,
  label,
  categoryName: "Grammaire",
});

const regle = (ruleKey: string, state: RegleSuivie["state"], extra = {}): RegleSuivie => ({
  ruleKey,
  label: `Règle ${ruleKey}`,
  categoryName: "Grammaire",
  state,
  stateSince: jour(-10),
  occurrences: 3,
  lastFaultAt: jour(-10),
  acquiredAt: state === "acquise" ? jour(-1) : null,
  ...extra,
});

describe("progression — semaines", () => {
  it("une semaine commence le lundi à minuit, heure locale", () => {
    expect(debutSemaine(NOW)).toBe(LUNDI);
    expect(debutSemaine(LUNDI)).toBe(LUNDI);
    expect(debutSemaine(LUNDI - 1)).toBe(new Date(2026, 10, 9).getTime());
    // Dimanche soir : encore la semaine du lundi précédent.
    expect(debutSemaine(new Date(2026, 10, 22, 23, 59).getTime())).toBe(LUNDI);
  });

  it("produit 12 semaines consécutives, la dernière étant la semaine en cours", () => {
    const p = calculerProgression({ texts: [], faults: [], rules: [] }, NOW);
    expect(p.series).toHaveLength(PROGRESSION.semainesAffichees);
    expect(p.series.at(-1)?.start).toBe(LUNDI);
    expect(p.since).toBe(p.series[0].start);
    expect(p.since).toBe(new Date(2026, 7, 31).getTime());
    for (let i = 1; i < p.series.length; i++) {
      expect(p.series[i].start).toBe(p.series[i - 1].end);
    }
  });

  it("garde des semaines de lundi à lundi au passage à l'heure d'hiver", () => {
    // Le 25 octobre 2026 (heure d'hiver en Europe) tombe dans la série.
    const p = calculerProgression({ texts: [], faults: [], rules: [] }, NOW);
    for (const s of p.series) {
      const d = new Date(s.start);
      expect([d.getDay(), d.getHours(), d.getMinutes()]).toEqual([1, 0, 0]);
    }
  });

  it("répartit les textes par semaine et calcule note et fautes pour 100 mots", () => {
    const texts = [texte(jour(0), 100, 1), texte(jour(2), 300, 3), texte(jour(-7), 200, 10)];
    const p = calculerProgression({ texts, faults: [], rules: [] }, NOW);
    const courante = p.series.at(-1);
    expect(courante).toMatchObject({ texts: 2, words: 400, faults: 4, score: 18, faultsPer100: 1 });
    expect(p.series.at(-2)).toMatchObject({ texts: 1, score: 10, faultsPer100: 5 });
    expect(p.series[0]).toMatchObject({ texts: 0, words: 0, score: null, faultsPer100: null });
  });
});

describe("progression — volume et tendance", () => {
  it("additionne mots et fautes avant de calculer la note", () => {
    // 3 mots, 3 fautes + 300 mots, 0 faute : 1 faute pour 100 mots environ.
    expect(volume([texte(1, 3, 3), texte(2, 297, 0)])).toEqual({
      texts: 2,
      words: 300,
      faults: 3,
      score: 18,
      faultsPer100: 1,
    });
    expect(volume([])).toEqual({ texts: 0, words: 0, faults: 0, score: null, faultsPer100: null });
  });

  it("moins de fautes pour 100 mots est une baisse ; un petit écart reste stable", () => {
    const v = (faultsPer100: number | null) => ({ ...volume([]), faultsPer100 });
    expect(tendance(v(1), v(2))).toBe("baisse");
    expect(tendance(v(3), v(2))).toBe("hausse");
    expect(tendance(v(2.1), v(2))).toBe("stable");
    expect(tendance(v(null), v(2))).toBeNull();
    expect(tendance(v(1), v(null))).toBeNull();
  });

  it("compare les 4 dernières semaines aux 4 précédentes", () => {
    const texts = [
      texte(jour(-21), 100, 1), // récente (4e semaine en partant de la fin)
      texte(jour(-22), 100, 5), // précédente
      texte(jour(-49), 100, 5), // précédente (8e semaine)
      texte(jour(-56), 100, 9), // trop ancienne pour la tendance
    ];
    const p = calculerProgression({ texts, faults: [], rules: [] }, NOW);
    expect(p.recent).toMatchObject({ texts: 1, faultsPer100: 1 });
    expect(p.previous).toMatchObject({ texts: 2, faultsPer100: 5 });
    expect(p.trend).toBe("baisse");
    expect(p.totals.texts).toBe(4);
    expect(p.period.texts).toBe(4);
  });

  it("compte dans le total les textes antérieurs aux semaines affichées", () => {
    const p = calculerProgression(
      { texts: [texte(jour(-200)), texte(jour(0))], faults: [], rules: [] },
      NOW,
    );
    expect(p.totals).toMatchObject({ texts: 2, words: 200 });
    expect(p.period).toMatchObject({ texts: 1, words: 100 });
  });
});

describe("progression — score de maîtrise", () => {
  const recentes = (n: number, words: number, faults: number) =>
    volume(Array.from({ length: n }, (_, i) => texte(jour(-i), words, faults)));

  it("affiche « pas assez de textes » sous le minimum de textes ou de mots", () => {
    const peuDeTextes = scoreMaitrise(recentes(PROGRESSION.minimumTextesRecents - 1, 200, 0), []);
    expect(peuDeTextes.score).toBeNull();
    expect(peuDeTextes.level).toBeNull();
    expect(peuDeTextes.quality).toBe(100);

    const peuDeMots = scoreMaitrise(recentes(PROGRESSION.minimumTextesRecents, 10, 0), []);
    expect(peuDeMots.score).toBeNull();
    expect(peuDeMots.recent).toEqual({ texts: 5, words: 50 });
    expect(peuDeMots.minimum).toEqual({ texts: 5, words: 300 });
  });

  it("vaut la qualité seule tant qu'aucune règle n'est entrée dans le cycle", () => {
    // 1 faute pour 100 mots : note 18, qualité 90.
    const m = scoreMaitrise(recentes(5, 100, 1), [regle("A", "observee")]);
    expect(m).toMatchObject({ score: 90, quality: 90, rulesShare: null, inCycle: 0 });
    expect(m.level).toBe("Excellente maîtrise");
  });

  it("pondère qualité (60 %) et part des règles acquises (40 %)", () => {
    const rules = [
      regle("A", "acquise"),
      regle("B", "signalee"),
      regle("C", "travaillee"),
      regle("D", "acquise"),
      regle("E", "observee"), // faute isolée : hors du calcul
    ];
    // qualité 0,9 ; part 2/4 = 0,5 → 100 × (0,6 × 0,9 + 0,4 × 0,5) = 74.
    const m = scoreMaitrise(recentes(5, 100, 1), rules);
    expect(m).toMatchObject({ score: 74, quality: 90, rulesShare: 50, acquired: 2, inCycle: 4 });
    expect(m.level).toBe("Bonne maîtrise");
  });

  it("ne baisse pas quand on écrit plus avec la même proportion de fautes", () => {
    const rules = [regle("A", "acquise"), regle("B", "signalee")];
    const peu = scoreMaitrise(recentes(5, 100, 2), rules);
    const beaucoup = scoreMaitrise(recentes(40, 500, 10), rules);
    expect(beaucoup.score).toBe(peu.score);
  });

  it("reste entre 0 et 100", () => {
    expect(scoreMaitrise(recentes(5, 100, 50), [regle("A", "signalee")]).score).toBe(0);
    expect(scoreMaitrise(recentes(5, 100, 0), [regle("A", "acquise")]).score).toBe(100);
  });

  it("associe un palier en mots à chaque score", () => {
    expect(palier(100)).toBe("Excellente maîtrise");
    expect(palier(85)).toBe("Excellente maîtrise");
    expect(palier(84)).toBe("Bonne maîtrise");
    expect(palier(50)).toBe("En bonne voie");
    expect(palier(0)).toBe("Les bases à consolider");
  });
});

describe("progression — règles", () => {
  it("compte les règles par état et liste actives et acquises dans l'ordre", () => {
    const rules = [
      regle("A", "signalee", { lastFaultAt: jour(-3) }),
      regle("B", "travaillee", { lastFaultAt: jour(-1) }),
      regle("C", "acquise", { acquiredAt: jour(-20) }),
      regle("D", "acquise", { acquiredAt: jour(-2) }),
      regle("E", "observee"),
    ];
    const p = calculerProgression({ texts: [texte(NOW)], faults: [], rules }, NOW);
    expect(p.rules.counts).toEqual({ observee: 1, signalee: 1, travaillee: 1, acquise: 2 });
    expect(p.rules.active.map((r) => r.ruleKey)).toEqual(["B", "A"]);
    expect(p.rules.acquired.map((r) => r.ruleKey)).toEqual(["D", "C"]);
    expect(p.rules.active[0]).toMatchObject({ label: "Règle B", state: "travaillee" });
  });

  it("classe les règles les plus fréquentes, sans les fautes d'orthographe", () => {
    const faults = [
      faute(jour(0), "PAIRE:a/à"),
      faute(jour(-1), "PAIRE:a/à"),
      faute(jour(-2), "LT_RULE"),
      faute(jour(-3), "FR_SPELLING_RULE"),
      faute(jour(-4), "FR_SPELLING_RULE"),
      faute(jour(-5), "FR_SPELLING_RULE"),
      faute(jour(-6), "SANS_LIBELLE", null),
    ];
    const frequentes = reglesFrequentes(faults, [regle("PAIRE:a/à", "signalee")]);
    expect(frequentes).toEqual([
      {
        ruleKey: "PAIRE:a/à",
        label: "Règle PAIRE:a/à",
        categoryName: "Grammaire",
        count: 2,
        state: "signalee",
      },
      {
        ruleKey: "LT_RULE",
        label: "Libellé LT_RULE",
        categoryName: "Grammaire",
        count: 1,
        state: null,
      },
      // Sans libellé fixe connu (fautes d'avant la version 3) : la catégorie.
      {
        ruleKey: "SANS_LIBELLE",
        label: "Grammaire",
        categoryName: "Grammaire",
        count: 1,
        state: null,
      },
    ]);
  });

  it("ignore les fautes antérieures aux semaines affichées", () => {
    const faults = [faute(jour(-100), "VIEILLE"), faute(jour(-1), "X")];
    const p = calculerProgression({ texts: [texte(NOW)], faults, rules: [] }, NOW);
    expect(p.frequentRules.map((r) => r.ruleKey)).toEqual(["X"]);
  });
});

describe("progression — journal vide", () => {
  it("signale l'état vide sans chiffre trompeur", () => {
    const p = calculerProgression({ texts: [], faults: [], rules: [] }, NOW);
    expect(p.empty).toBe(true);
    expect(p.generatedAt).toBe(NOW);
    expect(p.mastery.score).toBeNull();
    expect(p.trend).toBeNull();
    expect(p.totals).toEqual({ texts: 0, words: 0, faults: 0, score: null, faultsPer100: null });
    expect(p.rules.counts).toEqual({ observee: 0, signalee: 0, travaillee: 0, acquise: 0 });
    expect(p.frequentRules).toEqual([]);
    // Aucun mot n'est exposé : les « mots pièges » n'existent plus (#32).
    expect(p).not.toHaveProperty("trapWords");
  });
});
