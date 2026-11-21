import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { calculerProgression } from "../../src/analysis/progression/calcul";
import { construireExport, texteExport } from "../../src/analysis/progression/export";
import { calculerMesure, type EntreeMesure } from "../../src/analysis/progression/mesure";
import { ProgressionScreen } from "../../src/components/progression/ProgressionScreen";
import type { Progression } from "../../src/services/progress";

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
  // Mesure « avant / depuis » : on / ont mesurée, a / à trop récente, fautes de frappe en comparaison.
  const f = (n: number, ruleKey: string) => ({ at: jour(n), ruleKey, categoryId: "X" });
  const e = (n: number, ruleKey: string, type: string) => ({ at: jour(n), ruleKey, type });
  const mesure: EntreeMesure = {
    texts,
    faults: [
      ...[-58, -52, -50, -30, -2].map((n) => f(n, "PAIRE:on/ont")),
      ...[-20, -10, -8, -6].map((n) => f(n, "PAIRE:a/à")),
      ...[-46, -40, -38, -36, -20, -3].map((n) => f(n, "FR_SPELLING_RULE")),
    ],
    events: [
      e(-50, "PAIRE:on/ont", "astuce"),
      e(-30, "PAIRE:on/ont", "choix"),
      e(-30, "PAIRE:on/ont", "reponse_juste"),
      e(-6, "PAIRE:a/à", "astuce"),
    ],
    states: rules,
  };
  return avecMesure(
    calculerProgression(
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
    ),
    mesure,
  );
}

const sansDonnees: EntreeMesure = { texts: [], faults: [], events: [], states: [] };
const avecMesure = (
  p: ReturnType<typeof calculerProgression>,
  entree: EntreeMesure = sansDonnees,
): Progression => ({ ...p, mesure: calculerMesure(entree) });
const vide = () => avecMesure(calculerProgression({ texts: [], faults: [], rules: [] }, NOW));

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
    // Deux tableaux des graphiques, un tableau « avant / depuis ».
    expect(screen.getAllByRole("table")).toHaveLength(3);

    const regles = screen.getByRole("region", { name: "Vos règles" });
    expect(within(regles).getByText("on / ont")).toBeTruthy();
    expect(within(regles).getByText("a / à")).toBeTruthy();
    expect(within(regles).getByText("Travaillées")).toBeTruthy();

    const frequentes = screen.getByRole("region", { name: "Règles les plus fréquentes" });
    expect(within(frequentes).getByText("on / ont")).toBeTruthy();
    // Les fautes de frappe y figurent sous un libellé clair, sans état du cycle.
    expect(within(frequentes).getByText("Fautes de frappe")).toBeTruthy();
    // Aucun mot de l'utilisateur n'est affiché : plus de « Mots pièges » (#32).
    expect(screen.queryByRole("region", { name: "Mots pièges" })).toBeNull();

    // Pas de galerie de badges tant qu'elle n'est pas fournie.
    expect(screen.queryByRole("region", { name: "Badges" })).toBeNull();
  });

  it("affiche « pas encore assez de textes » plutôt qu'un chiffre trompeur", async () => {
    const data = avecMesure(
      calculerProgression(
        { texts: [{ at: jour(0), words: 40, faults: 1 }], faults: [], rules: [] },
        NOW,
      ),
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

describe("ProgressionScreen — ce que changent les astuces (#33) et export (#34)", () => {
  /** `GET /api/progress` et `GET /api/progress/export`. */
  function servirAvecExport(data: Progression, exp: unknown) {
    const mock = vi.fn((url: string, _init?: RequestInit) =>
      Promise.resolve(
        new Response(JSON.stringify(url === "/api/progress/export" ? exp : data), { status: 200 }),
      ),
    );
    globalThis.fetch = mock as unknown as typeof fetch;
    return mock;
  }
  const exportExemple = () =>
    construireExport({
      application: "0.5.0",
      plateforme: "serveur",
      participant: "0123456789abcdef0123456789abcdef",
      journal: { texts: [{ at: jour(0), words: 150 }], faults: [], events: [], states: [] },
      now: NOW,
    });

  it("phrases simples, tableau avec en-têtes, comparaison et limites", async () => {
    servirAvecExport(rempli(), exportExemple());
    render(<ProgressionScreen onClose={vi.fn()} />);
    const section = await screen.findByRole("region", { name: "Ce que changent les astuces" });
    expect(
      within(section).getByText(
        "Fautes qui ont reçu une astuce (1 règle mesurée) : 5 fautes pour 1 000 mots avant la première astuce, 0,7 depuis (87 % de moins).",
      ),
    ).toBeTruthy();
    expect(
      within(section).getByText(
        /Pour comparer, les fautes de frappe, qui ne reçoivent jamais d'astuce : 5,6 fautes pour 1 000 mots avant d'avoir atteint le même seuil, 0,9 depuis \(83 % de moins\)/,
      ),
    ).toBeTruthy();

    const tableau = within(section).getByRole("table");
    const entetes = within(tableau.querySelector("thead")!)
      .getAllByRole("columnheader")
      .map((th) => th.textContent);
    expect(entetes).toEqual(["Faute", "Avant la première astuce", "Depuis", "Évolution"]);
    const ligne = (nom: string) =>
      within(tableau)
        .getByRole("rowheader", { name: new RegExp(nom) })
        .closest("tr")!
        .textContent!.replace(/\s+/g, " ");
    expect(ligne("on / ont")).toContain("5 pour 1 000 mots");
    expect(ligne("on / ont")).toContain("3 fautes sur 600 mots (5 textes)");
    expect(ligne("on / ont")).toContain("87 % de moins");
    expect(ligne("a / à")).toContain("pas encore assez de textes depuis l'astuce (il en manque 6)");
    expect(ligne("Fautes de frappe")).toContain("jamais d'astuce");

    expect(within(section).getByText("1 bonne réponse sur 1 (100 %)")).toBeTruthy();
    const limites = within(section).getByRole("complementary", { name: "Limites de la mesure" });
    expect(limites.textContent).toMatch(/Ce n'est pas une preuve/);
    expect(limites.textContent).toMatch(/pas de tirage au sort/);
  });

  it("sans astuce affichée : explique quand la mesure commencera", async () => {
    const texts = [{ at: jour(0), words: 40, faults: 1 }];
    servirAvecExport(
      avecMesure(calculerProgression({ texts, faults: [], rules: [] }, NOW)),
      exportExemple(),
    );
    render(<ProgressionScreen onClose={vi.fn()} />);
    const section = await screen.findByRole("region", { name: "Ce que changent les astuces" });
    expect(within(section).getByText(/Aucune astuce n'a encore été affichée/)).toBeTruthy();
    expect(within(section).queryByRole("table")).toBeNull();
  });

  it("la fenêtre d'export montre le contenu exact, puis le télécharge (navigateur)", async () => {
    const exp = exportExemple();
    const fetch = servirAvecExport(rempli(), exp);
    const onClose = vi.fn();
    render(<ProgressionScreen onClose={onClose} />);
    fireEvent.click(await screen.findByRole("button", { name: "Exporter mes résultats" }));

    const fenetre = await screen.findByRole("dialog", { name: "Exporter mes résultats" });
    expect(fenetre.textContent).toMatch(/Grammaria n'envoie rien/);
    expect(fenetre.textContent).toMatch(/aucun de vos textes/);
    const contenu = await within(fenetre).findByLabelText(/Contenu exact du fichier/);
    expect((contenu as HTMLTextAreaElement).value).toBe(texteExport(exp));
    expect((contenu as HTMLTextAreaElement).readOnly).toBe(true);
    expect(fenetre.textContent).toContain("grammaria-beta-01234567.json");
    expect(fetch).toHaveBeenCalledWith("/api/progress/export", expect.anything());

    const blobs: Blob[] = [];
    URL.createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return "blob:grammaria";
    });
    URL.revokeObjectURL = vi.fn();
    const telechargements: string[] = [];
    const clic = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      telechargements.push(this.download);
    });
    fireEvent.click(within(fenetre).getByRole("button", { name: "Enregistrer le fichier" }));
    expect(await within(fenetre).findByText(/Téléchargement lancé/)).toBeTruthy();
    expect(telechargements).toEqual(["grammaria-beta-01234567.json"]);
    expect(await blobs[0].text()).toBe(texteExport(exp));
    clic.mockRestore();

    // Échap ferme la fenêtre, pas l'écran Progression.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("un export reçu hors du format est refusé, rien n'est affiché", async () => {
    servirAvecExport(rempli(), { ...exportExemple(), note: "texte libre" });
    render(<ProgressionScreen onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Exporter mes résultats" }));
    const fenetre = await screen.findByRole("dialog");
    expect(await within(fenetre).findByRole("alert")).toBeTruthy();
    expect(fenetre.textContent).not.toContain("texte libre");
    const bouton = within(fenetre).getByRole("button", { name: "Enregistrer le fichier" });
    expect((bouton as HTMLButtonElement).disabled).toBe(true);
  });
});
