import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type AppUpdateStatus,
  checkForUpdate,
  fetchUpdateStatus,
  installUpdate,
  isDesktopApp,
  openReleasePage,
} from "../services/appUpdate";

/** Intervalle de suivi de la recherche et du téléchargement (ms). */
const POLL_INTERVAL = 500;

export interface AppUpdate {
  status: AppUpdateStatus;
  /** Vrai une fois que l'utilisateur a lancé une recherche ou une installation lui-même. */
  userInitiated: boolean;
  check: () => void;
  install: () => void;
  openReleasePage: () => void;
}

/**
 * Mise à jour de l'application de bureau : une recherche au démarrage, puis à
 * la demande. Renvoie null dans un navigateur, ou tant que l'application n'a
 * pas répondu. Une erreur de la recherche automatique reste silencieuse
 * (`userInitiated` faux) : pas de message quand l'ordinateur est hors ligne.
 */
export function useAppUpdate(): AppUpdate | null {
  const [status, setStatus] = useState<AppUpdateStatus | null>(null);
  const [userInitiated, setUserInitiated] = useState(false);

  // Recherche au démarrage. Rien n'est téléchargé sans accord.
  useEffect(() => {
    if (!isDesktopApp()) return;
    let cancelled = false;
    checkForUpdate()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {
        /* application plus ancienne, sans mise à jour : rubrique masquée */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Pendant une recherche, le téléchargement et l'installation, l'application
  // avance seule : on relit son état.
  const busy =
    status?.phase === "checking" ||
    status?.phase === "downloading" ||
    status?.phase === "installing";
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => {
      fetchUpdateStatus()
        .then(setStatus)
        .catch(() => {
          /* l'application redémarre */
        });
    }, POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [busy]);

  const check = useCallback(() => {
    setUserInitiated(true);
    setStatus((s) => (s ? { ...s, phase: "checking", error: null, errorDetail: null } : s));
    checkForUpdate()
      .then(setStatus)
      .catch(() => {
        fetchUpdateStatus()
          .then(setStatus)
          .catch(() => {});
      });
  }, []);

  const install = useCallback(() => {
    setUserInitiated(true);
    installUpdate()
      .then(setStatus)
      .catch(() => {});
  }, []);

  const open = useCallback(() => {
    openReleasePage().catch(() => {});
  }, []);

  return useMemo(
    () => (status ? { status, userInitiated, check, install, openReleasePage: open } : null),
    [status, userInitiated, check, install, open],
  );
}
