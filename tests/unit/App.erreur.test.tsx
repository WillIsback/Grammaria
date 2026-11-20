import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { mockerApp } from "./helpers/appMocks";

let etat: { error: string | null; errorDetails: string | null } = {
  error: null,
  errorDetails: null,
};
const handleCorrect = vi.fn();
mockerApp(() => ({ ...etat, handleCorrect }));

const { default: App } = await import("../../src/App");

// Validation finale : le bandeau montrait « Le serveur de correction a échoué
// (HTTP 502) : … tcp connect error … ». Le message simple vient d'abord ; le
// détail technique est replié derrière « Détails ».
describe("App — bandeau d'erreur de correction", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
  });

  it("message simple en role=alert, détail replié, bouton Réessayer", () => {
    etat = {
      error:
        "Le modèle ne répond pas. Vérifiez son adresse dans Paramètres → IA, et qu'il est bien démarré.",
      errorDetails: "HTTP 502 : Liste des modèles indisponible : tcp connect error",
    };
    render(<App />);
    const alerte = screen.getByRole("alert");
    expect(alerte.textContent).toBe(etat.error);
    expect(alerte.textContent).not.toMatch(/tcp|HTTP/);

    const details = screen.getByText("Détails").closest("details")!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain("tcp connect error");

    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    expect(handleCorrect).toHaveBeenCalled();
  });

  it("sans détail technique : pas de « Détails »", () => {
    etat = { error: "Veuillez entrer du texte", errorDetails: null };
    render(<App />);
    expect(screen.getByRole("alert").textContent).toBe("Veuillez entrer du texte");
    expect(screen.queryByText("Détails")).toBeNull();
  });
});
