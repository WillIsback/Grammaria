import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import type { InterventionAstuce, InterventionChoix } from "../../src/analysis/regles/intervention";
import { Output } from "../../src/components/Output";

const TEXTE = "Hier, ils ont mangé tous les gâteaux.";

const CHOIX: InterventionChoix = {
  type: "choix",
  choiceId: 42,
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
    expect(p.onChoiceAnswer).toHaveBeenCalledWith(42, true);
    expect(screen.getByRole("status").textContent).toContain("Bonne réponse : « ont ».");
    expect(screen.queryByTestId("intervention-explication")).toBeNull();
  });

  it("affiche l'explication puis copie quand même sur la mauvaise forme", () => {
    const p = props({ actionsInHeader, intervention: CHOIX, onChoiceAnswer: vi.fn() });
    render(<Output {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Copier avec « on »" }));

    expect(p.onCopy).toHaveBeenCalledTimes(1);
    expect(p.onCopy).toHaveBeenCalledWith(TEXTE);
    expect(p.onChoiceAnswer).toHaveBeenCalledWith(42, false);
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

    // Nouvelle correction : le résultat se vide, puis le texte et l'analyse arrivent.
    rerender(<Output {...props({ actionsInHeader, outputText: "" })} />);
    rerender(<Output {...props({ actionsInHeader })} />);
    rerender(<Output {...props({ actionsInHeader, intervention: { ...CHOIX, choiceId: 43 } })} />);
    expect(screen.queryByRole("group")).not.toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Quelle forme est la bonne ?");
  });

  it("relie le groupe des deux formes à la question", () => {
    render(<Output {...props({ actionsInHeader, intervention: CHOIX })} />);
    const groupe = screen.getByRole("group");
    const question = screen.getByTestId("intervention-choix");
    expect(question.id).not.toBe("");
    expect(groupe.getAttribute("aria-describedby")).toBe(question.id);
  });

  it("donne le focus au groupe quand les formes remplacent un bouton Copier qui l'avait", () => {
    const { rerender } = render(<Output {...props({ actionsInHeader })} />);
    screen.getByRole("button", { name: "Copier" }).focus();

    rerender(<Output {...props({ actionsInHeader, intervention: CHOIX })} />);
    const groupe = screen.getByRole("group");
    // Le groupe, et non l'une des formes : Entrée ne répond pas par mégarde.
    expect(document.activeElement).toBe(groupe);
    expect(groupe.getAttribute("tabindex")).toBe("-1");
  });

  it("ne déplace pas le focus quand le bouton Copier ne l'avait pas", () => {
    const { rerender } = render(<Output {...props({ actionsInHeader })} />);
    rerender(<Output {...props({ actionsInHeader, intervention: CHOIX })} />);
    expect(screen.queryByRole("group")).not.toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it("ne remplace pas le bouton Copier sous le pointeur", () => {
    const p = props({ actionsInHeader, onChoiceAnswer: vi.fn() });
    const { rerender } = render(<Output {...p} />);
    fireEvent.pointerEnter(screen.getByRole("button", { name: "Copier" }));

    rerender(<Output {...p} intervention={CHOIX} />);
    expect(screen.queryByRole("group")).toBeNull();
    // Le choix n'est pas proposé cette fois ; l'explication reste lisible.
    expect(screen.getByRole("status").textContent).toContain(
      "Astuce · on / ont — Remplacez par « avaient ».",
    );
    fireEvent.click(screen.getByRole("button", { name: "Copier" }));
    expect(p.onCopy).toHaveBeenCalledWith(TEXTE);
    expect(p.onChoiceAnswer).not.toHaveBeenCalled();

    // Le pointeur s'éloigne : la décision ne change pas pour ce texte.
    fireEvent.pointerLeave(screen.getByRole("button", { name: "Copier" }));
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("propose le choix quand le pointeur a quitté le bouton Copier", () => {
    const { rerender } = render(<Output {...props({ actionsInHeader })} />);
    const copier = screen.getByRole("button", { name: "Copier" });
    fireEvent.pointerEnter(copier);
    fireEvent.pointerLeave(copier);
    rerender(<Output {...props({ actionsInHeader, intervention: CHOIX })} />);
    expect(screen.queryByRole("group")).not.toBeNull();
  });

  it("ne propose pas le choix quand le texte a déjà été copié", () => {
    const p = props({ actionsInHeader });
    const { rerender } = render(<Output {...p} />);
    // Copie pendant l'analyse, avant l'arrivée de l'intervention.
    fireEvent.click(screen.getByRole("button", { name: "Copier" }));

    rerender(<Output {...p} intervention={CHOIX} />);
    expect(screen.queryByRole("group")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copier" })).not.toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Astuce · on / ont");
  });

  describe("mot masqué pendant le choix (issue #59)", () => {
    const MASQUE = { start: TEXTE.indexOf("ont"), end: TEXTE.indexOf("ont") + 3 };
    const CHOIX_MASQUE: InterventionChoix = { ...CHOIX, masque: MASQUE };
    const resultat = () => screen.getByTestId("texte-corrige");

    it("remplace le mot par un blanc tant que le choix attend une réponse", () => {
      render(<Output {...props({ actionsInHeader, intervention: CHOIX_MASQUE })} />);
      expect(resultat().textContent).not.toContain("ont");
      expect(resultat().textContent).toContain("Hier, ils ");
      expect(resultat().textContent).toContain(" mangé tous les gâteaux.");
      expect(within(resultat()).getByLabelText("mot masqué")).toBeTruthy();
    });

    it("révèle le mot, mis en évidence, après une bonne réponse", () => {
      render(<Output {...props({ actionsInHeader, intervention: CHOIX_MASQUE })} />);
      fireEvent.click(screen.getByRole("button", { name: "Copier avec « ont »" }));
      expect(resultat().textContent).toBe(TEXTE);
      expect(resultat().querySelector("mark")?.textContent).toBe("ont");
    });

    it("révèle aussi le mot après une mauvaise réponse", () => {
      render(<Output {...props({ actionsInHeader, intervention: CHOIX_MASQUE })} />);
      fireEvent.click(screen.getByRole("button", { name: "Copier avec « on »" }));
      expect(resultat().textContent).toBe(TEXTE);
      expect(resultat().querySelector("mark")?.textContent).toBe("ont");
    });

    it("copie toujours le texte complet", () => {
      const p = props({ actionsInHeader, intervention: CHOIX_MASQUE });
      render(<Output {...p} />);
      fireEvent.click(screen.getByRole("button", { name: "Copier avec « on »" }));
      expect(p.onCopy).toHaveBeenCalledWith(TEXTE);
    });

    it("ne masque rien quand le choix n'est pas proposé (texte déjà copié)", () => {
      const p = props({ actionsInHeader });
      const { rerender } = render(<Output {...p} />);
      fireEvent.click(screen.getByRole("button", { name: "Copier" }));
      rerender(<Output {...p} intervention={CHOIX_MASQUE} />);
      expect(resultat().textContent).toBe(TEXTE);
      expect(resultat().querySelector("mark")).toBeNull();
    });

    it("ne masque rien si la position ne désigne pas la bonne forme", () => {
      const faux: InterventionChoix = { ...CHOIX, masque: { start: 0, end: 3 } };
      render(<Output {...props({ actionsInHeader, intervention: faux })} />);
      expect(resultat().textContent).toBe(TEXTE);
    });

    it("ne masque rien sans position (ancien serveur)", () => {
      render(<Output {...props({ actionsInHeader, intervention: CHOIX })} />);
      expect(resultat().textContent).toBe(TEXTE);
    });
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
