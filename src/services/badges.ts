import type { CatalogueBadges } from "../analysis/badges/vue";

export type { BadgeAnnonce, BadgeVue, CatalogueBadges } from "../analysis/badges/vue";

/** Catalogue complet des badges : obtenus ou non, date d'obtention et progression. */
export async function fetchBadges(signal?: AbortSignal): Promise<CatalogueBadges> {
  const response = await fetch("/api/badges", { signal });
  if (!response.ok) throw new Error(`Badges indisponibles: ${response.status}`);
  return response.json();
}
