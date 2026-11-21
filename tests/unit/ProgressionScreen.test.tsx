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
  const faute = (at: number, ruleKey: string) => ({
    at,
    ruleKey,
    label: null,
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
        faute(jour(-3), "FR_SPELLING_RULE"),
      ],
      rules,
    },
    NOW,
  );
}

const vide = () => calculerProgression({ texts: [], faults: [], rules: [] }, NOW);

/**
 * Simule `GET /api/progress` : une réponse par appel, dans l'ordre (la dernière
 * est répétée) ; une Error fait échouer l'appel comme une coupure réseau.
 */
function servir(...reponses: (Progression | Error)[]) {
  let appel = 0;
  const mock = vi.fn((_url: string, _init?: RequestInit) => {
    const r = reponses[Math.min(appel++, reponses.length - 1)];
    return r instanceof Error
      ? Promise.reject(r)
      : Promise.resolve(new Response(JSON.stringify(r), { status: 200 }));
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

describe("ProgressionScreen", () => {
  it("affiche le score de maîtrise, les graphiques accessibles et les règles", async () => {
    const data = rempli();
    servir(data);
    render(<ProgressionScreen onClose={vi.fn()} />);

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

    const frequentes = screen.getByRole("region", { name: "Règles les plus fréquentes" });
    expect(within(frequentes).getByText("on / ont")).toBeTruthy();
    // Aucun mot de l'utilisateur n'est affiché : plus de « Mots pièges » (#32).
    expect(screen.queryByRole("region", { name: "Mots pièges" })).toBeNull();

    // Pas de galerie de badges tant qu'elle n'est pas fournie.
    expect(screen.queryByRole("region", { name: "Badges" })).toBeNull();
  });

  it("affiche « pas encore assez de textes » plutôt qu'un chiffre trompeur", async () => {
    const data = calculerProgression(
      { texts: [{ at: jour(0), words: 40, faults: 1 }], faults: [], rules: [] },
      NOW,
    );
    servir(data);
    render(<ProgressionScreen onClose={vi.fn()} />);
    const maitrise = await screen.findByRole("region", { name: "Score de maîtrise" });
    expect(within(maitrise).getByText("Pas encore assez de textes")).toBeTruthy();
    expect(within(maitrise).queryByText(/sur 100/)).toBeNull();
    expect(within(maitrise).getAllByRole("progressbar")).toHaveLength(2);
  });

  it("journal vide : explique et invite à corriger un premier texte", async () => {
    const onClose = vi.fn();
    servir(vide());
    render(<ProgressionScreen onClose={onClose} />);
    expect(await screen.findByText("Aucun texte corrigé pour l'instant")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Corriger un premier texte" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("rend la galerie de badges dans sa propre section quand elle est fournie", async () => {
    servir(rempli());
    render(<ProgressionScreen onClose={vi.fn()} badges={<p>Galerie</p>} />);
    const badges = await screen.findByTestId("progression-badges");
    expect(within(badges).getByText("Galerie")).toBeTruthy();
    // Pas de cadre autour de la galerie : chaque badge est déjà une carte.
    expect(badges.className).not.toContain("border");
  });

  it("se recharge quand le journal change, sans repasser par « Chargement »", async () => {
    const fetch = servir(rempli(), vide());
    const { rerender } = render(<ProgressionScreen onClose={vi.fn()} reloadKey={0} />);
    await screen.findByText("Score de maîtrise");
    rerender(<ProgressionScreen onClose={vi.fn()} reloadKey={1} />);
    expect(screen.queryByText("Chargement de votre progression…")).toBeNull();
    await screen.findByText("Aucun texte corrigé pour l'instant");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("commence sous l'en-tête, à la hauteur indiquée", async () => {
    servir(vide());
    const { container } = render(<ProgressionScreen onClose={vi.fn()} top={110} />);
    await screen.findByText("Aucun texte corrigé pour l'instant");
    expect((container.firstElementChild as HTMLElement).style.top).toBe("110px");
  });

  it("revient à la correction par le bouton Retour ou la touche Échap", async () => {
    const onClose = vi.fn();
    servir(vide());
    render(<ProgressionScreen onClose={onClose} />);
    expect(document.activeElement?.textContent).toBe("Ma progression");
    fireEvent.click(screen.getByRole("button", { name: /Retour à la correction/ }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("propose de réessayer quand le chargement échoue", async () => {
    servir(new Error("hors ligne"), vide());
    render(<ProgressionScreen onClose={vi.fn()} />);
    const alerte = await screen.findByRole("alert");
    fireEvent.click(within(alerte).getByRole("button", { name: "Réessayer" }));
    await waitFor(() =>
      expect(screen.getByText("Aucun texte corrigé pour l'instant")).toBeTruthy(),
    );
  });

  it("charge les données depuis GET /api/progress", async () => {
    const fetch = servir(vide());
    render(<ProgressionScreen onClose={vi.fn()} />);
    await screen.findByText("Aucun texte corrigé pour l'instant");
    expect(fetch.mock.calls[0][0]).toBe("/api/progress");
  });
});
