import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { SettingsDialog } from "../../src/components/SettingsDialog";
import type { ServerSettings } from "../../src/services/settings";

vi.mock("../../src/utils/models", () => ({
  getCurrentModel: () => "qwen3",
  setCurrentModel: vi.fn(),
  subscribeToModelChange: () => () => {},
  fetchModels: vi
    .fn()
    .mockResolvedValue([{ id: "qwen3", object: "model", created: 0, owned_by: "x" }]),
}));

const desktop: ServerSettings = {
  editable: true,
  configured: true,
  llmTarget: "http://gpu:8000",
  llmModelName: "",
  llmDisableThinking: true,
  hasApiKey: false,
};

function renderDialog(props: Partial<Parameters<typeof SettingsDialog>[0]> = {}) {
  const onClose = vi.fn();
  render(
    <SettingsDialog
      open
      onClose={onClose}
      serverSettings={desktop}
      onServerSettingsSaved={vi.fn()}
      modelsReloadKey={0}
      {...props}
    />,
  );
  return onClose;
}

// Issue #12 : serveur et choix du modèle regroupés dans Paramètres → IA.
describe("SettingsDialog — Paramètres → IA", () => {
  it("regroupe le serveur du modèle et le choix du modèle (bureau)", async () => {
    renderDialog();
    expect(screen.getByRole("dialog", { name: "Paramètres" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "IA" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("form", { name: "Serveur du modèle" })).toBeTruthy();
    expect(await screen.findByText("Modèle LLM")).toBeTruthy();
  });

  it("sur un serveur web, n'affiche que le choix du modèle", async () => {
    renderDialog({ serverSettings: { ...desktop, editable: false } });
    expect(screen.queryByRole("form", { name: "Serveur du modèle" })).toBeNull();
    expect(await screen.findByText("Modèle LLM")).toBeTruthy();
  });

  // Validation finale : au premier lancement, « Impossible de charger la liste
  // des modèles — Réessayer » s'affichait en rouge avant toute saisie.
  it("premier lancement du bureau : texte neutre, ni erreur ni requête de la liste", async () => {
    const { fetchModels } = await import("../../src/utils/models");
    vi.mocked(fetchModels).mockClear();
    renderDialog({ serverSettings: { ...desktop, configured: false, llmTarget: "" } });
    const info = screen.getByText("Indiquez d’abord l’adresse du modèle ci-dessus.");
    expect(info.getAttribute("role")).toBe("status");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/Impossible de charger/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Réessayer" })).toBeNull();
    expect(fetchModels).not.toHaveBeenCalled();
  });

  it("après l'enregistrement de l'adresse, la liste des modèles est chargée", async () => {
    const { fetchModels } = await import("../../src/utils/models");
    vi.mocked(fetchModels).mockClear();
    const props = {
      open: true,
      onClose: vi.fn(),
      onServerSettingsSaved: vi.fn(),
    };
    const { rerender } = render(
      <SettingsDialog
        {...props}
        serverSettings={{ ...desktop, configured: false, llmTarget: "" }}
        modelsReloadKey={0}
      />,
    );
    expect(fetchModels).not.toHaveBeenCalled();
    rerender(<SettingsDialog {...props} serverSettings={desktop} modelsReloadKey={1} />);
    expect(await screen.findByText("qwen3")).toBeTruthy();
    expect(screen.queryByText(/Indiquez d’abord/)).toBeNull();
  });

  it("serveur web : la liste est demandée et son échec reste signalé (role=alert)", async () => {
    const { fetchModels } = await import("../../src/utils/models");
    vi.mocked(fetchModels).mockRejectedValueOnce(new Error("HTTP 502"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    renderDialog({ serverSettings: { ...desktop, editable: false, configured: false } });
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Impossible de charger la liste des modèles",
    );
    expect(screen.getByRole("button", { name: "Réessayer" })).toBeTruthy();
    expect(screen.queryByText(/Indiquez d’abord/)).toBeNull();
  });

  it("se ferme par le bouton, par Échap et par un clic à l'extérieur", () => {
    const onClose = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Fermer les paramètres" }));
    fireEvent.keyDown(window, { key: "Escape" });
    const overlay = document.querySelector('[aria-hidden="true"].absolute') as HTMLElement;
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("n'affiche rien quand il est fermé", () => {
    render(
      <SettingsDialog
        open={false}
        onClose={vi.fn()}
        serverSettings={desktop}
        onServerSettingsSaved={vi.fn()}
        modelsReloadKey={0}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
