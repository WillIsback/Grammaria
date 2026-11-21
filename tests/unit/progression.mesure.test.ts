import { describe, expect, it } from "vite-plus/test";
import {
  calculerMesure,
  dateCritere,
  type EntreeMesure,
  evolution,
  synthese,
  taux,
} from "../../src/analysis/progression/mesure";
import { MESURE } from "../../src/analysis/progression/reglages";

const JOUR = 24 * 60 * 60 * 1000;
/** Un instant quelconque, pas un minuit : le calcul ne dépend d'aucun calendrier. */
const T0 = Date.UTC(2026, 0, 5, 7, 13);
const jour = (n: number) => T0 + n * JOUR;

/** Un texte de 150 mots par jour, du jour `de` au jour `a` compris. */
const textes = (de: number, a: number, mots = 150) =>
  Array.from({ length: a - de + 1 }, (_, i) => ({ at: jour(de + i), words: mots }));
const faute = (n: number, ruleKey = "PAIRE:a/à", categoryId = "CONFUSION") => ({
  at: jour(n),
  ruleKey,
  categoryId,
});
const evt = (n: number, type: string, ruleKey = "PAIRE:a/à") => ({ at: jour(n), ruleKey, type });

const entree = (partiel: Partial<EntreeMesure>): EntreeMesure => ({
  texts: [],
  faults: [],
  events: [],
  states: [],
  ...partiel,
});

describe("calculerMesure — règles suivies", () => {
  it("journal vide : rien à mesurer, aucun taux", () => {
    const m = calculerMesure(entree({}));
    expect(m.premierTexte).toBeNull();
    expect(m.suivies).toEqual([]);
    expect(m.comparaison).toEqual([]);
    expect(m.synthese.suivies).toMatchObject({ regles: 0, reglesSuffisantes: 0, evolution: null });
    expect(m.synthese.suivies.avant.taux).toBeNull();
    expect(m.choix).toEqual({ justes: 0, fausses: 0, taux: null });
    expect(m.acquises).toEqual({ total: 0, restees: 0, rechutes: 0 });
    expect(m.motsParTaux).toBe(1000);
  });

  it("des fautes sans aucune intervention : aucune règle suivie", () => {
    const m = calculerMesure(
      entree({ texts: textes(0, 20), faults: [faute(1), faute(2), faute(3)] }),
    );
    expect(m.suivies).toEqual([]);
  });

  it("avant / depuis la première astuce, pour 1 000 mots, avec les volumes", () => {
    // Fautes aux jours 0, 2, 4 (astuce au jour 4), puis 10 et 20.
    const m = calculerMesure(
      entree({
        texts: textes(0, 29),
        faults: [faute(0), faute(2), faute(4), faute(10), faute(20)],
        events: [evt(4, "astuce"), evt(12, "astuce")],
        states: [{ ruleKey: "PAIRE:a/à", state: "signalee", label: "a / à" }],
      }),
    );
    expect(m.suivies).toHaveLength(1);
    const r = m.suivies[0];
    expect(r).toMatchObject({
      ruleKey: "PAIRE:a/à",
      label: "a / à",
      categoryId: "CONFUSION",
      groupe: "suivie",
      etat: "signalee",
      pivot: jour(4),
      // Jours 0 à 4 compris : le texte fautif de l'astuce est « avant ».
      avant: { textes: 5, mots: 750, fautes: 3, taux: 4 },
      depuis: { textes: 25, mots: 3750, fautes: 2, taux: 0.5 },
      suffisant: true,
      avantTropCourt: false,
      textesManquants: 0,
      evolution: -87,
      astuces: 2,
    });
    expect(m.synthese.suivies).toMatchObject({
      regles: 1,
      reglesSuffisantes: 1,
      avant: { fautes: 3, mots: 750, taux: 4 },
      depuis: { fautes: 2, mots: 3750, taux: 0.5 },
      evolution: -87,
    });
  });

  it("l'avant commence à la première faute de la règle, pas au premier texte", () => {
    const m = calculerMesure(
      entree({
        texts: textes(0, 40),
        faults: [faute(20), faute(22), faute(24)],
        events: [evt(24, "astuce")],
        states: [{ ruleKey: "PAIRE:a/à", state: "signalee" }],
      }),
    );
    expect(m.suivies[0].avant).toMatchObject({ textes: 5, mots: 750, fautes: 3 });
    // Sans libellé connu : la clé.
    expect(m.suivies[0].label).toBe("PAIRE:a/à");
  });

  it("sans astuce, le premier choix à deux formes sert de pivot", () => {
    const m = calculerMesure(
      entree({
        texts: textes(0, 20),
        faults: [faute(0), faute(1), faute(2), faute(3)],
        events: [
          evt(3, "choix"),
          evt(3, "reponse_juste"),
          evt(9, "choix"),
          evt(9, "reponse_fausse"),
        ],
        states: [{ ruleKey: "PAIRE:a/à", state: "travaillee" }],
      }),
    );
    expect(m.suivies[0]).toMatchObject({
      pivot: jour(3),
      choix: 2,
      reponsesJustes: 1,
      reponsesFausses: 1,
    });
    expect(m.choix).toEqual({ justes: 1, fausses: 1, taux: 50 });
  });

  it("pivot sans aucun texte après : pas de taux « depuis », il manque des textes", () => {
    const m = calculerMesure(
      entree({
        texts: textes(0, 6),
        faults: [faute(2), faute(4), faute(6)],
        events: [evt(6, "astuce")],
        states: [{ ruleKey: "PAIRE:a/à", state: "signalee" }],
      }),
    );
    const r = m.suivies[0];
    expect(r.depuis).toEqual({ textes: 0, mots: 0, fautes: 0, taux: null });
    expect(r.suffisant).toBe(false);
    expect(r.evolution).toBeNull();
    // 5 textes au minimum, mais 1 000 mots à 150 mots par texte : 7 textes.
    expect(r.textesManquants).toBe(Math.ceil(MESURE.depuisMinimumMots / 150));
    expect(m.synthese.suivies).toMatchObject({ regles: 1, reglesSuffisantes: 0, evolution: null });
  });

  it("période avant trop courte : la règle n'entre pas dans la synthèse", () => {
    // Trois fautes dans le même texte : astuce au premier texte.
    const m = calculerMesure(
      entree({
        texts: textes(0, 30),
        faults: [faute(0), faute(0), faute(0)],
        events: [evt(0, "astuce")],
        states: [{ ruleKey: "PAIRE:a/à", state: "signalee" }],
      }),
    );
    expect(m.suivies[0]).toMatchObject({
      avantTropCourt: true,
      suffisant: false,
      textesManquants: 0,
      avant: { textes: 1, fautes: 3 },
    });
  });

  it("règle acquise puis rechute : comptée parmi les acquises, pas parmi celles restées acquises", () => {
    const etats = [
      { ruleKey: "PAIRE:a/à", state: "signalee" as const },
      { ruleKey: "PAIRE:on/ont", state: "acquise" as const },
    ];
    const m = calculerMesure(
      entree({
        texts: textes(0, 60),
        faults: [
          faute(0),
          faute(1),
          faute(2),
          faute(40),
          ...[0, 1, 2].map((n) => faute(n, "PAIRE:on/ont")),
        ],
        events: [
          evt(2, "astuce"),
          evt(20, "acquise"),
          evt(40, "rechute"),
          evt(2, "astuce", "PAIRE:on/ont"),
          evt(25, "acquise", "PAIRE:on/ont"),
        ],
        states: etats,
      }),
    );
    expect(m.acquises).toEqual({ total: 2, restees: 1, rechutes: 1 });
    const aa = m.suivies.find((r) => r.ruleKey === "PAIRE:a/à")!;
    expect(aa).toMatchObject({ rechutes: 1, acquiseLe: jour(20), etat: "signalee" });
  });

  it("le résultat ne dépend que des écarts de temps (aucun calendrier, aucun fuseau)", () => {
    const base = entree({
      texts: textes(0, 29),
      faults: [faute(0), faute(2), faute(4), faute(10), faute(20)],
      events: [evt(4, "astuce")],
      states: [{ ruleKey: "PAIRE:a/à", state: "signalee" }],
    });
    const decale = (d: number): EntreeMesure => ({
      ...base,
      texts: base.texts.map((t) => ({ ...t, at: t.at + d })),
      faults: base.faults.map((f) => ({ ...f, at: f.at + d })),
      events: base.events.map((e) => ({ ...e, at: e.at + d })),
    });
    const sans = (m: ReturnType<typeof calculerMesure>) =>
      m.suivies.map(({ pivot: _p, acquiseLe: _a, ...r }) => r);
    const reference = sans(calculerMesure(base));
    // Décalages de 5 h 30, de 11 h et d'un passage à l'heure d'été (mars).
    for (const d of [5.5 * 3600_000, -11 * 3600_000, Date.UTC(2026, 2, 29) - T0]) {
      expect(sans(calculerMesure(decale(d)))).toEqual(reference);
    }
  });
});

describe("calculerMesure — groupe de comparaison", () => {
  it("fautes de frappe : pivot au même critère de signalement (3 fautes en 7 jours)", () => {
    const frappe = (n: number) => faute(n, "FR_SPELLING_RULE", "TYPOS");
    const m = calculerMesure(
      entree({
        texts: textes(0, 40),
        // Jour 0, puis jours 9, 12, 14 : le critère est rempli au jour 14.
        faults: [frappe(0), frappe(9), frappe(12), frappe(14), frappe(30)],
        // Une règle hors cycle n'a jamais d'événement ; ceux-ci seraient ignorés.
        events: [evt(14, "astuce", "FR_SPELLING_RULE")],
      }),
    );
    expect(m.suivies).toEqual([]);
    expect(m.comparaison).toHaveLength(1);
    expect(m.comparaison[0]).toMatchObject({
      ruleKey: "FR_SPELLING_RULE",
      label: "Fautes de frappe",
      groupe: "comparaison",
      etat: null,
      pivot: jour(14),
      avant: { textes: 15, mots: 2250, fautes: 4 },
      depuis: { textes: 26, mots: 3900, fautes: 1 },
      suffisant: true,
    });
    expect(m.synthese.comparaison.evolution).toBe(
      Math.round(((1 / 3900 - 4 / 2250) / (4 / 2250)) * 100),
    );
  });

  it("des fautes de frappe trop rares n'atteignent pas le critère : pas de comparaison", () => {
    const m = calculerMesure(
      entree({
        texts: textes(0, 40),
        faults: [0, 10, 20, 30].map((n) => faute(n, "FR_SPELLING_RULE")),
      }),
    );
    expect(m.comparaison).toEqual([]);
    expect(m.synthese.comparaison).toMatchObject({ regles: 0, evolution: null });
  });
});

describe("outils de la mesure", () => {
  it("dateCritere : fenêtre glissante, fautes d'un même texte comprises", () => {
    expect(dateCritere([])).toBeNull();
    expect(dateCritere([jour(0), jour(0), jour(0)])).toBe(jour(0));
    expect(dateCritere([jour(0), jour(7), jour(8)])).toBeNull(); // jour 0 hors de ]1, 8]
    expect(dateCritere([jour(0), jour(6), jour(6.5)])).toBe(jour(6.5));
  });

  it("taux et évolution : nombres exacts, null sans mot ou sans faute avant", () => {
    expect(taux(3, 750)).toBe(4);
    expect(taux(1, 0)).toBeNull();
    expect(evolution({ fautes: 4, mots: 1000 }, { fautes: 1, mots: 1000 })).toBe(-75);
    expect(evolution({ fautes: 0, mots: 1000 }, { fautes: 1, mots: 1000 })).toBeNull();
    expect(evolution({ fautes: 1, mots: 1000 }, { fautes: 1, mots: 0 })).toBeNull();
  });

  it("synthèse : somme des fautes sur somme des mots, pas une moyenne de taux", () => {
    const regle = (avant: [number, number], depuis: [number, number], suffisant = true) =>
      ({
        suffisant,
        avant: { textes: 5, fautes: avant[0], mots: avant[1], taux: null },
        depuis: { textes: 5, fautes: depuis[0], mots: depuis[1], taux: null },
      }) as never;
    const s = synthese([
      regle([10, 1000], [0, 1000]),
      regle([1, 9000], [9, 9000]),
      regle([50, 100], [0, 100], false),
    ]);
    // Moyenne des taux : (10 + 0,1) / 2 = 5 avant ; somme / somme : 11 / 10 000 = 1,1.
    expect(s.avant).toEqual({ textes: 10, fautes: 11, mots: 10000, taux: 1.1 });
    expect(s.depuis).toEqual({ textes: 10, fautes: 9, mots: 10000, taux: 0.9 });
    expect(s).toMatchObject({ regles: 3, reglesSuffisantes: 2, evolution: -18 });
  });
});
