import { useCallback, useEffect, useState } from "react";

/**
 * Charge des données à l'affichage, puis à nouveau quand `cle` change (comparée
 * par identité) ou sur « Réessayer ». Pendant un rechargement, les données déjà
 * affichées restent en place ; une requête dépassée est annulée.
 */
export function useChargement<T>(charger: (signal: AbortSignal) => Promise<T>, cle?: unknown) {
  const [data, setData] = useState<T | null>(null);
  const [erreur, setErreur] = useState(false);
  // Incrémenté par « Réessayer » pour relancer le chargement.
  const [essai, setEssai] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    charger(controller.signal)
      .then(setData)
      .catch(() => {
        if (!controller.signal.aborted) setErreur(true);
      });
    return () => controller.abort();
  }, [charger, essai, cle]);

  const reessayer = useCallback(() => {
    setErreur(false);
    setEssai((n) => n + 1);
  }, []);

  return { data, erreur, reessayer };
}
