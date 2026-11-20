import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { SettingsDialog } from "../../src/components/SettingsDialog";
import { UpdateBanner } from "../../src/components/UpdateBanner";
import { UpdateSettings } from "../../src/components/UpdateSettings";
import { type AppUpdate, useAppUpdate } from "../../src/hooks/useAppUpdate";
import {
  type AppUpdateStatus,
  formatProgress,
  isBusy,
  isDesktopApp,
  messagePhase,
  type UpdatePhase,
} from "../../src/services/appUpdate";

vi.mock("../../src/utils/models", () => ({
  getCurrentModel: () => "qwen3",
  setCurrentModel: vi.fn(),
  subscribeToModelChange: () => () => {},
  fetchModels: vi.fn().mockResolvedValue([]),
}));

const base: AppUpdateStatus = {
  currentVersion: "0.3.0",
  mode: "auto",
  phase: "upToDate",
  version: null,
  notes: null,
  downloaded: 0,
  total: null,
  error: null,
  errorDetail: null,
  failedStep: null,
  releasePage: "https://github.com/WillIsback/Grammaria/releases/latest",
};
const available: AppUpdateStatus = { ...base, phase: "available", version: "0.3.1" };

/** Simule le pont de l'application de bureau (window.__TAURI__.core.invoke). */
function desktop(handler: (command: string) => unknown) {
  const invoke = vi.fn((command: string) => Promise.resolve(handler(command)));
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke } };
  return invoke;
}

function controller(status: AppUpdateStatus, overrides: Partial<AppUpdate> = {}): AppUpdate {
  return {
    status,
    userInitiated: false,
    check: vi.fn(),
    install: vi.fn(),
    openReleasePage: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
  vi.useRealTimers();
});

// Issue #13 : mise à jour automatique de l'application de bureau.
describe("useAppUpdate", () => {
  it("ne fait rien dans un navigateur (version web, Docker)", () => {
    expect(isDesktopApp()).toBe(false);
    const { result } = renderHook(() => useAppUpdate());
    expect(result.current).toBeNull();
  });

  it("recherche une mise à jour au démarrage, sans rien installer", async () => {
    const invoke = desktop(() => available);
    expect(isDesktopApp()).toBe(true);
    const { result } = renderHook(() => useAppUpdate());
    await waitFor(() => expect(result.current?.status.phase).toBe("available"));
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["update_check"]);
    expect(result.current?.userInitiated).toBe(false);
  });

  it("n'installe que sur demande, puis suit le téléchargement", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let downloaded = 0;
    const invoke = desktop((command) => {
      if (command === "update_check") return available;
      downloaded += 50;
      return { ...available, phase: "downloading", downloaded, total: 200 };
    });
    const { result } = renderHook(() => useAppUpdate());
    await waitFor(() => expect(result.current?.status.phase).toBe("available"));

    act(() => result.current?.install());
    await waitFor(() => expect(result.current?.status.phase).toBe("downloading"));
    expect(invoke).toHaveBeenCalledWith("update_install");
    expect(result.current?.userInitiated).toBe(true);

    await act(() => vi.advanceTimersByTimeAsync(1100));
    expect(invoke).toHaveBeenCalledWith("update_status");
    expect(result.current?.status.downloaded).toBeGreaterThan(50);
  });

  it("relance une recherche à la demande", async () => {
    let calls = 0;
    desktop(() => (++calls === 1 ? base : available));
    const { result } = renderHook(() => useAppUpdate());
    await waitFor(() => expect(result.current?.status.phase).toBe("upToDate"));
    act(() => result.current?.check());
    expect(result.current?.status.phase).toBe("checking");
    await waitFor(() => expect(result.current?.status.version).toBe("0.3.1"));
  });

  it("reste masqué si l'application ne connaît pas les commandes de mise à jour", async () => {
    const invoke = vi.fn(() => Promise.reject(new Error("update_check not allowed")));
    (window as unknown as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke } };
    const { result } = renderHook(() => useAppUpdate());
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });
});

describe("formatProgress", () => {
  it("affiche un pourcentage, ou la taille téléchargée si le total est inconnu", () => {
    expect(formatProgress({ downloaded: 50, total: 200 })).toBe("25 %");
    expect(formatProgress({ downloaded: 300, total: 200 })).toBe("100 %");
    expect(formatProgress({ downloaded: 12_340_000, total: null })).toBe("12,3 Mo");
  });
});

describe("isBusy et messagePhase", () => {
  it("l'application avance seule pendant la recherche, le téléchargement et l'installation", () => {
    const occupees: UpdatePhase[] = ["checking", "downloading", "installing"];
    const libres: UpdatePhase[] = ["idle", "upToDate", "available", "noRelease", "error"];
    expect(occupees.every(isBusy)).toBe(true);
    expect(libres.some(isBusy)).toBe(false);
  });

  it("ne décrit que le téléchargement et l'installation", () => {
    const telechargement: AppUpdateStatus = {
      ...base,
      phase: "downloading",
      downloaded: 1,
      total: 4,
    };
    expect(messagePhase(telechargement)).toBe("Téléchargement… 25 %");
    expect(messagePhase(telechargement, "Téléchargement de la mise à jour…")).toBe(
      "Téléchargement de la mise à jour… 25 %",
    );
    expect(messagePhase({ ...base, phase: "installing" })).toMatch(/^Installation…/);
    expect(messagePhase({ ...base, phase: "checking" })).toBeNull();
  });
});

describe("Paramètres → Mises à jour", () => {
  const dialog = (appUpdate: AppUpdate | null | undefined) =>
    render(
      <SettingsDialog
        open
        onClose={vi.fn()}
        serverSettings={null}
        onServerSettingsSaved={vi.fn()}
        modelsReloadKey={0}
        appUpdate={appUpdate}
      />,
    );

  it("la rubrique n'existe que dans l'application de bureau", () => {
    dialog(undefined);
    expect(screen.queryByRole("button", { name: "Mises à jour" })).toBeNull();
  });

  it("affiche la version installée et recherche une mise à jour à la demande", () => {
    const update = controller(base);
    dialog(update);
    fireEvent.click(screen.getByRole("button", { name: "Mises à jour" }));
    expect(screen.getByText("0.3.0")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Grammaria est à jour.");
    fireEvent.click(screen.getByRole("button", { name: "Rechercher une mise à jour" }));
    expect(update.check).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /Installer/ })).toBeNull();
  });

  it("propose la nouvelle version, installée seulement au clic", () => {
    const update = controller({ ...available, notes: "Corrections diverses." });
    render(<UpdateSettings update={update} />);
    expect(screen.getByRole("status").textContent).toBe("La version 0.3.1 est disponible.");
    expect(screen.getByText("Corrections diverses.")).toBeTruthy();
    expect(update.install).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Installer la version 0.3.1 et redémarrer" }),
    );
    expect(update.install).toHaveBeenCalledTimes(1);
  });

  it("suit le téléchargement et bloque une nouvelle recherche pendant ce temps", () => {
    render(
      <UpdateSettings
        update={controller({ ...available, phase: "downloading", downloaded: 1, total: 4 })}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe("Téléchargement… 25 %");
    const search = screen.getByRole("button", { name: "Rechercher une mise à jour" });
    expect((search as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /Installer/ })).toBeNull();
  });

  it("explique une erreur et permet de réessayer", () => {
    render(
      <UpdateSettings
        update={controller({
          ...available,
          phase: "error",
          error: "La mise à jour n'a pas pu être installée.",
          errorDetail: "signature invalide",
        })}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe(
      "La mise à jour n'a pas pu être installée.",
    );
    expect(screen.getByText(/signature invalide/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Installer la version 0.3.1/ })).toBeTruthy();
  });

  it("paquet .deb ou MSI : signale la version et renvoie vers la page de téléchargement", () => {
    const update = controller({ ...available, mode: "manual" });
    render(<UpdateSettings update={update} />);
    expect(screen.queryByRole("button", { name: /Installer/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ouvrir la page de téléchargement" }));
    expect(update.openReleasePage).toHaveBeenCalledTimes(1);
  });

  it("clé publique absente : indique que les mises à jour automatiques ne sont pas actives", () => {
    const update = controller({ ...base, mode: "inactive", phase: "idle" });
    render(<UpdateSettings update={update} />);
    expect(screen.getByText("0.3.0")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toMatch(/ne sont pas encore actives/);
    expect(screen.queryByRole("button", { name: "Rechercher une mise à jour" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ouvrir la page de téléchargement" }));
    expect(update.openReleasePage).toHaveBeenCalledTimes(1);
  });
});

describe("UpdateBanner — proposition au démarrage", () => {
  it("n'affiche rien dans un navigateur, ni quand l'application est à jour", () => {
    const { container, rerender } = render(<UpdateBanner update={null} />);
    expect(container.textContent).toBe("");
    rerender(<UpdateBanner update={controller(base)} />);
    expect(container.textContent).toBe("");
    rerender(<UpdateBanner update={controller({ ...base, mode: "inactive", phase: "idle" })} />);
    expect(container.textContent).toBe("");
  });

  it("propose la nouvelle version ; rien n'est installé sans clic", () => {
    const update = controller(available);
    render(<UpdateBanner update={update} />);
    expect(screen.getByText("Grammaria 0.3.1 est disponible.")).toBeTruthy();
    expect(update.install).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Installer et redémarrer" }));
    expect(update.install).toHaveBeenCalledTimes(1);
  });

  it("« Plus tard » ferme le bandeau", () => {
    const { container } = render(<UpdateBanner update={controller(available)} />);
    fireEvent.click(screen.getByRole("button", { name: "Plus tard" }));
    expect(container.textContent).toBe("");
  });

  it("paquet .deb ou MSI : lien vers la page de téléchargement, pas d'installation", () => {
    const update = controller({ ...available, mode: "manual" });
    render(<UpdateBanner update={update} />);
    expect(screen.queryByRole("button", { name: /Installer/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ouvrir la page de téléchargement" }));
    expect(update.openReleasePage).toHaveBeenCalledTimes(1);
  });

  it("affiche l'avancement, sans bouton, pendant le téléchargement", () => {
    render(
      <UpdateBanner
        update={controller({ ...available, phase: "downloading", downloaded: 3, total: 4 })}
      />,
    );
    expect(screen.getByText("Téléchargement de la mise à jour… 75 %")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("une recherche automatique en échec (hors ligne) reste silencieuse", () => {
    const failed = { ...base, phase: "error" as const, error: "Impossible de vérifier." };
    const { container } = render(<UpdateBanner update={controller(failed)} />);
    expect(container.textContent).toBe("");
  });

  it("une installation en échec est signalée et peut être relancée", () => {
    const update = controller(
      {
        ...available,
        phase: "error",
        failedStep: "install",
        error: "La mise à jour n'a pas pu être installée.",
      },
      { userInitiated: true },
    );
    render(<UpdateBanner update={update} />);
    expect(screen.getByText("La mise à jour n'a pas pu être installée.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    expect(update.install).toHaveBeenCalledTimes(1);
    expect(update.check).not.toHaveBeenCalled();
  });

  it("après une recherche en échec, « Réessayer » relance la recherche, pas l'installation", () => {
    for (const mode of ["auto", "manual"] as const) {
      const update = controller(
        {
          ...available,
          mode,
          phase: "error",
          failedStep: "check",
          error: "Impossible de vérifier les mises à jour.",
        },
        { userInitiated: true },
      );
      const { unmount } = render(<UpdateBanner update={update} />);
      expect(screen.queryByRole("button", { name: /Installer/ })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
      expect(update.check).toHaveBeenCalledTimes(1);
      expect(update.install).not.toHaveBeenCalled();
      unmount();
    }
  });

  it("un manifeste introuvable n'affiche ni bandeau ni erreur", () => {
    const update = controller({ ...base, phase: "noRelease" }, { userInitiated: true });
    const { container } = render(<UpdateBanner update={update} />);
    expect(container.textContent).toBe("");
    render(<UpdateSettings update={update} />);
    expect(screen.getByRole("status").textContent).toBe(
      "Aucune mise à jour disponible pour le moment.",
    );
  });
});
