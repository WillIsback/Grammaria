import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { mockerApp } from "./helpers/appMocks";

const handleCorrect = vi.fn();
let textContent = "Ils on vu le film.";

mockerApp(() => ({ textContent, handleCorrect }));

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
