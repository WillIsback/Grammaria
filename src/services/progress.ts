import type { Progression } from "../analysis/progression/calcul";

export type { Progression } from "../analysis/progression/calcul";

/** Tout l'écran « Progression » en une seule requête. */
export async function fetchProgress(signal?: AbortSignal): Promise<Progression> {
  const response = await fetch("/api/progress", { signal });
  if (!response.ok) throw new Error(`Progression indisponible: ${response.status}`);
  return response.json();
}
