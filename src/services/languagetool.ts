import type { LTMatch, LTResponse } from "../types";

/** Délai côté client ; le serveur borne lui-même l'analyse. */
const CHECK_TIMEOUT_MS = 30_000;

/**
 * Détections grammaticales du texte, calculées par le correcteur intégré au
 * serveur (règles françaises de LanguageTool, sans service externe).
 */
export async function runLanguageTool(text: string, signal?: AbortSignal): Promise<LTMatch[]> {
  if (!text.trim()) {
    throw new Error("Le texte ne peut pas être vide");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);

  try {
    const response = await fetch("/api/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Le correcteur grammatical a échoué (HTTP ${response.status}).`);
    }

    const data: LTResponse = await response.json();
    return data.matches;
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", onAbort);
  }
}
