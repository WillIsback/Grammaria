import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { mockerApp } from "./helpers/appMocks";

mockerApp();

const { default: App } = await import("../../src/App");

function serverSettings(configured: boolean, settingsUnreadable?: boolean) {
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
          ...(settingsUnreadable === undefined ? {} : { settingsUnreadable }),
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

  // Validation finale : un settings.json illisible faisait repartir l'application
  // comme au premier lancement, sans prévenir que réglages et clé étaient ignorés.
  it("settings.json illisible : Paramètres → IA s'ouvre avec un avertissement, levé après l'enregistrement", async () => {
    serverSettings(false, true);
    render(<App />);
    const dialog = await screen.findByRole("dialog", { name: "Paramètres" });
    expect(within(dialog).getByRole("alert").textContent).toBe(
      "Vos réglages n’ont pas pu être lus. Saisissez à nouveau l’adresse du modèle et la clé.",
    );
    // Réponse de Rust après l'écriture : le champ n'y est plus.
    serverSettings(true);
    fireEvent.change(within(dialog).getByLabelText("Adresse"), {
      target: { value: "http://gpu:8000" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Enregistrer" }));
    await within(dialog).findByText("Réglages enregistrés.");
    expect(within(dialog).queryByText(/n’ont pas pu être lus/)).toBeNull();
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
