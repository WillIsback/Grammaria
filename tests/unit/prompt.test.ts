import { describe, expect, it } from "vite-plus/test";
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
    expect(prompt).toContain("Corrections actives: grammaire.");
    expect(prompt).toContain("N'interviens pas sur: orthographe, syntaxe, style.");
  });

  // Régression QA : style décoché, le modèle reformulait encore « on va » en
  // « nous allons ». La consigne de conservation n'apparaît que dans ce cas.
  it("style décoché : impose de garder les tournures et le registre", () => {
    const prompt = buildSystemPrompt({ ...base, fixStyle: false });
    expect(prompt).toContain("Le style n'est PAS a corriger");
    expect(prompt).toContain("« on » reste « on »");
  });

  it("style coché : pas de consigne de conservation", () => {
    expect(buildSystemPrompt(base)).not.toContain("Le style n'est PAS a corriger");
  });

  it("mode informel : garde les tournures familières", () => {
    expect(buildSystemPrompt({ ...base, mode: "informel" })).toContain("« on »");
  });

  it("toutes les cases cochées : pas de liste d'exclusion", () => {
    expect(buildSystemPrompt(base)).not.toContain("N'interviens pas sur");
  });

  it("demande de conserver la typographie et les noms propres", () => {
    expect(buildSystemPrompt(base)).toContain("noms propres");
  });
});

describe("buildUserPrompt", () => {
  it("délimite le texte à corriger par des balises", () => {
    expect(buildUserPrompt("Mon texte")).toBe("<texte>\nMon texte\n</texte>");
  });
});
