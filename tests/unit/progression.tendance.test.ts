import { describe, expect, it } from "vite-plus/test";
import type { Mesure, MesureRegle } from "../../src/analysis/progression/mesure";
import { choisirTendance } from "../../src/analysis/progression/tendance";

function regle(extra: Partial<MesureRegle> & { ruleKey: string }): MesureRegle {
  return {
    label: extra.ruleKey,
    categoryId: "CONFUSION",
    groupe: "suivie",
    etat: "signalee",
    pivot: 0,
    avant: { textes: 4, mots: 600, fautes: 3, taux: 5 },
    depuis: { textes: 8, mots: 1500, fautes: 3, taux: 2 },
    suffisant: true,
    avantTropCourt: false,
    textesManquants: 0,
    evolution: -60,
    astuces: 1,
    choix: 0,
    reponsesJustes: 0,
    reponsesFausses: 0,
    rechutes: 0,
    acquiseLe: null,
    ...extra,
  };
}
const mesure = (suivies: MesureRegle[], comparaison: MesureRegle[] = []) =>
  ({ motsParTaux: 1000, suivies, comparaison }) as unknown as Mesure;

describe("choisirTendance — la progression avant la note (issue #63)", () => {
  it("donne la tendance d'une règle du texte dont le taux a baissé", () => {
    const m = mesure([regle({ ruleKey: "PAIRE:a/à", label: "a / à" })]);
    expect(choisirTendance(m, ["PAIRE:a/à"])).toEqual({
      ruleKey: "PAIRE:a/à",
      titre: "a / à",
      avant: 5,
      depuis: 2,
      motsParTaux: 1000,
    });
  });

  it("ne dit rien d'une règle absente du texte", () => {
    const m = mesure([regle({ ruleKey: "PAIRE:a/à" })]);
    expect(choisirTendance(m, ["PAIRE:on/ont"])).toBeNull();
    expect(choisirTendance(m, [])).toBeNull();
  });

  it("ne dit rien quand la règle ne progresse pas : jamais de constat d'échec", () => {
    const stable = regle({
      ruleKey: "A",
      evolution: 0,
      depuis: { textes: 8, mots: 1500, fautes: 7, taux: 5 },
    });
    const hausse = regle({
      ruleKey: "B",
      evolution: 40,
      depuis: { textes: 8, mots: 1500, fautes: 10, taux: 7 },
    });
    expect(choisirTendance(mesure([stable, hausse]), ["A", "B"])).toBeNull();
  });

  it("ne dit rien tant que le volume est insuffisant", () => {
    const m = mesure([regle({ ruleKey: "A", suffisant: false, evolution: null })]);
    expect(choisirTendance(m, ["A"])).toBeNull();
  });

  it("ignore le groupe de comparaison (fautes de frappe)", () => {
    const m = mesure([], [regle({ ruleKey: "FR_SPELLING_RULE", groupe: "comparaison" })]);
    expect(choisirTendance(m, ["FR_SPELLING_RULE"])).toBeNull();
  });

  it("entre plusieurs règles du texte, retient la plus forte baisse", () => {
    const m = mesure([
      regle({ ruleKey: "A", evolution: -20 }),
      regle({
        ruleKey: "B",
        evolution: -70,
        depuis: { textes: 8, mots: 1500, fautes: 2, taux: 1.5 },
      }),
    ]);
    expect(choisirTendance(m, ["A", "B"])?.ruleKey).toBe("B");
  });
});
