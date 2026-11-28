import { describe, expect, it } from "vite-plus/test";
import {
  appliquerEvenement,
  compterEtats,
  entreDansLeCycle,
  ETATS_CYCLE,
  jourLocal,
  peutSolliciter,
  type RuleContext,
  type RuleEvent,
  type RuleState,
} from "../../src/analysis/regles/cycle";
import { JOUR_MS, SEUILS } from "../../src/analysis/regles/seuils";

const REGLE = "PAIRE:on/ont";
/** Midi, heure locale : les décalages d'un jour ne dépendent pas du fuseau. */
const J0 = new Date(2026, 10, 2, 12, 0, 0).getTime();
const jour = (n: number) => J0 + n * JOUR_MS;

function appliquer(
  state: RuleState | null,
  event: RuleEvent,
  now: number,
  context: RuleContext = {},
) {
  const result = appliquerEvenement(REGLE, state, event, context, now);
  if (!result) throw new Error("aucun état");
  return result;
}

/** Règle signalée au jour 0 (trois fautes le même jour). */
function signalee(): RuleState {
  return appliquer(null, { type: "faute", count: 3 }, J0).state;
}

/** Règle signalée ayant reçu toutes ses astuces, une par jour. */
function signaleeAvecAstuces(): RuleState {
  let state = signalee();
  for (let i = 0; i < SEUILS.astucesAvantTravail; i++) {
    state = appliquer(state, { type: "astuce" }, jour(i)).state;
  }
  return state;
}

function travaillee(): RuleState {
  const now = jour(SEUILS.astucesAvantTravail);
  return appliquer(signaleeAvecAstuces(), { type: "faute", count: 1 }, now).state;
}

/** Textes corrigés à raison d'un par jour à partir du lendemain de `debut`. */
const textesQuotidiens = (debut: number, n: number) =>
  Array.from({ length: n }, (_, i) => debut + (i + 1) * JOUR_MS);

describe("seuils du cycle de vie", () => {
  it("reprend les valeurs de la feuille de route", () => {
    expect(SEUILS).toMatchObject({
      signalementOccurrences: 3,
      signalementFenetreJours: 7,
      astucesAvantTravail: 1,
      acquisitionJoursSansFaute: 14,
      travailleesMax: 3,
      sollicitationsParRegleEtParJour: 1,
    });
  });

  it("exige un usage réel pour l'acquisition", () => {
    expect(SEUILS.acquisitionTextesMin).toBeGreaterThanOrEqual(2);
    expect(SEUILS.acquisitionJoursActifsMin).toBeGreaterThanOrEqual(2);
    expect(SEUILS.acquisitionJoursActifsMin).toBeLessThanOrEqual(SEUILS.acquisitionTextesMin);
    expect(SEUILS.acquisitionJoursActifsMin).toBeLessThanOrEqual(SEUILS.acquisitionJoursSansFaute);
  });

  it("ne contient que des entiers strictement positifs", () => {
    for (const valeur of Object.values(SEUILS)) {
      expect(Number.isInteger(valeur)).toBe(true);
      expect(valeur).toBeGreaterThan(0);
    }
  });

  it("énumère les quatre états", () => {
    expect(ETATS_CYCLE).toEqual(["observee", "signalee", "travaillee", "acquise"]);
  });
});

describe("fautes qui entrent dans le cycle", () => {
  it("retient les fautes comptées dans la note", () => {
    expect(entreDansLeCycle({ ruleKey: "PAIRE:on/ont", counted: true })).toBe(true);
    expect(entreDansLeCycle({ ruleKey: "ACCORD", counted: true })).toBe(true);
  });

  it("écarte le style, la typographie et la détection générique des fautes de frappe", () => {
    expect(entreDansLeCycle({ ruleKey: "STYLE_X", counted: false })).toBe(false);
    expect(entreDansLeCycle({ ruleKey: "FR_SPELLING_RULE", counted: true })).toBe(false);
  });
});

describe("comptage des règles par état", () => {
  it("compte chaque état, dans l'ordre du cycle, zéro compris", () => {
    const counts = compterEtats([
      { state: "signalee" },
      { state: "acquise" },
      { state: "signalee" },
    ]);
    expect(counts).toEqual({ observee: 0, signalee: 2, travaillee: 0, acquise: 1 });
    expect(Object.keys(counts)).toEqual([...ETATS_CYCLE]);
  });
});

describe("observée", () => {
  it("crée la règle à la première faute, sans intervention possible", () => {
    const { state, transitions } = appliquer(null, { type: "faute", count: 1 }, J0);
    expect(state).toMatchObject({
      ruleKey: REGLE,
      state: "observee",
      occurrences: 1,
      firstFaultAt: J0,
      lastFaultAt: J0,
      tipsShown: 0,
      acquiredAt: null,
      relapses: 0,
    });
    expect(transitions).toEqual([
      { ruleKey: REGLE, at: J0, type: "observee", from: null, to: "observee" },
    ]);
  });

  it("ignore tout autre événement sur une règle inconnue", () => {
    expect(appliquerEvenement(REGLE, null, { type: "usage" }, {}, J0)).toBeNull();
    expect(appliquerEvenement(REGLE, null, { type: "astuce" }, {}, J0)).toBeNull();
    expect(appliquerEvenement(REGLE, null, { type: "faute", count: 0 }, {}, J0)).toBeNull();
  });

  it("reste observée à la deuxième faute", () => {
    const un = appliquer(null, { type: "faute", count: 1 }, J0).state;
    const deux = appliquer(un, { type: "faute", count: 1 }, jour(1), {
      previousFaultTimes: [J0],
    });
    expect(deux.state.state).toBe("observee");
    expect(deux.state.occurrences).toBe(2);
    expect(deux.transitions).toEqual([]);
  });

  it("ne modifie pas l'état reçu", () => {
    const un = appliquer(null, { type: "faute", count: 1 }, J0).state;
    const copie = { ...un };
    appliquer(un, { type: "faute", count: 2 }, jour(1), { previousFaultTimes: [J0] });
    expect(un).toEqual(copie);
  });
});

describe("observée → signalée", () => {
  it("à la troisième faute en sept jours", () => {
    const un = appliquer(null, { type: "faute", count: 1 }, J0).state;
    const deux = appliquer(un, { type: "faute", count: 1 }, jour(2), {
      previousFaultTimes: [J0],
    }).state;
    const trois = appliquer(deux, { type: "faute", count: 1 }, jour(6), {
      previousFaultTimes: [J0, jour(2)],
    });
    expect(trois.state).toMatchObject({ state: "signalee", stateSince: jour(6), occurrences: 3 });
    expect(trois.transitions).toEqual([
      { ruleKey: REGLE, at: jour(6), type: "signalee", from: "observee", to: "signalee" },
    ]);
  });

  it("compte plusieurs fautes du même texte", () => {
    expect(appliquer(null, { type: "faute", count: 3 }, J0).state.state).toBe("signalee");
  });

  it("ne compte pas les fautes sorties de la fenêtre de sept jours", () => {
    const un = appliquer(null, { type: "faute", count: 1 }, J0).state;
    const deux = appliquer(un, { type: "faute", count: 1 }, jour(1), {
      previousFaultTimes: [J0],
    }).state;
    // La première faute a exactement sept jours : elle est hors fenêtre.
    const trois = appliquer(deux, { type: "faute", count: 1 }, jour(7), {
      previousFaultTimes: [J0, jour(1)],
    });
    expect(trois.state.state).toBe("observee");
    expect(trois.state.occurrences).toBe(3);
  });
});

describe("signalée → travaillée", () => {
  it("reste signalée tant que les astuces n'ont pas toutes été affichées", () => {
    let state = signalee();
    for (let i = 0; i < SEUILS.astucesAvantTravail - 1; i++) {
      state = appliquer(state, { type: "astuce" }, jour(i)).state;
    }
    const suite = appliquer(state, { type: "faute", count: 1 }, jour(5));
    expect(suite.state.state).toBe("signalee");
    expect(suite.transitions).toEqual([]);
  });

  it("devient travaillée quand la faute revient après les astuces", () => {
    const now = jour(SEUILS.astucesAvantTravail);
    const { state, transitions } = appliquer(
      signaleeAvecAstuces(),
      { type: "faute", count: 1 },
      now,
    );
    expect(state).toMatchObject({ state: "travaillee", stateSince: now });
    expect(transitions).toEqual([
      { ruleKey: REGLE, at: now, type: "travaillee", from: "signalee", to: "travaillee" },
    ]);
  });

  it("une seule astuce suffit : la faute suivante fait passer en travaillée (issue #61)", () => {
    const apresUneAstuce = appliquer(signalee(), { type: "astuce" }, jour(0)).state;
    const suite = appliquer(apresUneAstuce, { type: "faute", count: 1 }, jour(1));
    expect(suite.state.state).toBe("travaillee");
  });

  it("les astuces seules ne font pas passer en travaillée", () => {
    expect(signaleeAvecAstuces().state).toBe("signalee");
    expect(signaleeAvecAstuces().tipsShown).toBe(SEUILS.astucesAvantTravail);
  });

  it("reste travaillée aux fautes suivantes", () => {
    const suite = appliquer(travaillee(), { type: "faute", count: 2 }, jour(9));
    expect(suite.state.state).toBe("travaillee");
    expect(suite.transitions).toEqual([]);
  });
});

describe("budget de friction", () => {
  it("refuse une règle travaillée de plus quand le plafond est atteint", () => {
    const now = jour(SEUILS.astucesAvantTravail);
    const plein = appliquer(signaleeAvecAstuces(), { type: "faute", count: 1 }, now, {
      otherWorkedRules: SEUILS.travailleesMax,
    });
    expect(plein.state.state).toBe("signalee");
    expect(plein.transitions).toEqual([]);

    // Une place se libère : la faute suivante fait entrer la règle.
    const libre = appliquer(plein.state, { type: "faute", count: 1 }, now + JOUR_MS, {
      otherWorkedRules: SEUILS.travailleesMax - 1,
    });
    expect(libre.state.state).toBe("travaillee");
  });

  it("limite à une sollicitation par règle et par jour", () => {
    const base = signalee();
    expect(peutSolliciter(base, J0)).toBe(true);

    const apres = appliquer(base, { type: "astuce" }, J0).state;
    expect(apres).toMatchObject({ lastSolicitedAt: J0, solicitationsThatDay: 1, tipsShown: 1 });
    expect(peutSolliciter(apres, J0 + 60_000)).toBe(false);
    expect(peutSolliciter(apres, jour(1))).toBe(true);
  });

  it("compte le choix à deux formes comme une sollicitation", () => {
    const state = appliquer(travaillee(), { type: "choix" }, jour(10)).state;
    expect(state).toMatchObject({ choicesShown: 1, lastSolicitedAt: jour(10) });
    expect(peutSolliciter(state, jour(10) + 1000)).toBe(false);
    expect(peutSolliciter(state, jour(11))).toBe(true);
  });

  it("suit le seuil quand il autorise plusieurs sollicitations par jour", () => {
    const deuxParJour = { ...SEUILS, sollicitationsParRegleEtParJour: 2 };
    const une = appliquer(signalee(), { type: "astuce" }, J0).state;
    expect(peutSolliciter(une, J0 + 1000, deuxParJour)).toBe(true);
    const deux = appliquer(une, { type: "astuce" }, J0 + 1000).state;
    expect(deux.solicitationsThatDay).toBe(2);
    expect(peutSolliciter(deux, J0 + 2000, deuxParJour)).toBe(false);
  });

  it("raisonne en jours calendaires", () => {
    const soir = new Date(2026, 10, 2, 23, 30).getTime();
    const matin = new Date(2026, 10, 3, 0, 30).getTime();
    expect(jourLocal(soir)).not.toBe(jourLocal(matin));
    const state = appliquer(signalee(), { type: "astuce" }, soir).state;
    expect(peutSolliciter(state, matin)).toBe(true);
  });
});

describe("→ acquise", () => {
  const delai = SEUILS.acquisitionJoursSansFaute;

  it.each([
    ["signalée", signalee],
    ["travaillée", travaillee],
  ])("une règle %s devient acquise après 14 jours d'usage sans faute", (_nom, creer) => {
    const state = creer();
    const now = state.lastFaultAt + delai * JOUR_MS;
    const result = appliquer(state, { type: "usage" }, now, {
      textTimesSinceLastFault: textesQuotidiens(state.lastFaultAt, delai),
    });
    expect(result.state).toMatchObject({ state: "acquise", acquiredAt: now, stateSince: now });
    expect(result.transitions).toEqual([
      { ruleKey: REGLE, at: now, type: "acquise", from: state.state, to: "acquise" },
    ]);
  });

  it("pas avant 14 jours, même avec beaucoup de textes", () => {
    const state = signalee();
    const now = state.lastFaultAt + (delai - 1) * JOUR_MS;
    const result = appliquer(state, { type: "usage" }, now, {
      textTimesSinceLastFault: textesQuotidiens(state.lastFaultAt, delai - 1),
    });
    expect(result.state.state).toBe("signalee");
  });

  it("pas si l'application n'a pas été utilisée", () => {
    const state = signalee();
    const now = state.lastFaultAt + 30 * JOUR_MS;
    // Seul le texte du jour : un texte, un jour.
    const result = appliquer(state, { type: "usage" }, now, { textTimesSinceLastFault: [now] });
    expect(result.state.state).toBe("signalee");
    expect(result.transitions).toEqual([]);
  });

  it("pas si les textes tiennent sur trop peu de jours", () => {
    const state = signalee();
    const now = state.lastFaultAt + 20 * JOUR_MS;
    const memeJour = Array.from({ length: 10 }, (_, i) => now - i * 60_000);
    const result = appliquer(state, { type: "usage" }, now, {
      textTimesSinceLastFault: memeJour,
    });
    expect(result.state.state).toBe("signalee");
  });

  it("pas si les textes sont trop peu nombreux", () => {
    const state = signalee();
    const now = state.lastFaultAt + 20 * JOUR_MS;
    const result = appliquer(state, { type: "usage" }, now, {
      textTimesSinceLastFault: textesQuotidiens(state.lastFaultAt, SEUILS.acquisitionTextesMin - 1),
    });
    expect(result.state.state).toBe("signalee");
  });

  it("devient acquise exactement aux minimums d'usage", () => {
    const state = signalee();
    const now = state.lastFaultAt + 20 * JOUR_MS;
    // Jours actifs minimum, puis le reste des textes le dernier jour.
    const textes = textesQuotidiens(state.lastFaultAt, SEUILS.acquisitionJoursActifsMin);
    while (textes.length < SEUILS.acquisitionTextesMin) textes.push(textes[0] + textes.length);
    const result = appliquer(state, { type: "usage" }, now, { textTimesSinceLastFault: textes });
    expect(result.state.state).toBe("acquise");
  });

  it("ne compte pas les textes antérieurs à la dernière faute", () => {
    const state = signalee();
    const now = state.lastFaultAt + 20 * JOUR_MS;
    const avant = Array.from({ length: 10 }, (_, i) => state.lastFaultAt - i * JOUR_MS);
    const result = appliquer(state, { type: "usage" }, now, { textTimesSinceLastFault: avant });
    expect(result.state.state).toBe("signalee");
  });

  it("une règle seulement observée ne devient pas acquise", () => {
    const state = appliquer(null, { type: "faute", count: 1 }, J0).state;
    const result = appliquer(state, { type: "usage" }, jour(40), {
      textTimesSinceLastFault: textesQuotidiens(J0, 30),
    });
    expect(result.state.state).toBe("observee");
  });

  it("une nouvelle faute repousse l'acquisition", () => {
    const state = appliquer(signalee(), { type: "faute", count: 1 }, jour(10)).state;
    const result = appliquer(state, { type: "usage" }, jour(delai), {
      textTimesSinceLastFault: textesQuotidiens(J0, delai),
    });
    expect(result.state.state).toBe("signalee");
  });
});

describe("rechute", () => {
  function acquise(): RuleState {
    const state = travaillee();
    const now = state.lastFaultAt + SEUILS.acquisitionJoursSansFaute * JOUR_MS;
    return appliquer(state, { type: "usage" }, now, {
      textTimesSinceLastFault: textesQuotidiens(state.lastFaultAt, 14),
    }).state;
  }

  it("une faute après acquisition ramène à « signalée »", () => {
    const avant = acquise();
    const now = avant.stateSince + 5 * JOUR_MS;
    const { state, transitions } = appliquer(avant, { type: "faute", count: 1 }, now);
    expect(state).toMatchObject({
      state: "signalee",
      stateSince: now,
      acquiredAt: null,
      relapses: 1,
      tipsShown: 0,
      occurrences: avant.occurrences + 1,
    });
    expect(transitions).toEqual([
      { ruleKey: REGLE, at: now, type: "rechute", from: "acquise", to: "signalee" },
    ]);
  });

  it("après une rechute, il faut de nouveau plusieurs astuces avant le choix", () => {
    const avant = acquise();
    const now = avant.stateSince + 5 * JOUR_MS;
    const rechute = appliquer(avant, { type: "faute", count: 1 }, now).state;
    const suite = appliquer(rechute, { type: "faute", count: 1 }, now + JOUR_MS).state;
    expect(suite.state).toBe("signalee");
  });

  it("une règle acquise le reste tant qu'aucune faute ne revient", () => {
    const avant = acquise();
    const result = appliquer(avant, { type: "usage" }, avant.stateSince + 30 * JOUR_MS, {});
    expect(result.state).toEqual(avant);
    expect(result.transitions).toEqual([]);
  });

  it("peut être acquise de nouveau, en gardant le nombre de rechutes", () => {
    const avant = acquise();
    const rechute = appliquer(avant, { type: "faute", count: 1 }, avant.stateSince + JOUR_MS).state;
    const now = rechute.lastFaultAt + 14 * JOUR_MS;
    const result = appliquer(rechute, { type: "usage" }, now, {
      textTimesSinceLastFault: textesQuotidiens(rechute.lastFaultAt, 14),
    });
    expect(result.state).toMatchObject({ state: "acquise", relapses: 1, acquiredAt: now });
  });
});

describe("réponses au choix à deux formes", () => {
  it("compte les bonnes et les mauvaises réponses sans changer d'état", () => {
    let state = appliquer(travaillee(), { type: "choix" }, jour(10)).state;
    state = appliquer(state, { type: "reponse", correct: true }, jour(10)).state;
    state = appliquer(state, { type: "choix" }, jour(11)).state;
    const result = appliquer(state, { type: "reponse", correct: false }, jour(11));
    expect(result.state).toMatchObject({
      state: "travaillee",
      choicesShown: 2,
      choicesCorrect: 1,
      choicesWrong: 1,
    });
    expect(result.transitions).toEqual([]);
  });
});

describe("acquisition sur emplois corrects (issue #60)", () => {
  const PAIRE = "PAIRE:on/ont";
  const signaleePaire = (): RuleState =>
    appliquerEvenement(PAIRE, null, { type: "faute", count: 3 }, {}, J0)?.state as RuleState;
  const apres = jour(SEUILS.acquisitionJoursSansFaute + 1);
  const textes = textesQuotidiens(J0, SEUILS.acquisitionJoursSansFaute);
  const usage = (state: RuleState, context: Parameters<typeof appliquerEvenement>[3]) =>
    appliquerEvenement(state.ruleKey, state, { type: "usage" }, context, apres)?.state.state;

  it("une paire jamais employée ne devient pas acquise, même après le délai", () => {
    expect(usage(signaleePaire(), { textTimesSinceLastFault: textes, correctUseTimes: [] })).toBe(
      "signalee",
    );
  });

  it("devient acquise avec assez d'emplois corrects sur assez de jours", () => {
    const emplois = textesQuotidiens(J0, SEUILS.acquisitionEmploisMin);
    expect(
      usage(signaleePaire(), { textTimesSinceLastFault: textes, correctUseTimes: emplois }),
    ).toBe("acquise");
  });

  it("exige des emplois répartis sur plusieurs jours", () => {
    const memeJour = Array.from(
      { length: SEUILS.acquisitionEmploisMin },
      (_, i) => jour(2) + i * 1000,
    );
    expect(
      usage(signaleePaire(), { textTimesSinceLastFault: textes, correctUseTimes: memeJour }),
    ).toBe("signalee");
  });

  it("ignore les emplois antérieurs à la dernière faute", () => {
    const anciens = Array.from(
      { length: SEUILS.acquisitionEmploisMin },
      (_, i) => J0 - (i + 1) * JOUR_MS,
    );
    expect(
      usage(signaleePaire(), { textTimesSinceLastFault: textes, correctUseTimes: anciens }),
    ).toBe("signalee");
  });

  it("sans information d'emploi (rejeu d'un ancien journal), garde le critère sur les textes", () => {
    expect(usage(signaleePaire(), { textTimesSinceLastFault: textes })).toBe("acquise");
  });

  it("une règle sans détection d'emploi garde le critère sur les textes", () => {
    const accord = appliquerEvenement("ACCORD", null, { type: "faute", count: 3 }, {}, J0)
      ?.state as RuleState;
    expect(usage(accord, { textTimesSinceLastFault: textes, correctUseTimes: [] })).toBe("acquise");
  });

  it("le seuil d'emplois est au moins celui des jours actifs", () => {
    expect(SEUILS.acquisitionEmploisMin).toBeGreaterThanOrEqual(SEUILS.acquisitionJoursActifsMin);
  });
});
