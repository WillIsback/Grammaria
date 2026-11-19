import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { mockerApp } from "./helpers/appMocks";

mockerApp(() => ({ textContent: "Mon texte en cours" }));

const { default: App } = await import("../../src/App");

// Issue #15 : écran « Progression » ouvert depuis l'en-tête.
describe("App — écran Progression", () => {
  it("s'ouvre par le bouton de l'en-tête, à côté de Paramètres, et se referme par Retour", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    globalThis.fetch = vi.fn((url: string) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve(
            url === "/api/progress" ? { empty: true, weeks: 12 } : { editable: false },
          ),
      }),
    ) as unknown as typeof fetch;

    render(<App />);
    const bouton = screen.getByRole("button", { name: "Progression" });
    expect(bouton.nextElementSibling).toBe(screen.getByRole("button", { name: "Paramètres" }));
    expect(bouton.getAttribute("aria-pressed")).toBe("false");

    bouton.focus(); // un vrai clic donne le focus au bouton, pas fireEvent
    fireEvent.click(bouton);
    expect(await screen.findByRole("heading", { name: "Ma progression" })).toBeTruthy();
    expect(bouton.getAttribute("aria-pressed")).toBe("true");
    await screen.findByText("Aucun texte corrigé pour l'instant");

    // L'écran de correction, caché dessous, n'est plus atteignable au clavier.
    const zoneTexte = screen.getByDisplayValue("Mon texte en cours");
    const barre = screen.getByRole("complementary", { name: "Réglages de correction" });
    expect(zoneTexte.closest("[inert]")?.tagName).toBe("MAIN");
    expect(barre.hasAttribute("inert")).toBe(true);
    expect(bouton.closest("[inert]")).toBeNull();
    expect(screen.getByRole("heading", { name: "Ma progression" }).closest("[inert]")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Retour à la correction/ }));
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Ma progression" })).toBeNull(),
    );
    // Le texte en cours de correction est toujours là, et de nouveau atteignable.
    expect(screen.getByDisplayValue("Mon texte en cours")).toBeTruthy();
    expect(document.querySelector("[inert]")).toBeNull();
    expect(document.activeElement).toBe(bouton);
  });
});
