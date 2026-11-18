import { describe, expect, it } from "vite-plus/test";
import { cleanLlmOutput } from "../../src/utils/llmText";

describe("cleanLlmOutput", () => {
  it("laisse intact un texte déjà propre", () => {
    expect(cleanLlmOutput("Bonjour à tous.\n\nCordialement,")).toBe(
      "Bonjour à tous.\n\nCordialement,",
    );
  });

  it("retire les balises de délimitation renvoyées par le modèle", () => {
    expect(cleanLlmOutput("<texte>\nBonjour.\n</texte>")).toBe("Bonjour.");
  });

  it("retire un bloc de réflexion, même inachevé pendant le streaming", () => {
    expect(cleanLlmOutput("<think>hmm</think>Bonjour.")).toBe("Bonjour.");
    expect(cleanLlmOutput("<think>je réfléchis enc")).toBe("");
  });

  it("retire une clôture de code", () => {
    expect(cleanLlmOutput("```\nBonjour.\n```")).toBe("Bonjour.");
  });
});
