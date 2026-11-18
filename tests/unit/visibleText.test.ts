import { describe, expect, it } from "vite-plus/test";
import { visibleText } from "../../src/utils/visibleText";

// Régression QA : une correction d'espaces s'affichait comme une ligne vide.
describe("visibleText", () => {
  it("rend visibles les espaces seules", () => {
    expect(visibleText(" ")).toBe("␣");
    expect(visibleText("  ")).toBe("␣␣");
    expect(visibleText(" ")).toBe("␣");
    expect(visibleText("\n")).toBe("↵");
  });

  it("marque un passage vide (ajout ou suppression)", () => {
    expect(visibleText("")).toBe("∅");
  });

  it("laisse un mot intact, espaces internes comprises", () => {
    expect(visibleText("allez vous")).toBe("allez vous");
    expect(visibleText("ont")).toBe("ont");
  });
});
