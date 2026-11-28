import { describe, expect, it } from "vite-plus/test";
import { analyze } from "../../src/analysis/analyze";
import { detecteEmplois, reglesEmployees } from "../../src/analysis/regles/emplois";

const passages = (original: string, corrige: string) =>
  analyze(original, corrige, []).corrections.map((c) => ({ start: c.start, end: c.end }));

describe("reglesEmployees — emplois corrects d'une paire (issue #60)", () => {
  it("reconnaît les formes d'une paire laissées intactes par la correction", () => {
    const texte = "Il a mangé à la cantine.";
    expect(reglesEmployees(texte, [])).toEqual(["PAIRE:a/à", "PAIRE:la/là"]);
  });

  it("ne compte pas une forme que la correction a modifiée", () => {
    const original = "Ils on fini le dossier.";
    const corrige = "Ils ont fini le dossier.";
    expect(reglesEmployees(original, passages(original, corrige))).toEqual([]);
  });

  it("compte la règle si une autre occurrence est restée intacte", () => {
    const original = "Ils ont dit qu'ils on fini.";
    const corrige = "Ils ont dit qu'ils ont fini.";
    expect(reglesEmployees(original, passages(original, corrige))).toEqual(["PAIRE:on/ont"]);
  });

  it("ignore la casse et l'apostrophe typographique", () => {
    expect(reglesEmployees("C’est fini. Où vas-tu ?", [])).toEqual([
      "PAIRE:c'est/s'est",
      "PAIRE:ou/où",
    ]);
  });

  it("ne renvoie rien pour un texte sans forme de paire", () => {
    expect(reglesEmployees("Tout va bien aujourd'hui.", [])).toEqual([]);
    expect(reglesEmployees("", [])).toEqual([]);
  });

  it("ne confond pas un mot plus long avec une forme de paire", () => {
    expect(reglesEmployees("Laon, sont-ils partis ? Qu'on parte.", [])).toEqual([]);
  });
});

describe("detecteEmplois", () => {
  it("vaut pour les fiches de type paire seulement", () => {
    expect(detecteEmplois("PAIRE:a/à")).toBe(true);
    expect(detecteEmplois("TERMINAISON:er/é")).toBe(false);
    expect(detecteEmplois("ACCORD")).toBe(false);
  });
});
