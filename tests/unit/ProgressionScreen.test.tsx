import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { calculerProgression, type Progression } from "../../src/analysis/progression/calcul";
import { ProgressionScreen } from "../../src/components/progression/ProgressionScreen";

const NOW = new Date(2026, 10, 19, 15).getTime();
const jour = (n: number) => new Date(2026, 10, 16 + n, 12).getTime();

function rempli(): Progression {
  const texts = Array.from({ length: 30 }, (_, i) => ({
    at: jour(-i * 2),
    words: 120,
    faults: i % 3,
  }));
  const S = "FR_SPELLING_RULE";
  const faute = (at: number, ruleKey: string, word = "", replacement = "") => ({
    at,
    ruleKey,
    word,
    replacement,
    message: "",
    categoryName: "Grammaire",
  });
  const rules = [
    {
      ruleKey: "PAIRE:on/ont",
      label: "on / ont",
      categoryName: "Confusion de mots",
      state: "travaillee" as const,
      stateSince: jour(-5),
      occurrences: 7,
      lastFaultAt: jour(-2),
      acquiredAt: null,
    },
    {
      ruleKey: "PAIRE:a/à",
      label: "a / à",
      categoryName: "Confusion de mots",
      state: "acquise" as const,
      stateSince: jour(-1),
      occurrences: 4,
      lastFaultAt: jour(-20),
      acquiredAt: jour(-1),
    },
  ];
  return calculerProgression(
    {
      texts,
      faults: [
        faute(jour(-1), "PAIRE:on/ont"),
        faute(jour(-2), "PAIRE:on/ont"),
        faute(jour(-3), S, "apareil", "appareil"),
      ],
      rules,
    },
    NOW,
  );
}

const vide = () => calculerProgression({ texts: [], faults: [], rules: [] }, NOW);

describe("ProgressionScreen", () => {
  it("affiche le score de maîtrise, les graphiques accessibles, les règles et les mots pièges", async () => {
    const data = rempli();
    render(<ProgressionScreen onClose={vi.fn()} load={() => Promise.resolve(data)} />);

    const maitrise = await screen.findByRole("region", { name: "Score de maîtrise" });
    expect(data.mastery.score).not.toBeNull();
    expect(within(maitrise).getByText(new RegExp(`${data.mastery.score} sur 100`))).toBeTruthy();
    expect(within(maitrise).getByText(/Écrire plus ne le fait jamais baisser/)).toBeTruthy();

    // Graphiques : titre et description, valeurs en tableau.
    const graphique = screen.getByRole("img", { name: /Note moyenne sur 20, par semaine/ });
    expect(graphique.querySelector("desc")?.textContent).toMatch(/semaines avec des textes/);
    expect(screen.getAllByRole("table")).toHaveLength(2);

    const regles = screen.getByRole("region", { name: "Vos règles" });
    expect(within(regles).getByText("on / ont")).toBeTruthy();
    expect(within(regles).getByText("a / à")).toBeTruthy();
    expect(within(regles).getByText("Travaillées")).toBeTruthy();

    const mots = screen.getByRole("region", { name: "Mots pièges" });
    expect(within(mots).getByText("apareil")).toBeTruthy();
    expect(within(mots).getByText("appareil")).toBeTruthy();

    // Pas de galerie de badges tant qu'elle n'est pas fournie.
    expect(screen.queryByRole("region", { name: "Badges" })).toBeNull();
  });

  it("affiche « pas encore assez de textes » plutôt qu'un chiffre trompeur", async () => {
    const data = calculerProgression(
      { texts: [{ at: jour(0), words: 40, faults: 1 }], faults: [], rules: [] },
      NOW,
    );
    render(<ProgressionScreen onClose={vi.fn()} load={() => Promise.resolve(data)} />);
    const maitrise = await screen.findByRole("region", { name: "Score de maîtrise" });
    expect(within(maitrise).getByText("Pas encore assez de textes")).toBeTruthy();
    expect(within(maitrise).queryByText(/sur 100/)).toBeNull();
    expect(within(maitrise).getAllByRole("progressbar")).toHaveLength(2);
  });

  it("journal vide : explique et invite à corriger un premier texte", async () => {
    const onClose = vi.fn();
    render(<ProgressionScreen onClose={onClose} load={() => Promise.resolve(vide())} />);
    expect(await screen.findByText("Aucun texte corrigé pour l'instant")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Corriger un premier texte" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("rend la galerie de badges dans sa propre section quand elle est fournie", async () => {
    render(
      <ProgressionScreen
        onClose={vi.fn()}
        load={() => Promise.resolve(rempli())}
        badges={<p>Galerie</p>}
      />,
    );
    const badges = await screen.findByTestId("progression-badges");
    expect(within(badges).getByText("Galerie")).toBeTruthy();
  });

  it("revient à la correction par le bouton Retour ou la touche Échap", async () => {
    const onClose = vi.fn();
    render(<ProgressionScreen onClose={onClose} load={() => Promise.resolve(vide())} />);
    expect(document.activeElement?.textContent).toBe("Ma progression");
    fireEvent.click(screen.getByRole("button", { name: /Retour à la correction/ }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("propose de réessayer quand le chargement échoue", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("hors ligne"))
      .mockResolvedValueOnce(vide());
    render(<ProgressionScreen onClose={vi.fn()} load={load} />);
    const alerte = await screen.findByRole("alert");
    fireEvent.click(within(alerte).getByRole("button", { name: "Réessayer" }));
    await waitFor(() =>
      expect(screen.getByText("Aucun texte corrigé pour l'instant")).toBeTruthy(),
    );
  });

  it("charge les données depuis GET /api/progress par défaut", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(vide()) }),
    ) as unknown as typeof fetch;
    render(<ProgressionScreen onClose={vi.fn()} />);
    await screen.findByText("Aucun texte corrigé pour l'instant");
    expect(vi.mocked(globalThis.fetch).mock.calls[0][0]).toBe("/api/progress");
  });
});
