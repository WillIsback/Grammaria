import { describe, expect, it } from "vite-plus/test";
import {
  construireExport,
  estIdentifiantRegle,
  type ExportBeta,
  LIMITES_EXPORT,
  nomFichierExport,
  nouveauParticipant,
  SEMAINE_MS,
  texteExport,
  validerExport,
  validerTexteExport,
} from "../../src/analysis/progression/export";
import type { EntreeMesure } from "../../src/analysis/progression/mesure";
import { MESURE } from "../../src/analysis/progression/reglages";
import { SEUILS } from "../../src/analysis/regles/seuils";

const JOUR = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 5, 9, 41);
const jour = (n: number) => T0 + n * JOUR;
const PARTICIPANT = "0123456789abcdef0123456789abcdef";

function journal(): EntreeMesure {
  const f = (n: number, ruleKey: string, categoryId = "CONFUSION") => ({
    at: jour(n),
    ruleKey,
    categoryId,
  });
  return {
    texts: Array.from({ length: 30 }, (_, i) => ({ at: jour(i), words: 150 })),
    faults: [
      ...[0, 2, 4, 15, 25].map((n) => f(n, "PAIRE:a/à")),
      ...[1, 3, 5].map((n) => f(n, "ACCORD_SUJET_VERBE", "GRAMMAR")),
      ...[0, 1, 2, 10, 20].map((n) => f(n, "FR_SPELLING_RULE", "TYPOS")),
      // Règle d'identifiant non autorisé (interface modifiée) : jamais exportée.
      ...[1, 2, 3].map((n) => f(n, "regle avec du texte", "GRAMMAR")),
    ],
    events: [
      { at: jour(4), ruleKey: "PAIRE:a/à", type: "astuce" },
      { at: jour(5), ruleKey: "ACCORD_SUJET_VERBE", type: "astuce" },
      { at: jour(22), ruleKey: "ACCORD_SUJET_VERBE", type: "acquise" },
      { at: jour(3), ruleKey: "regle avec du texte", type: "astuce" },
    ],
    states: [
      { ruleKey: "PAIRE:a/à", state: "signalee", label: "a / à" },
      { ruleKey: "ACCORD_SUJET_VERBE", state: "acquise", label: "Accord du verbe" },
      { ruleKey: "regle avec du texte", state: "signalee" },
    ],
  };
}

const exemple = (): ExportBeta =>
  construireExport({
    application: "0.5.0",
    plateforme: "bureau",
    participant: PARTICIPANT,
    journal: journal(),
    now: jour(31),
  });

/** Toutes les chaînes d'une valeur JSON, clés comprises. */
function chaines(valeur: unknown): string[] {
  if (typeof valeur === "string") return [valeur];
  if (Array.isArray(valeur)) return valeur.flatMap(chaines);
  if (valeur && typeof valeur === "object") {
    return Object.entries(valeur).flatMap(([k, v]) => [k, ...chaines(v)]);
  }
  return [];
}

describe("construireExport", () => {
  it("semaines relatives, règles suivies et comparaison, synthèse et seuils", () => {
    const exp = exemple();
    expect(validerExport(exp)).toEqual({ ok: true, export: exp });
    expect(exp).toMatchObject({
      format: "grammaria-beta",
      version: 1,
      application: "0.5.0",
      plateforme: "bureau",
      participant: PARTICIPANT,
      seuils: { cycle: { ...SEUILS }, mesure: { ...MESURE } },
    });
    // 31 jours après le premier texte : semaines 0 à 4.
    expect(exp.semaines.map((s) => s.semaine)).toEqual([0, 1, 2, 3, 4]);
    expect(exp.semaines[0]).toEqual({ semaine: 0, textes: 7, mots: 1050, fautes: 12 });
    expect(exp.semaines.reduce((n, s) => n + s.textes, 0)).toBe(30);

    expect(exp.regles.map((r) => [r.regle, r.groupe, r.etat])).toEqual([
      ["PAIRE:a/à", "suivie", "signalee"],
      ["ACCORD_SUJET_VERBE", "suivie", "acquise"],
      ["FR_SPELLING_RULE", "comparaison", null],
    ]);
    expect(exp.regles[0]).toEqual({
      regle: "PAIRE:a/à",
      categorie: "CONFUSION",
      groupe: "suivie",
      etat: "signalee",
      semainePivot: 0,
      avant: { textes: 5, mots: 750, fautes: 3 },
      depuis: { textes: 25, mots: 3750, fautes: 2 },
      suffisant: true,
      astuces: 1,
      choix: 0,
      reponsesJustes: 0,
      reponsesFausses: 0,
      rechutes: 0,
      semaineAcquisition: null,
    });
    expect(exp.regles[1].semaineAcquisition).toBe(3);
    expect(exp.synthese.acquises).toEqual({ total: 1, restees: 1, rechutes: 0 });
  });

  it("ni libellé, ni date, ni texte : seulement des chaînes de forme contrôlée", () => {
    const exp = exemple();
    const texte = texteExport(exp);
    expect(texte).not.toContain("a / à");
    expect(texte).not.toContain("Accord du verbe");
    expect(texte).not.toContain("regle avec du texte");
    expect(texte).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(texte).not.toContain(String(T0).slice(0, 6));
    const valeurs = chaines(exp).filter((s) => !/^[a-zA-Z]+$/.test(s));
    for (const s of valeurs) {
      expect(
        /^[A-Z0-9_]+$/.test(s) ||
          estIdentifiantRegle(s) ||
          s === PARTICIPANT ||
          s === "grammaria-beta" ||
          s === "0.5.0",
      ).toBe(true);
    }
  });

  it("journal vide : un export valide, sans semaine ni règle", () => {
    const exp = construireExport({
      application: "0.5.0",
      plateforme: "serveur",
      participant: PARTICIPANT,
      journal: { texts: [], faults: [], events: [], states: [] },
      now: T0,
    });
    expect(exp.semaines).toEqual([]);
    expect(exp.regles).toEqual([]);
    expect(validerExport(exp).ok).toBe(true);
  });

  it("les semaines sont des blocs de 7 × 24 h depuis le premier texte", () => {
    const exp = construireExport({
      application: "0.5.0",
      plateforme: "serveur",
      participant: PARTICIPANT,
      journal: {
        texts: [
          { at: T0, words: 10 },
          { at: T0 + SEMAINE_MS - 1, words: 20 },
          { at: T0 + SEMAINE_MS, words: 30 },
        ],
        faults: [],
        events: [],
        states: [],
      },
      now: T0 + SEMAINE_MS,
    });
    expect(exp.semaines).toEqual([
      { semaine: 0, textes: 2, mots: 30, fautes: 0 },
      { semaine: 1, textes: 1, mots: 30, fautes: 0 },
    ]);
  });

  it("identifiant de participant, nom de fichier et identifiants de règle", () => {
    const a = nouveauParticipant();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(nouveauParticipant()).not.toBe(a);
    expect(nomFichierExport(PARTICIPANT)).toBe("grammaria-beta-01234567.json");
    expect(estIdentifiantRegle("ACCORD_SUJET_VERBE")).toBe(true);
    expect(estIdentifiantRegle("PAIRE:c'est/s'est")).toBe(true);
    expect(estIdentifiantRegle("TERMINAISON:er/é")).toBe(true);
    expect(estIdentifiantRegle("PAIRE:bonjour/monde")).toBe(false);
    expect(estIdentifiantRegle("FR_SIMPLE_REPLACE_SIMPLE_jai")).toBe(false);
    expect(estIdentifiantRegle("toString")).toBe(false);
    expect(estIdentifiantRegle("__proto__")).toBe(false);
  });
});

describe("validerExport : refuse tout ce qui sort du format", () => {
  const altere = (modifier: (exp: Record<string, any>) => void) => {
    const exp = structuredClone(exemple()) as Record<string, any>;
    modifier(exp);
    return validerExport(exp);
  };

  it.each<[string, (exp: Record<string, any>) => void]>([
    ["champ libre ajouté", (e) => (e.commentaire = "Bonjour, voici mon texte")],
    ["champ ajouté dans une règle", (e) => (e.regles[0].note = 1)],
    ["libellé de règle", (e) => (e.regles[0].libelle = "a / à")],
    ["libellé à la place de l'identifiant", (e) => (e.regles[0].regle = "a / à")],
    ["date ISO", (e) => (e.semaines[0].semaine = "2026-01-05")],
    ["date ISO comme application", (e) => (e.application = "2026-01-05T09:41:00Z")],
    ["chemin de fichier", (e) => (e.regles[0].categorie = "/home/alice/Documents")],
    ["chemin Windows", (e) => (e.regles[0].regle = "C:\\Users\\alice")],
    ["nombre négatif", (e) => (e.semaines[1].mots = -3)],
    ["nombre non entier", (e) => (e.semaines[1].mots = 1.5)],
    ["nombre non fini", (e) => (e.semaines[1].mots = Number.POSITIVE_INFINITY)],
    ["NaN", (e) => (e.synthese.choix.justes = Number.NaN)],
    ["nombre démesuré", (e) => (e.semaines[1].mots = 1e12)],
    ["nombre écrit en chaîne", (e) => (e.semaines[1].mots = "150")],
    ["champ manquant", (e) => delete e.synthese.acquises.restees],
    ["mauvais format", (e) => (e.format = "autre")],
    ["mauvaise version", (e) => (e.version = 2)],
    ["plateforme inconnue", (e) => (e.plateforme = "mac de Jean")],
    ["participant en majuscules", (e) => (e.participant = PARTICIPANT.toUpperCase())],
    ["participant dérivé d'un nom", (e) => (e.participant = "jean.dupont@example.com")],
    ["état inconnu", (e) => (e.regles[0].etat = "parfaite")],
    ["groupe inconnu", (e) => (e.regles[0].groupe = "autre")],
    ["liste à la place d'un objet", (e) => (e.synthese = [])],
    ["objet à la place d'une liste", (e) => (e.semaines = {})],
    ["semaines dans le désordre", (e) => e.semaines.reverse()],
    ["pivot au-delà de la dernière semaine", (e) => (e.regles[0].semainePivot = 99)],
    ["comparaison avec un état", (e) => (e.regles[2].etat = "signalee")],
    [
      "trop de semaines",
      (e) =>
        (e.semaines = Array.from({ length: LIMITES_EXPORT.semaines + 1 }, (_, i) => ({
          semaine: i,
          textes: 0,
          mots: 0,
          fautes: 0,
        }))),
    ],
  ])("%s", (_cas, modifier) => {
    const resultat = altere(modifier);
    expect(resultat.ok).toBe(false);
  });

  it("le message d'erreur ne cite jamais le contenu refusé", () => {
    const secret = "Mon texte très privé";
    for (const modifier of [
      (e: Record<string, any>) => (e[secret] = 1),
      (e: Record<string, any>) => (e.regles[0].regle = secret),
      (e: Record<string, any>) => (e.application = secret),
    ]) {
      const resultat = altere(modifier);
      expect(resultat.ok).toBe(false);
      if (!resultat.ok) expect(resultat.erreur).not.toContain(secret);
    }
  });

  it("refuse les valeurs qui ne sont pas un export", () => {
    for (const valeur of [null, undefined, 42, "texte", [], Object.create(null)]) {
      expect(validerExport(valeur).ok).toBe(false);
    }
  });

  it("validerTexteExport : JSON illisible, fichier trop gros", () => {
    expect(validerTexteExport(texteExport(exemple())).ok).toBe(true);
    expect(validerTexteExport("{pas du JSON")).toEqual({ ok: false, erreur: "JSON illisible" });
    expect(validerTexteExport(" ".repeat(LIMITES_EXPORT.octets + 1))).toEqual({
      ok: false,
      erreur: "fichier trop gros",
    });
  });
});
