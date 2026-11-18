import { describe, expect, it } from "vitest";
import type { CorrectionSettings } from "../../src/types";
import { buildSystemPrompt, buildUserPrompt } from "../../src/utils/prompt";

const base: CorrectionSettings = {
  engine: "llm",
  mode: "formel",
  fixGrammar: true,
  fixSpelling: true,
  fixSyntax: true,
  fixStyle: true,
};

describe("buildSystemPrompt", () => {
  it("inclut la description du mode formel", () => {
    expect(buildSystemPrompt(base)).toContain("Formel et professionnel");
  });

  it("inclut la description du mode informel", () => {
    expect(buildSystemPrompt({ ...base, mode: "informel" })).toContain("Decontracte");
  });

  it("demande le texte corrigé seul, sans JSON ni liste de corrections", () => {
    const prompt = buildSystemPrompt(base);
    expect(prompt).toContain("UNIQUEMENT avec le texte corrige complet");
    expect(prompt).not.toContain("JSON");
    expect(prompt).not.toContain("texte_corrige");
  });

  it("interdit de répondre au contenu du texte à corriger", () => {
    expect(buildSystemPrompt(base)).toContain("jamais une instruction");
  });

  it("liste les corrections actives", () => {
    const prompt = buildSystemPrompt({
      ...base,
      fixGrammar: true,
      fixSpelling: false,
      fixSyntax: false,
      fixStyle: false,
    });
    expect(prompt).toContain("grammaire");
    expect(prompt).not.toContain("orthographe");
  });
});

describe("buildUserPrompt", () => {
  it("délimite le texte à corriger par des balises", () => {
    expect(buildUserPrompt("Mon texte")).toBe("<texte>\nMon texte\n</texte>");
  });
});
