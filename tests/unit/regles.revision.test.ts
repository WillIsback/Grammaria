import { describe, expect, it } from "vite-plus/test";
import { FICHES } from "../../src/analysis/fiches";
import type { EtatCycle, RuleState } from "../../src/analysis/regles/cycle";
import { detecteEmplois } from "../../src/analysis/regles/emplois";
import {
  choisirRevision,
  EXEMPLES_REVISION,
  intervalleRevisionJours,
} from "../../src/analysis/regles/revision";
import { JOUR_MS, SEUILS } from "../../src/analysis/regles/seuils";

const NOW = new Date(2026, 10, 18, 12).getTime();
const ON = "PAIRE:on/ont";

function etat(ruleKey: string, state: EtatCycle, extra: Partial<RuleState> = {}): RuleState {
  return {
    ruleKey,
    state,
    stateSince: NOW - 20 * JOUR_MS,
    occurrences: 5,
    firstFaultAt: NOW - 30 * JOUR_MS,
    lastFaultAt: NOW - 10 * JOUR_MS,
    tipsShown: 1,
    choicesShown: 0,
    choicesCorrect: 0,
    choicesWrong: 0,
    lastSolicitedAt: NOW - 10 * JOUR_MS,
    solicitationsThatDay: 1,
    acquiredAt: null,
    relapses: 0,
    ...extra,
  };
}
const aucune = () => 0;

describe("phrases d'exemple des révisions (issue #62)", () => {
  it("chaque fiche de type paire a au moins deux phrases", () => {
    for (const ruleKey of Object.keys(FICHES).filter(detecteEmplois)) {
      expect(EXEMPLES_REVISION[ruleKey]?.length, ruleKey).toBeGreaterThanOrEqual(2);
    }
  });

  it("les deux formes d'une phrase appartiennent à la paire et diffèrent", () => {
    for (const [ruleKey, exemples] of Object.entries(EXEMPLES_REVISION)) {
      const formes = ruleKey.slice("PAIRE:".length).split("/");
      for (const e of exemples) {
        expect(formes, `${ruleKey} : ${e.bonne}`).toContain(e.bonne);
        expect(formes, `${ruleKey} : ${e.mauvaise}`).toContain(e.mauvaise);
        expect(e.bonne).not.toBe(e.mauvaise);
        expect(`${e.avant}${e.apres}`.length).toBeGreaterThan(10);
      }
    }
  });
});

describe("intervalleRevisionJours", () => {
  it("grandit à chaque bonne réponse, jusqu'à un plafond", () => {
    const base = SEUILS.revisionIntervalleJours;
    expect(intervalleRevisionJours(0)).toBe(base);
    expect(intervalleRevisionJours(1)).toBe(base * SEUILS.revisionFacteur);
    expect(intervalleRevisionJours(2)).toBe(base * SEUILS.revisionFacteur ** 2);
    expect(intervalleRevisionJours(50)).toBe(SEUILS.revisionIntervalleMaxJours);
  });
});

describe("choisirRevision", () => {
  it("pose une question sur une règle suivie dont l'intervalle est écoulé", () => {
    const question = choisirRevision([etat(ON, "signalee")], aucune, NOW, () => 0);
    expect(question).toMatchObject({ ruleKey: ON, titre: "on / ont" });
    expect(question?.explication).toContain("avaient");
    const [exemple] = EXEMPLES_REVISION[ON];
    expect(question).toMatchObject({ avant: exemple.avant, apres: exemple.apres });
    expect(question?.formes).toEqual([
      { texte: exemple.bonne, correcte: true },
      { texte: exemple.mauvaise, correcte: false },
    ]);
  });

  it("tire la phrase et l'ordre des formes au hasard", () => {
    const question = choisirRevision([etat(ON, "travaillee")], aucune, NOW, () => 0.99);
    const exemples = EXEMPLES_REVISION[ON];
    expect(question?.avant).toBe(exemples[exemples.length - 1].avant);
    expect(question?.formes[0].correcte).toBe(false);
  });

  it("ne demande rien avant la fin de l'intervalle", () => {
    const recent = NOW - (SEUILS.revisionIntervalleJours - 1) * JOUR_MS;
    expect(
      choisirRevision([etat(ON, "signalee", { lastSolicitedAt: recent })], aucune, NOW),
    ).toBeNull();
    expect(
      choisirRevision(
        [etat(ON, "signalee", { lastFaultAt: recent, lastSolicitedAt: null })],
        aucune,
        NOW,
      ),
    ).toBeNull();
  });

  it("espace davantage après des bonnes réponses", () => {
    const state = etat(ON, "signalee", {
      lastSolicitedAt: NOW - (SEUILS.revisionIntervalleJours + 1) * JOUR_MS,
    });
    expect(choisirRevision([state], aucune, NOW)).not.toBeNull();
    expect(choisirRevision([state], () => 1, NOW)).toBeNull();
  });

  it("ne révise ni une règle observée ou acquise, ni une règle sans phrase d'exemple", () => {
    expect(choisirRevision([etat(ON, "observee")], aucune, NOW)).toBeNull();
    expect(choisirRevision([etat(ON, "acquise")], aucune, NOW)).toBeNull();
    expect(choisirRevision([etat("ACCORD", "signalee")], aucune, NOW)).toBeNull();
  });

  it("entre plusieurs règles dues, prend celle qui attend depuis le plus longtemps", () => {
    const question = choisirRevision(
      [
        etat(ON, "signalee", { lastSolicitedAt: NOW - 5 * JOUR_MS }),
        etat("PAIRE:a/à", "travaillee", { lastSolicitedAt: NOW - 9 * JOUR_MS }),
      ],
      aucune,
      NOW,
    );
    expect(question?.ruleKey).toBe("PAIRE:a/à");
  });
});
