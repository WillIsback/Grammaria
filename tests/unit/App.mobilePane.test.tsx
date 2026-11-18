import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";

const handleCorrect = vi.fn();
let textContent = "Ils on vu le film.";

vi.mock("../../src/hooks/useCorrector", () => ({
  useCorrector: () => ({
    textContent,
    setTextContent: vi.fn(),
    outputText: "",
    corrections: [],
    analysis: null,
    analysisNotice: null,
    settings: {
      engine: "llm",
      mode: "formel",
      fixGrammar: true,
      fixSpelling: true,
      fixSyntax: true,
      fixStyle: true,
    },
    setSettings: vi.fn(),
    isLoading: false,
    isLoadingCorrections: false,
    error: null,
    stats: { processingTime: 0, modificationCount: 0 },
    handleCorrect,
    handleReset: vi.fn(),
  }),
}));
vi.mock("../../src/hooks/useLanguageTool", () => ({
  useLanguageTool: () => ({ isAvailable: true, isChecking: false }),
}));
vi.mock("../../src/utils/models", () => ({
  initModel: vi.fn(),
  getCurrentModel: () => "m",
  setCurrentModel: vi.fn(),
  subscribeToModelChange: () => () => {},
  fetchModels: vi.fn().mockResolvedValue([]),
}));

const { default: App } = await import("../../src/App");

function tab(name: string) {
  return screen.getByRole("button", { name, pressed: undefined });
}

// Régression QA : sur mobile, après « Corriger », l'écran restait sur le
// texte saisi ; le résultat et le bouton Copier n'apparaissaient qu'en
// touchant l'onglet « Résultat ».
describe("App — panneau mobile", () => {
  it("affiche le résultat dès le lancement de la correction", () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    textContent = "Ils on vu le film.";
    render(<App />);
    expect(tab("Texte").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /^Corriger$/ }));
    expect(handleCorrect).toHaveBeenCalled();
    expect(tab("Résultat").getAttribute("aria-pressed")).toBe("true");
  });

  it("reste sur le texte quand il est vide (le message d'erreur s'affiche)", () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    textContent = "   ";
    render(<App />);
    const corriger = screen.getByRole("button", { name: /^Corriger$/ }) as HTMLButtonElement;
    if (!corriger.disabled) fireEvent.click(corriger);
    expect(tab("Texte").getAttribute("aria-pressed")).toBe("true");
  });
});
