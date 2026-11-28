import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import type { QuestionRevision } from "../../src/analysis/regles/revision";
import { RevisionQuestion } from "../../src/components/RevisionQuestion";

const QUESTION: QuestionRevision = {
  reviewId: 12,
  ruleKey: "PAIRE:on/ont",
  titre: "on / ont",
  explication: "Remplacez par « avaient ».",
  avant: "Les clients ",
  apres: " confirmé leur venue.",
  formes: [
    { texte: "on", correcte: false },
    { texte: "ont", correcte: true },
  ],
};

describe("RevisionQuestion (issue #62)", () => {
  it("affiche la phrase à trou et les deux formes, sans icône de copie", () => {
    render(<RevisionQuestion question={QUESTION} onAnswer={vi.fn()} />);
    const groupe = screen.getByRole("group", { name: /Question de révision/ });
    expect(groupe.textContent).toContain("Les clients ");
    expect(groupe.textContent).toContain(" confirmé leur venue.");
    expect(groupe.textContent).toContain("on / ont");
    expect(screen.getByRole("button", { name: "on" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "ont" })).toBeTruthy();
    expect(groupe.querySelector("svg")).toBeNull();
  });

  it("bonne réponse : la signale et félicite sobrement", () => {
    const onAnswer = vi.fn();
    render(<RevisionQuestion question={QUESTION} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole("button", { name: "ont" }));
    expect(onAnswer).toHaveBeenCalledWith(true);
    expect(screen.getByText(/Bonne réponse/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "ont" })).toBeNull();
  });

  it("mauvaise réponse : donne la bonne forme et l'explication de la fiche", () => {
    const onAnswer = vi.fn();
    render(<RevisionQuestion question={QUESTION} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole("button", { name: "on" }));
    expect(onAnswer).toHaveBeenCalledWith(false);
    const retour = screen.getByTestId("revision-retour");
    expect(retour.textContent).toContain("« ont »");
    expect(retour.textContent).toContain("Remplacez par « avaient ».");
  });

  it("n'enregistre qu'une réponse", () => {
    const onAnswer = vi.fn();
    render(<RevisionQuestion question={QUESTION} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole("button", { name: "ont" }));
    expect(onAnswer).toHaveBeenCalledTimes(1);
  });
});
