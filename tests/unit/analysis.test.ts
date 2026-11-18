import { describe, expect, it } from "vite-plus/test";
import { analyze, isCounted, sentenceAt } from "../../src/analysis/analyze";
import { countWords, diffHunks } from "../../src/analysis/diff";
import { detecterConfusion, FICHES } from "../../src/analysis/fiches";
import { noteSur20 } from "../../src/analysis/score";
import type { LTMatch } from "../../src/types";

function match(text: string, fragment: string, rule: Partial<LTMatch["rule"]> = {}): LTMatch {
  const offset = text.indexOf(fragment);
  if (offset < 0) throw new Error(`fragment introuvable: ${fragment}`);
  return {
    message: `Message pour ${fragment}`,
    shortMessage: "",
    offset,
    length: fragment.length,
    replacements: [],
    rule: {
      id: "REGLE_TEST",
      issueType: "grammar",
      category: { id: "CAT_GRAMMAIRE", name: "Grammaire" },
      ...rule,
    },
  };
}

describe("diffHunks", () => {
  it("isole chaque mot modifié avec sa position d'origine", () => {
    const original = "Hier j'ai manger des pomme.";
    const hunks = diffHunks(original, "Hier j'ai mangé des pommes.");
    expect(hunks.map((h) => [h.before, h.after])).toEqual([
      ["manger", "mangé"],
      ["pomme", "pommes"],
    ]);
    for (const h of hunks) expect(original.slice(h.start, h.end)).toBe(h.before);
  });

  it("ne renvoie rien pour deux textes identiques", () => {
    expect(diffHunks("Tout va bien.", "Tout va bien.")).toEqual([]);
  });

  it("garde les mots à apostrophe entiers", () => {
    const hunks = diffHunks("Il c'est levé.", "Il s'est levé.");
    expect(hunks.map((h) => [h.before, h.after])).toEqual([["c'est", "s'est"]]);
  });

  it("représente une insertion par un passage vide", () => {
    const [hunk] = diffHunks("Je pense que oui", "Je pense que oui.");
    expect(hunk).toMatchObject({ before: "", after: ".", start: 16, end: 16 });
  });
});

describe("countWords", () => {
  it("compte les mots sans la ponctuation", () => {
    expect(countWords("Bonjour, j'ai 2 chats !")).toBe(4);
  });
});

describe("detecterConfusion", () => {
  it.each([
    ["a", "à", "PAIRE:a/à"],
    ["à", "a", "PAIRE:a/à"],
    ["Sa", "Ça", "PAIRE:sa/ça"],
    ["on", "ont", "PAIRE:on/ont"],
    ["peux", "peut", "PAIRE:peu/peut/peux"],
    ["c’est", "s'est", "PAIRE:c'est/s'est"],
    ["manger", "mangé", "TERMINAISON:er/é"],
    ["envoyé", "envoyer", "TERMINAISON:er/é"],
    ["mangez", "mangées", "TERMINAISON:er/é"],
  ])("%s → %s donne %s", (avant, apres, cle) => {
    expect(detecterConfusion(avant, apres)).toBe(cle);
    expect(FICHES[cle]).toBeDefined();
  });

  it.each([
    ["mangé", "mangée"],
    ["pomme", "pommes"],
    ["a", "a"],
    ["er", "é"],
    ["chat", "chien"],
  ])("%s → %s n'est pas une confusion connue", (avant, apres) => {
    expect(detecterConfusion(avant, apres)).toBeNull();
  });
});

describe("noteSur20", () => {
  it("vaut 20 sans faute", () => {
    expect(noteSur20(0, 50)).toBe(20);
  });

  it("retire 2 points par faute pour 100 mots", () => {
    expect(noteSur20(3, 100)).toBe(14);
    expect(noteSur20(1, 200)).toBe(19);
  });

  it("ne descend pas sous zéro", () => {
    expect(noteSur20(5, 10)).toBe(0);
  });

  it("n'a pas de valeur pour un texte vide", () => {
    expect(noteSur20(0, 0)).toBeNull();
  });
});

describe("isCounted", () => {
  const base = "x";
  it("compte la grammaire et l'orthographe", () => {
    expect(isCounted(match(base, "x"))).toBe(true);
    expect(
      isCounted(
        match(base, "x", { issueType: "misspelling", category: { id: "TYPOS", name: "" } }),
      ),
    ).toBe(true);
  });

  it("écarte la typographie, la ponctuation et le style", () => {
    expect(isCounted(match(base, "x", { issueType: "typographical" }))).toBe(false);
    expect(isCounted(match(base, "x", { issueType: "style" }))).toBe(false);
    expect(
      isCounted(
        match(base, "x", {
          issueType: "uncategorized",
          category: { id: "CAT_TYPOGRAPHIE", name: "" },
        }),
      ),
    ).toBe(false);
  });
});

describe("sentenceAt", () => {
  it("extrait la phrase qui contient la position", () => {
    const text = "Bonjour. Ils on vu le film. Merci.";
    expect(sentenceAt(text, text.indexOf("Ils on") + 4)).toBe("Ils on vu le film.");
  });
});

describe("analyze", () => {
  it("retient une détection LanguageTool que le correcteur a corrigée", () => {
    const original = "Je vous envoie les dossier demain.";
    const result = analyze(original, "Je vous envoie les dossiers demain.", [
      match(original, "dossier", { id: "ACCORD_NOMBRE" }),
    ]);

    expect(result.corrections).toHaveLength(1);
    expect(result.corrections[0].faults[0]).toMatchObject({
      ruleKey: "ACCORD_NOMBRE",
      source: "lt",
      word: "dossier",
      replacement: "dossiers",
      sentence: original,
      counted: true,
    });
    expect(result.faultCount).toBe(1);
    expect(result.unclassifiedCount).toBe(0);
    expect(result.wordCount).toBe(6);
    expect(result.score).toBe(noteSur20(1, 6));
  });

  it("écarte une détection LanguageTool que le correcteur n'a pas touchée", () => {
    const original = "Le projet Noota avance bien.";
    const result = analyze(original, original, [match(original, "Noota")]);
    expect(result.corrections).toEqual([]);
    expect(result.faultCount).toBe(0);
    expect(result.score).toBe(20);
  });

  it("garde visible mais ne compte pas une modification sans détection", () => {
    const result = analyze("Le truc marche bien.", "Le dispositif fonctionne bien.", []);
    expect(result.unclassifiedCount).toBeGreaterThan(0);
    expect(result.faultCount).toBe(0);
    expect(result.corrections.every((c) => c.faults.length === 0)).toBe(true);
  });

  it("reconnaît une confusion connue même sans LanguageTool et joint sa fiche", () => {
    const result = analyze("Il a aller a la plage.", "Il a aller à la plage.", []);
    expect(result.corrections).toHaveLength(1);
    expect(result.corrections[0].fiche).toBe(FICHES["PAIRE:a/à"]);
    expect(result.corrections[0].faults[0]).toMatchObject({
      ruleKey: "PAIRE:a/à",
      source: "fiche",
      counted: true,
    });
    expect(result.faultCount).toBe(1);
  });

  it("ne compte pas deux fois une confusion aussi signalée par LanguageTool", () => {
    const original = "Ils on vu le film.";
    const result = analyze(original, "Ils ont vu le film.", [match(original, "on")]);
    expect(result.corrections[0].faults).toHaveLength(1);
    expect(result.corrections[0].faults[0].ruleKey).toBe("PAIRE:on/ont");
    expect(result.faultCount).toBe(1);
  });

  it("affiche la typographie sans la compter dans la note", () => {
    const original = "Vraiment?";
    const result = analyze(original, "Vraiment ?", [
      match(original, "?", { id: "ESPACE", issueType: "typographical" }),
    ]);
    expect(result.faultCount).toBe(0);
    expect(result.score).toBe(20);
  });

  it("ignore les différences d'espaces en bordure", () => {
    const result = analyze("  Bonjour à tous.\n", "Bonjour à tous.", []);
    expect(result.corrections).toEqual([]);
    expect(result.unclassifiedCount).toBe(0);
  });
});
