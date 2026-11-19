import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import type { InterventionAstuce, InterventionChoix } from "../../src/analysis/regles/intervention";
import { Output } from "../../src/components/Output";

const TEXTE = "Hier, ils ont mangé tous les gâteaux.";

const CHOIX: InterventionChoix = {
  type: "choix",
  ruleKey: "PAIRE:on/ont",
  titre: "on / ont",
  explication: "Remplacez par « avaient ».",
  avant: "Hier, ils ",
  apres: " mangé tous les gâteaux.",
  formes: [
    { texte: "on", correcte: false },
    { texte: "ont", correcte: true },
  ],
};

const ASTUCE: InterventionAstuce = {
  type: "astuce",
  ruleKey: "PAIRE:on/ont",
  titre: "on / ont",
  texte: "Remplacez par « avaient ».",
};

function props(extra: Partial<ComponentProps<typeof Output>> = {}): ComponentProps<typeof Output> {
  return {
    outputText: TEXTE,
    corrections: [],
    stats: { processingTime: 12, modificationCount: 1 },
    onCopy: vi.fn(),
    onReset: vi.fn(),
    isLoading: false,
    ...extra,
  };
}

describe.each([
  ["en-tête du panneau (écran large)", true],
  ["bas de page (mobile)", false],
])("Output — interventions près du bouton Copier, %s", (_nom, actionsInHeader) => {
  it("garde le bouton Copier normal sans intervention", () => {
    const p = props({ actionsInHeader });
    render(<Output {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Copier" }));
    expect(p.onCopy).toHaveBeenCalledWith(TEXTE);
    expect(screen.getByRole("status").childElementCount).toBe(0);
  });

  it("remplace le bouton Copier par les deux formes", () => {
    render(<Output {...props({ actionsInHeader, intervention: CHOIX })} />);

    expect(screen.queryByRole("button", { name: "Copier" })).toBeNull();
    const groupe = screen.getByRole("group", { name: /choisissant la bonne forme/ });
    const boutons = within(groupe).getAllByRole("button");
    // L'ordre affiché est celui que le serveur a tiré.
    expect(boutons.map((b) => b.textContent)).toEqual(["on", "ont"]);
    expect(boutons.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Copier avec « on »",
      "Copier avec « ont »",
    ]);

    const question = screen.getByRole("status");
    expect(question.textContent).toContain("Quelle forme est la bonne ?");
    expect(question.textContent).toContain("Hier, ils");
    expect(question.textContent).toContain("mangé tous les gâteaux.");
  });

  it("copie le texte corrigé en un clic sur la bonne forme", () => {
    const p = props({ actionsInHeader, intervention: CHOIX, onChoiceAnswer: vi.fn() });
    render(<Output {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Copier avec « ont »" }));

    expect(p.onCopy).toHaveBeenCalledTimes(1);
    expect(p.onCopy).toHaveBeenCalledWith(TEXTE);
    expect(p.onChoiceAnswer).toHaveBeenCalledWith("PAIRE:on/ont", true);
    expect(screen.getByRole("status").textContent).toContain("Bonne réponse : « ont ».");
    expect(screen.queryByTestId("intervention-explication")).toBeNull();
  });

  it("affiche l'explication puis copie quand même sur la mauvaise forme", () => {
    const p = props({ actionsInHeader, intervention: CHOIX, onChoiceAnswer: vi.fn() });
    render(<Output {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Copier avec « on »" }));

    expect(p.onCopy).toHaveBeenCalledTimes(1);
    expect(p.onCopy).toHaveBeenCalledWith(TEXTE);
    expect(p.onChoiceAnswer).toHaveBeenCalledWith("PAIRE:on/ont", false);
    const statut = screen.getByRole("status");
    expect(statut.textContent).toContain("Il fallait écrire « ont », et non « on ».");
    expect(statut.textContent).toContain("Remplacez par « avaient ».");
    expect(statut.textContent).toContain("Le texte corrigé est copié.");
  });

  it("rend le bouton Copier, avec le focus clavier, une fois la forme choisie", () => {
    const p = props({ actionsInHeader, intervention: CHOIX });
    render(<Output {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Copier avec « on »" }));

    expect(screen.queryByRole("group")).toBeNull();
    const copier = screen.getByRole("button", { name: "Copier" });
    expect(document.activeElement).toBe(copier);
    fireEvent.click(copier);
    expect(p.onCopy).toHaveBeenCalledTimes(2);
  });

  it("propose de nouveau un choix pour le texte suivant", () => {
    const { rerender } = render(<Output {...props({ actionsInHeader, intervention: CHOIX })} />);
    fireEvent.click(screen.getByRole("button", { name: "Copier avec « ont »" }));
    expect(screen.queryByRole("group")).toBeNull();

    rerender(<Output {...props({ actionsInHeader, intervention: { ...CHOIX } })} />);
    expect(screen.queryByRole("group")).not.toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Quelle forme est la bonne ?");
  });

  it("affiche l'astuce d'une règle signalée sans toucher au bouton Copier", () => {
    const p = props({ actionsInHeader, intervention: ASTUCE });
    render(<Output {...p} />);
    expect(screen.getByRole("status").textContent).toContain(
      "Astuce · on / ont — Remplacez par « avaient ».",
    );
    fireEvent.click(screen.getByRole("button", { name: "Copier" }));
    expect(p.onCopy).toHaveBeenCalledWith(TEXTE);
  });

  it("annonce une règle acquise", () => {
    render(
      <Output
        {...props({ actionsInHeader, reussites: [{ ruleKey: "PAIRE:on/ont", titre: "on / ont" }] })}
      />,
    );
    const statut = screen.getByRole("status");
    expect(statut.textContent).toContain("Règle acquise : « on / ont ».");
    expect(statut.textContent).toContain("depuis 14 jours");
    expect(screen.queryByRole("button", { name: "Copier" })).not.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("regroupe plusieurs règles acquises et les affiche avec une astuce", () => {
    render(
      <Output
        {...props({
          actionsInHeader,
          intervention: ASTUCE,
          reussites: [
            { ruleKey: "PAIRE:a/à", titre: "a / à" },
            { ruleKey: "ACCORD", titre: "Accord" },
          ],
        })}
      />,
    );
    const statut = screen.getByRole("status");
    expect(statut.textContent).toContain("Règles acquises : « a / à », « Accord ».");
    expect(statut.textContent).toContain("Astuce · on / ont");
  });
});

describe("Output — pas de résultat", () => {
  it("n'affiche ni bouton ni message tant qu'aucun texte n'est corrigé", () => {
    render(<Output {...props({ outputText: "", intervention: CHOIX, actionsInHeader: true })} />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("button", { name: /Copier/ })).toBeNull();
  });
});
