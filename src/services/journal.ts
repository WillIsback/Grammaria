import type { Analysis } from "../analysis/analyze";
import type { BadgeAnnonce } from "../analysis/badges/vue";
import type { Intervention, Reussite } from "../analysis/regles/intervention";
import type { LTMatch, WeekSummary } from "../types";

export interface AnalysisResponse extends Analysis {
  week: WeekSummary;
  /** Astuce ou choix à deux formes à afficher près du bouton Copier. */
  intervention?: Intervention | null;
  /** Règles devenues « acquises » avec ce texte. */
  reussites?: Reussite[];
  /** Badges obtenus grâce à ce texte (notification discrète). */
  nouveauxBadges?: BadgeAnnonce[];
}

/** Envoie le texte d'origine, le texte corrigé et les détections au journal. */
export async function analyzeCorrection(
  original: string,
  corrected: string,
  matches: LTMatch[],
  signal?: AbortSignal,
): Promise<AnalysisResponse> {
  const response = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ original, corrected, matches }),
    signal,
  });
  if (!response.ok) throw new Error(`Analyse indisponible: ${response.status}`);
  return response.json();
}

/**
 * Signale au journal la forme cliquée lors du choix à deux formes. Renvoie
 * les badges obtenus grâce à cette réponse.
 */
export async function answerChoice(ruleKey: string, correct: boolean): Promise<BadgeAnnonce[]> {
  const response = await fetch("/api/rules/answer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ruleKey, correct }),
  });
  if (!response.ok) throw new Error(`Réponse non enregistrée: ${response.status}`);
  const body = (await response.json().catch(() => ({}))) as { nouveauxBadges?: BadgeAnnonce[] };
  return Array.isArray(body.nouveauxBadges) ? body.nouveauxBadges : [];
}

export async function purgeJournal(): Promise<void> {
  const response = await fetch("/api/journal", { method: "DELETE" });
  if (!response.ok) throw new Error(`Purge impossible: ${response.status}`);
}
