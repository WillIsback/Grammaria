import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../src/hooks/useCorrector", () => ({
  useCorrector: () => ({
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
    stats: { processingTime: 0, modificationCount: 0 },
    handleCorrect: vi.fn(),
    handleReset: vi.fn(),
  }),
}));
vi.mock("../../src/utils/models", () => ({
  initModel: vi.fn(),
  getCurrentModel: () => "m",
  setCurrentModel: vi.fn(),
  subscribeToModelChange: () => () => {},
  fetchModels: vi.fn().mockResolvedValue([]),
}));

const { default: App } = await import("../../src/App");

function serverSettings(configured: boolean) {
  globalThis.fetch = vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          editable: true,
          configured,
          llmTarget: configured ? "http://gpu:8000" : "",
          llmModelName: "",
          llmDisableThinking: true,
          hasApiKey: false,
        }),
    }),
  ) as unknown as typeof fetch;
}

// Issue #12 : menu Paramètres → IA à côté du sélecteur de thème.
describe("App — menu Paramètres → IA", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
  });

  it("le bouton Paramètres, à côté du thème, ouvre la rubrique IA", async () => {
    serverSettings(true);
    render(<App />);
    expect(screen.queryByRole("dialog")).toBeNull();

    const prefs = screen.getByRole("button", { name: "Paramètres" });
    const theme = screen.getByRole("button", { name: /Passer en thème/ });
    expect(prefs.nextElementSibling).toBe(theme);

    fireEvent.click(prefs);
    const dialog = await screen.findByRole("dialog", { name: "Paramètres" });
    await waitFor(() =>
      expect(within(dialog).getByRole("form", { name: "Serveur du modèle" })).toBeTruthy(),
    );
  });

  it("la barre latérale ne contient plus le serveur ni le choix du modèle", async () => {
    serverSettings(true);
    render(<App />);
    const sidebar = screen.getByRole("complementary", { name: "Réglages de correction" });
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(within(sidebar).queryByText("Serveur du modèle")).toBeNull();
    expect(within(sidebar).queryByText("Modèle LLM")).toBeNull();
  });

  it("au premier lancement du bureau, Paramètres → IA s'ouvre tant qu'aucun modèle n'est configuré", async () => {
    serverSettings(false);
    render(<App />);
    const dialog = await screen.findByRole("dialog", { name: "Paramètres" });
    expect(within(dialog).getByText(/pour commencer/)).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  // Régression vue en QA : à l'enregistrement de l'adresse, le menu ouvert
  // d'office se fermait (modèle désormais configuré), empêchant de choisir le modèle.
  it("reste ouvert après l'enregistrement de l'adresse au premier lancement", async () => {
    serverSettings(false);
    render(<App />);
    const dialog = await screen.findByRole("dialog", { name: "Paramètres" });
    serverSettings(true);
    fireEvent.change(within(dialog).getByLabelText("Adresse"), {
      target: { value: "http://gpu:8000" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Enregistrer" }));
    await within(dialog).findByText("Réglages enregistrés.");
    expect(screen.getByRole("dialog", { name: "Paramètres" })).toBeTruthy();
  });
});
