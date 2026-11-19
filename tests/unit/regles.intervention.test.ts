import { describe, expect, it } from "vite-plus/test";
import { analyze } from "../../src/analysis/analyze";
import type { EtatCycle, RuleState } from "../../src/analysis/regles/cycle";
import {
  type Candidat,
  choisirIntervention,
  construireChoix,
  type PassageCorrige,
} from "../../src/analysis/regles/intervention";
import { JOUR_MS, SEUILS } from "../../src/analysis/regles/seuils";

const NOW = new Date(2026, 10, 18, 12).getTime();
const ORIGINAL = "Bonjour. Hier, ils on mangé tous les gâteaux de la fête. Merci.";
const CORRIGE = "Bonjour. Hier, ils ont mangé tous les gâteaux de la fête. Merci.";

function passage(original = ORIGINAL, corrige = CORRIGE): PassageCorrige {
  const [c] = analyze(original, corrige, []).corrections;
  return { start: c.start, end: c.end, avant: c.avant, apres: c.apres };
}

function etat(ruleKey: string, state: EtatCycle, extra: Partial<RuleState> = {}): RuleState {
  return {
    ruleKey,
    state,
    stateSince: NOW - JOUR_MS,
    occurrences: 5,
    firstFaultAt: NOW - 10 * JOUR_MS,
    lastFaultAt: NOW,
    tipsShown: 0,
    choicesShown: 0,
    choicesCorrect: 0,
    choicesWrong: 0,
    lastSolicitedAt: null,
    solicitationsThatDay: 0,
    acquiredAt: null,
    relapses: 0,
    ...extra,
  };
}

function candidat(
  ruleKey: string,
  state: EtatCycle,
  extra: Partial<RuleState> = {},
  autres: Partial<Candidat> = {},
): Candidat {
  return {
    state: etat(ruleKey, state, extra),
    titre: ruleKey,
    astuce: `Astuce de ${ruleKey}`,
    passages: [passage()],
    ...autres,
  };
}

describe("construireChoix", () => {
  it("propose les deux formes sur la phrase de l'utilisateur", () => {
    const choix = construireChoix(ORIGINAL, passage(), () => 0);
    expect(choix).toEqual({
      avant: "Hier, ils ",
      apres: " mangé tous les gâteaux de la fête.",
      formes: [
        { texte: "ont", correcte: true },
        { texte: "on", correcte: false },
      ],
    });
  });

  it("tire l'ordre des deux formes au hasard", () => {
    const premier = (tirage: number) =>
      construireChoix(ORIGINAL, passage(), () => tirage)?.formes[0].texte;
    expect(premier(0.2)).toBe("ont");
    expect(premier(0.7)).toBe("on");

    const vus = new Set<string>();
    for (let i = 0; i < 200; i++)
      vus.add(construireChoix(ORIGINAL, passage())?.formes[0].texte ?? "");
    expect(vus).toEqual(new Set(["on", "ont"]));
  });

  it("raccourcit une phrase longue autour de la forme", () => {
    const debut =
      "Je vous écris pour vous dire que malgré tout ce qui a été annoncé la semaine dernière";
    const fin = "décidé de reporter la réunion prévue avec toute l'équipe au mois prochain";
    const original = `${debut} ils on ${fin}.`;
    const choix = construireChoix(original, passage(original, original.replace(" on ", " ont ")));
    expect(choix?.avant.startsWith("… ")).toBe(true);
    expect(choix?.avant.endsWith(" ils ")).toBe(true);
    expect(choix?.apres.endsWith(" …")).toBe(true);
    expect(choix?.avant.length).toBeLessThanOrEqual(SEUILS.choixContexteMax + 2);
    expect(choix?.apres.length).toBeLessThanOrEqual(SEUILS.choixContexteMax + 2);
  });

  it("renonce pour un ajout ou une suppression pure", () => {
    expect(construireChoix("Il va bien", { start: 2, end: 2, avant: "", apres: "ne" })).toBeNull();
    expect(construireChoix("Il ne va", { start: 3, end: 5, avant: "ne", apres: "" })).toBeNull();
  });

  it("renonce quand une forme ne tient pas sur un bouton", () => {
    const longue = "x".repeat(SEUILS.choixLongueurMaxForme + 1);
    expect(
      construireChoix(`Il ${longue} ici`, {
        start: 3,
        end: 3 + longue.length,
        avant: longue,
        apres: "y",
      }),
    ).toBeNull();
  });

  it("renonce si le passage ne correspond pas au texte d'origine", () => {
    expect(construireChoix("", passage())).toBeNull();
  });
});

describe("choisirIntervention", () => {
  it("ne propose rien pour une règle observée ou acquise", () => {
    expect(choisirIntervention([candidat("A", "observee")], ORIGINAL, NOW)).toBeNull();
    expect(choisirIntervention([candidat("A", "acquise")], ORIGINAL, NOW)).toBeNull();
    expect(choisirIntervention([], ORIGINAL, NOW)).toBeNull();
  });

  it("affiche l'astuce de la fiche pour une règle signalée", () => {
    expect(choisirIntervention([candidat("A", "signalee")], ORIGINAL, NOW)).toEqual({
      type: "astuce",
      ruleKey: "A",
      titre: "A",
      texte: "Astuce de A",
    });
  });

  it("propose le choix à deux formes pour une règle travaillée", () => {
    const intervention = choisirIntervention(
      [candidat("A", "travaillee")],
      ORIGINAL,
      NOW,
      () => 0.9,
    );
    expect(intervention).toMatchObject({
      type: "choix",
      ruleKey: "A",
      explication: "Astuce de A",
      formes: [
        { texte: "on", correcte: false },
        { texte: "ont", correcte: true },
      ],
    });
  });

  it("fait passer le choix avant l'astuce, et n'en retient qu'une", () => {
    const intervention = choisirIntervention(
      [candidat("A", "signalee"), candidat("B", "travaillee")],
      ORIGINAL,
      NOW,
    );
    expect(intervention).toMatchObject({ type: "choix", ruleKey: "B" });
  });

  it("respecte une sollicitation par règle et par jour", () => {
    const dejaVue = { lastSolicitedAt: NOW - 60_000, solicitationsThatDay: 1 };
    expect(choisirIntervention([candidat("A", "travaillee", dejaVue)], ORIGINAL, NOW)).toBeNull();
    expect(choisirIntervention([candidat("A", "signalee", dejaVue)], ORIGINAL, NOW)).toBeNull();

    // Le lendemain, la règle peut de nouveau être sollicitée.
    const hier = { lastSolicitedAt: NOW - JOUR_MS, solicitationsThatDay: 1 };
    expect(choisirIntervention([candidat("A", "travaillee", hier)], ORIGINAL, NOW)).not.toBeNull();
  });

  it("passe à une autre règle quand la première a épuisé son budget du jour", () => {
    const intervention = choisirIntervention(
      [
        candidat("A", "travaillee", { lastSolicitedAt: NOW - 1000, solicitationsThatDay: 1 }),
        candidat("B", "signalee"),
      ],
      ORIGINAL,
      NOW,
    );
    expect(intervention).toMatchObject({ type: "astuce", ruleKey: "B" });
  });

  it("entre deux règles de même rang, prend la moins récemment sollicitée", () => {
    const intervention = choisirIntervention(
      [
        candidat("A", "signalee", { lastSolicitedAt: NOW - 2 * JOUR_MS, solicitationsThatDay: 1 }),
        candidat("B", "signalee", { lastSolicitedAt: NOW - 5 * JOUR_MS, solicitationsThatDay: 1 }),
      ],
      ORIGINAL,
      NOW,
    );
    expect(intervention?.ruleKey).toBe("B");
  });

  it("se rabat sur une astuce quand le choix n'est pas constructible", () => {
    const intervention = choisirIntervention(
      [
        candidat(
          "A",
          "travaillee",
          {},
          {
            passages: [{ start: 2, end: 2, avant: "", apres: "ne" }],
          },
        ),
      ],
      "Il va bien",
      NOW,
    );
    expect(intervention).toMatchObject({ type: "astuce", ruleKey: "A" });
  });

  it("rédige une astuce à partir de la correction pour une règle sans fiche", () => {
    const intervention = choisirIntervention(
      [candidat("ACCORD", "signalee", {}, { astuce: null })],
      ORIGINAL,
      NOW,
    );
    expect(intervention).toMatchObject({
      type: "astuce",
      texte: "Vous avez écrit « on » ; la forme correcte ici est « ont ».",
    });
  });
});
