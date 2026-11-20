import { useCallback, useState } from "react";
import type { BadgeAnnonce } from "../analysis/badges/vue";

/**
 * Badges à annoncer dans la notification. Des badges obtenus pendant qu'une
 * notification est encore affichée la rejoignent : il n'y a jamais qu'une
 * seule notification, regroupée.
 */
export function useBadgeNotices() {
  const [annonces, setAnnonces] = useState<BadgeAnnonce[]>([]);

  const annoncer = useCallback((badges: BadgeAnnonce[] | null | undefined) => {
    if (!badges || badges.length === 0) return;
    setAnnonces((courantes) => {
      const ids = new Set(courantes.map((b) => b.id));
      return [...courantes, ...badges.filter((b) => !ids.has(b.id))];
    });
  }, []);

  const fermer = useCallback(() => setAnnonces([]), []);

  return { annonces, annoncer, fermer };
}
