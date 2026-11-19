import { useEffect, useState } from "react";
import { fetchServerSettings, type ServerSettings } from "../services/settings";

/** Réglages du serveur ; null tant qu'ils ne sont pas chargés (ou sur un serveur ancien). */
export function useServerSettings() {
  const [settings, setSettings] = useState<ServerSettings | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchServerSettings()
      .then((s) => {
        if (!cancelled) setSettings(s);
      })
      .catch(() => {
        /* serveur sans /api/settings : réglages non modifiables */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { serverSettings: settings, setServerSettings: setSettings };
}
