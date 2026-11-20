import { vi } from "vite-plus/test";
import type { useCorrector } from "../../../src/hooks/useCorrector";

type Correcteur = ReturnType<typeof useCorrector>;

/**
 * Remplace `useCorrector` et le module des modèles pour les tests de `App`.
 * `vi.doMock` n'est pas remonté en tête de fichier : appeler cette fonction
 * avant `await import("../../src/App")`. `surcharges` est relu à chaque rendu,
 * un test peut donc changer les valeurs qu'elle renvoie.
 */
export function mockerApp(surcharges: () => Partial<Correcteur> = () => ({})) {
  vi.doMock("../../../src/hooks/useCorrector", () => ({
    useCorrector: (): Correcteur => ({
      textContent: "",
      setTextContent: vi.fn(),
      outputText: "",
      corrections: [],
      analysis: null,
      analysisNotice: null,
      settings: {
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
      errorDetails: null,
      stats: { processingTime: 0, modificationCount: 0 },
      handleCorrect: vi.fn(),
      handleReset: vi.fn(),
      ...surcharges(),
    }),
  }));
  vi.doMock("../../../src/utils/models", () => ({
    initModel: vi.fn(),
    getCurrentModel: () => "m",
    setCurrentModel: vi.fn(),
    subscribeToModelChange: () => () => {},
    fetchModels: vi.fn().mockResolvedValue([]),
  }));
}
