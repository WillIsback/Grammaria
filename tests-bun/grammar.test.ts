import { afterAll, describe, expect, it } from "bun:test";
import { GrammarChecker } from "../grammar.ts";
import { analyze } from "../src/analysis/analyze.ts";

// Moteur réel (règles françaises de LanguageTool portées en JavaScript) :
// plus aucun conteneur à lancer pour classer les fautes.
const checker = new GrammarChecker();
afterAll(() => checker.close());

// Le premier appel charge les règles (quelques secondes).
const LOAD_TIMEOUT_MS = 60_000;

describe("GrammarChecker", () => {
  it(
    "détecte les fautes au format LanguageTool",
    async () => {
      const text = "Les enfants était content. Il a manger une pomme.";
      const matches = await checker.check(text);

      const rules = matches.map((m) => m.rule.id);
      expect(rules).toContain("ACCORD_SUJET_VERBE");
      const manger = matches.find((m) => text.slice(m.offset, m.offset + m.length) === "manger");
      expect(manger?.replacements[0]?.value).toBe("mangé");
      expect(manger?.rule.category?.id).toBeTruthy();
    },
    LOAD_TIMEOUT_MS,
  );

  it("reconnaît une faute d'orthographe", async () => {
    const matches = await checker.check("J'ai mangé une pome.");
    expect(matches.some((m) => m.rule.issueType === "misspelling")).toBe(true);
  });

  it("ne signale rien sur un texte correct", async () => {
    expect(await checker.check("Les enfants étaient contents.")).toEqual([]);
  });

  it("alimente l'analyse : la faute corrigée est classée et comptée", async () => {
    const original = "Les enfants était content.";
    const corrected = "Les enfants étaient content.";
    const analysis = analyze(original, corrected, await checker.check(original));
    expect(analysis.corrections[0].faults[0]).toMatchObject({
      source: "lt",
      ruleKey: "ACCORD_SUJET_VERBE",
      counted: true,
    });
  });
});
