/** Points retirés pour une faute par tranche de 100 mots. */
export const POINTS_PAR_FAUTE_POUR_100_MOTS = 2;

/**
 * Note sur 20 calculée sur la densité de fautes, pour qu'un texte long ne soit
 * pas pénalisé par rapport à un texte court. Sur une période, on additionne
 * fautes et mots avant de calculer : un message de trois mots ne pèse donc pas
 * autant qu'un courrier complet.
 */
export function noteSur20(fautes: number, mots: number): number | null {
  if (mots <= 0) return null;
  const densite = (fautes / mots) * 100;
  const note = Math.max(0, 20 - POINTS_PAR_FAUTE_POUR_100_MOTS * densite);
  return Math.round(note * 10) / 10;
}

/** Période du bilan : entier de 1 à 365 jours, 7 si absent ou illisible. */
export function parsePeriodDays(raw: string | null): number {
  if (raw === null || raw.trim() === "") return 7;
  const days = Number(raw);
  if (!Number.isFinite(days)) return 7;
  return Math.min(Math.max(Math.trunc(days), 1), 365);
}
