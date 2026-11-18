import type { Analysis } from "../analysis/analyze";
import type { LTMatch, WeekSummary } from "../types";

export interface AnalysisResponse extends Analysis {
  week: WeekSummary;
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

export async function purgeJournal(): Promise<void> {
  const response = await fetch("/api/journal", { method: "DELETE" });
  if (!response.ok) throw new Error(`Purge impossible: ${response.status}`);
}
