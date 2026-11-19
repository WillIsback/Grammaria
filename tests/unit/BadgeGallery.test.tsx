import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { evaluerBadges } from "../../src/analysis/badges/evaluation";
import { vueCatalogue } from "../../src/analysis/badges/vue";
import { BadgeGallery } from "../../src/components/BadgeGallery";
import { BadgeNotice, DUREE_NOTIFICATION_MS } from "../../src/components/BadgeNotice";
import { useBadgeNotices } from "../../src/hooks/useBadgeNotices";

const DAY = 24 * 60 * 60 * 1000;
const J0 = new Date(2026, 2, 12, 12).getTime();

/** Catalogue : 3 textes corrigés sur 3 jours, un sans-faute. */
function catalogue() {
  const textes = [0, 1, 2].map((n) => ({ at: J0 + n * DAY, mots: 40, fautes: n === 2 ? 0 : 1 }));
  const etats = evaluerBadges({ textes, evenements: [] }, J0 + 3 * DAY);
  return vueCatalogue(
    etats,
    new Map([
      ["premier-texte", J0],
      ["premier-sans-faute", J0 + 2 * DAY],
    ]),
  );
}

describe("BadgeGallery", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(catalogue()), { status: 200 })),
    ) as unknown as typeof fetch;
  });

  it("charge le catalogue depuis /api/badges et le regroupe par famille", async () => {
    render(<BadgeGallery />);
    expect(screen.getByRole("status").textContent).toContain("Chargement");
    await screen.findByText("2 obtenus sur 18");
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/badges", expect.anything());
    const familles = screen.getAllByRole("heading", { level: 4 }).map((h) => h.textContent);
    expect(familles).toEqual([
      "Premiers pas",
      "Régularité",
      "Justesse",
      "Maîtrise des règles",
      "Persévérance",
    ]);
  });

  it("met en valeur les badges obtenus avec leur date, sans barre de progression", async () => {
    render(<BadgeGallery />);
    const carte = (await screen.findByRole("listitem", { name: "Premier texte" })) as HTMLElement;
    expect(within(carte).getByText("Obtenu le 12 mars 2026")).toBeTruthy();
    expect(within(carte).queryByRole("progressbar")).toBeNull();
  });

  it("affiche le critère et une progression lisible par un lecteur d'écran", async () => {
    render(<BadgeGallery />);
    const carte = (await screen.findByRole("listitem", { name: "Dix textes" })) as HTMLElement;
    expect(within(carte).getByText(/Corriger 10 textes\./).textContent).toContain("À venir.");
    const barre = within(carte).getByRole("progressbar", { name: "Dix textes" });
    expect(barre.getAttribute("aria-valuenow")).toBe("3");
    expect(barre.getAttribute("aria-valuemax")).toBe("10");
    expect(barre.getAttribute("aria-valuetext")).toBe("3 sur 10 textes");
    // L'information n'est jamais portée par la seule couleur : elle est écrite.
    expect(within(carte).getByText("3 sur 10 textes")).toBeTruthy();
  });

  it("explique la note moyenne visée", async () => {
    render(<BadgeGallery />);
    const carte = (await screen.findByRole("listitem", { name: "Plume sûre" })) as HTMLElement;
    expect(
      within(carte).getByText(/Note moyenne actuelle : 16,7 sur 20, objectif 18/),
    ).toBeTruthy();
    expect(within(carte).getByText(/3 textes corrigés sur les 30 derniers jours/)).toBeTruthy();
  });

  it("n'utilise que des pictogrammes décoratifs (le texte porte le sens)", async () => {
    const { container } = render(<BadgeGallery />);
    await screen.findByText("2 obtenus sur 18");
    for (const svg of container.querySelectorAll("svg")) {
      expect(svg.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("propose de réessayer si le chargement échoue", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response("", { status: 500 })),
    ) as unknown as typeof fetch;
    render(<BadgeGallery />);
    await screen.findByText("Les badges n'ont pas pu être chargés.");
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(catalogue()), { status: 200 })),
    ) as unknown as typeof fetch;
    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    await screen.findByText("2 obtenus sur 18");
  });

  it("recharge le catalogue quand le journal change, sans vider l'affichage", async () => {
    const { rerender } = render(<BadgeGallery reloadKey={0} />);
    await screen.findByText("2 obtenus sur 18");
    const vide = vueCatalogue(evaluerBadges({ textes: [], evenements: [] }, J0), new Map());
    vi.mocked(globalThis.fetch).mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify(vide), { status: 200 })),
    );
    rerender(<BadgeGallery reloadKey={1} />);
    expect(screen.queryByText("Chargement des badges…")).toBeNull();
    await screen.findByText("0 obtenu sur 18");
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});

const BADGE_A = {
  id: "premier-texte",
  titre: "Premier texte",
  description: "Le journal commence.",
};
const BADGE_B = { id: "jours-5", titre: "Cinq jours d'écriture", description: "Cinq jours." };

describe("BadgeNotice", () => {
  afterEach(() => vi.useRealTimers());

  it("garde une zone role=status vide tant qu'aucun badge n'est obtenu", () => {
    render(<BadgeNotice badges={[]} onClose={() => {}} />);
    const zone = screen.getByRole("status");
    expect(zone.getAttribute("aria-live")).toBe("polite");
    expect(zone.textContent).toBe("");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("annonce un badge avec son titre et sa description", () => {
    render(<BadgeNotice badges={[BADGE_A]} onClose={() => {}} />);
    const zone = screen.getByRole("status");
    expect(zone.textContent).toContain("Badge obtenu : Premier texte");
    expect(zone.textContent).toContain("Le journal commence.");
  });

  it("regroupe plusieurs badges dans une seule notification", () => {
    render(<BadgeNotice badges={[BADGE_A, BADGE_B]} onClose={() => {}} />);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByText("2 badges obtenus")).toBeTruthy();
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Premier texte",
      "Cinq jours d'écriture",
    ]);
  });

  it("se ferme seule, avec le bouton ou avec Échap", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(<BadgeNotice badges={[BADGE_A]} onClose={onClose} />);
    act(() => {
      vi.advanceTimersByTime(DUREE_NOTIFICATION_MS - 1);
    });
    expect(onClose).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Fermer la notification" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("ne ferme qu'elle-même avec Échap : la touche est consommée", () => {
    const onClose = vi.fn();
    const derriere = vi.fn((e: KeyboardEvent) => e.defaultPrevented);
    window.addEventListener("keydown", derriere);
    render(<BadgeNotice badges={[BADGE_A]} onClose={onClose} />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(derriere).toHaveReturnedWith(true);
    window.removeEventListener("keydown", derriere);
  });

  it("attend la fermeture d'une fenêtre qui la recouvre, puis garde son délai complet", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const { rerender } = render(<BadgeNotice badges={[BADGE_A]} onClose={onClose} suspendue />);
    expect(screen.getByRole("status").textContent).toBe("");
    act(() => {
      vi.advanceTimersByTime(DUREE_NOTIFICATION_MS * 2);
    });
    // Échap ferme la fenêtre, pas la notification en attente.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    rerender(<BadgeNotice badges={[BADGE_A]} onClose={onClose} suspendue={false} />);
    expect(screen.getByRole("status").textContent).toContain("Badge obtenu : Premier texte");
    act(() => {
      vi.advanceTimersByTime(DUREE_NOTIFICATION_MS - 1);
    });
    expect(onClose).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("reste affichée tant qu'elle est survolée", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(<BadgeNotice badges={[BADGE_A]} onClose={onClose} />);
    const carte = screen.getByText("Badge obtenu : Premier texte").closest("div") as HTMLElement;
    fireEvent.mouseEnter(carte.parentElement as HTMLElement);
    act(() => {
      vi.advanceTimersByTime(DUREE_NOTIFICATION_MS * 2);
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("useBadgeNotices", () => {
  it("fusionne les badges reçus pendant qu'une notification est affichée", () => {
    const { result } = renderHook(() => useBadgeNotices());
    act(() => result.current.annoncer([BADGE_A]));
    act(() => result.current.annoncer([]));
    act(() => result.current.annoncer(undefined));
    act(() => result.current.annoncer([BADGE_A, BADGE_B]));
    expect(result.current.annonces.map((b) => b.id)).toEqual(["premier-texte", "jours-5"]);
    act(() => result.current.fermer());
    expect(result.current.annonces).toEqual([]);
  });
});

describe("Effacement du journal", () => {
  it("prévient que les badges seront effacés", async () => {
    const { Sidebar } = await import("../../src/components/Sidebar");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <Sidebar
        settings={{
          mode: "formel",
          fixGrammar: true,
          fixSpelling: true,
          fixSyntax: true,
          fixStyle: true,
        }}
        setSettings={() => {}}
        open
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Effacer le journal" }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(confirm.mock.calls[0][0]).toContain("badges obtenus seront aussi effacés");
    confirm.mockRestore();
  });

  it("prévient l'application une fois le journal effacé, pour recharger Progression et les badges", async () => {
    const { Sidebar } = await import("../../src/components/Sidebar");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ purged: true }), { status: 200 })),
    ) as unknown as typeof fetch;
    const onPurged = vi.fn();
    render(
      <Sidebar
        settings={{
          mode: "formel",
          fixGrammar: true,
          fixSpelling: true,
          fixSyntax: true,
          fixStyle: true,
        }}
        setSettings={() => {}}
        open
        onClose={() => {}}
        onPurged={onPurged}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Effacer le journal" }));
    await screen.findByText("Journal et badges effacés.");
    expect(onPurged).toHaveBeenCalledTimes(1);
    confirm.mockRestore();
  });
});
