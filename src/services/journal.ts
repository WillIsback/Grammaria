import type { Analysis } from "../analysis/analyze";
import type { BadgeAnnonce } from "../analysis/badges/vue";
import type { TendanceRegle } from "../analysis/progression/tendance";
import type { Intervention, Reussite } from "../analysis/regles/intervention";
import type { QuestionRevision } from "../analysis/regles/revision";
import type { LTMatch, WeekSummary } from "../types";

export interface AnalysisResponse extends Analysis {
  week: WeekSummary;
  /** Astuce ou choix à deux formes à afficher près du bouton Copier. */
  intervention?: Intervention | null;
  /** Règles devenues « acquises » avec ce texte. */
  reussites?: Reussite[];
  /** Progression favorable de l'une des règles du texte, affichée avant la note (issue #63). */
  tendance?: TendanceRegle | null;
  /** Badges obtenus grâce à ce texte (notification discrète). */
  nouveauxBadges?: BadgeAnnonce[];
}

/** Envoie le texte d'origine, le texte corrigé et les détections au journal. */
export async function analyzeCorrection(
  original: string,
  corrected: string,
  matches: LTMatch[],
  signal?: AbortSignal,
  /** Une question de révision a été posée pendant l'attente de ce texte (issue #62). */
  revisionPosee = false,
): Promise<AnalysisResponse> {
  const response = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      revisionPosee
        ? { original, corrected, matches, revisionPosee: true }
        : { original, corrected, matches },
    ),
    signal,
  });
  if (!response.ok) throw new Error(`Analyse indisponible: ${response.status}`);
  return response.json();
}

/**
 * Question de révision à poser pendant l'attente de la correction (issue #62).
 * Jamais d'erreur : une panne donne « aucune question ».
 */
export async function fetchRevision(signal?: AbortSignal): Promise<QuestionRevision | null> {
  try {
    const response = await fetch("/api/revision", { signal });
    if (!response.ok) return null;
    const body = await response.json();
    const question = body?.question;
    return question && Number.isSafeInteger(question.reviewId) ? question : null;
  } catch {
    return null;
  }
}

/** Signale au journal la réponse à une question de révision. Sans effet en cas de panne. */
export async function answerRevision(reviewId: number, correct: boolean): Promise<void> {
  try {
    await fetch("/api/revision/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewId, correct }),
    });
  } catch {
    /* la réponse n'est pas enregistrée : sans conséquence pour l'utilisateur */
  }
}

/**
 * Signale au journal la forme cliquée lors du choix à deux formes. Renvoie
 * les badges obtenus grâce à cette réponse.
 */
export async function answerChoice(choiceId: number, correct: boolean): Promise<BadgeAnnonce[]> {
  const response = await fetch("/api/rules/answer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ choiceId, correct }),
  });
  if (!response.ok) throw new Error(`Réponse non enregistrée: ${response.status}`);
  const body = (await response.json().catch(() => ({}))) as { nouveauxBadges?: BadgeAnnonce[] };
  return Array.isArray(body.nouveauxBadges) ? body.nouveauxBadges : [];
}

export async function purgeJournal(): Promise<void> {
  const response = await fetch("/api/journal", { method: "DELETE" });
  if (!response.ok) throw new Error(`Purge impossible: ${response.status}`);
}
