import type { CorrectionSettings, LlmResult, StreamCallbacks } from "../types";
import { ErreurCorrection, MESSAGE_ECHEC_CORRECTION, messageErreurModele } from "./erreursModele";
import { cleanLlmOutput } from "./llmText";
import { getCurrentModel } from "./models";
import { buildSystemPrompt, buildUserPrompt } from "./prompt";
import { sanitizeInput } from "./sanitize";

/** Message de l'abandon (`AbortError`) d'une correction remplacée par une nouvelle. */
export const CORRECTION_REMPLACEE = "Correction remplacée par une nouvelle demande.";

/** Requête en cours : une nouvelle correction l'annule. */
let currentAbortController: AbortController | null = null;

export async function correctText(
  text: string,
  settings: CorrectionSettings,
  callbacks?: StreamCallbacks,
): Promise<LlmResult> {
  const systemPrompt = buildSystemPrompt(settings);
  const userPrompt = buildUserPrompt(sanitizeInput(text));

  const request = {
    model: getCurrentModel(),
    messages: [
      { role: "system" as const, content: systemPrompt },
      { role: "user" as const, content: userPrompt },
    ],
    // Basse : reproduire le texte en ne changeant que les fautes. Pas 0, qui
    // fait boucler certains modèles sur les textes longs.
    temperature: 0.1,
    correction_mode: settings.mode,
  };

  currentAbortController?.abort();
  const controller = new AbortController();
  currentAbortController = controller;

  /**
   * Délai maximal de toute la correction, armé dès l'envoi de la requête : une
   * connexion qui n'aboutit jamais, ou une réponse qui tarde à commencer, est
   * bornée comme un flux qui n'en finit pas.
   */
  const streamTimeoutMs = 120_000;
  /** Vrai quand l'abandon vient du délai ci-dessous, pas d'une nouvelle correction. */
  let delaiDepasse = false;
  const streamTimeoutId = setTimeout(() => {
    delaiDepasse = true;
    controller.abort();
  }, streamTimeoutMs);

  try {
    const response = await fetch("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer no-key-needed" },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    if (!response.ok) {
      // Le gestionnaire renvoie { message, details } : un message simple, et le
      // détail technique replié sous « Détails ».
      let message = "";
      let details = "";
      try {
        const body = await response.json();
        message = typeof body?.message === "string" ? body.message : "";
        details = typeof body?.details === "string" ? body.details : "";
      } catch {
        /* corps absent ou non JSON */
      }
      throw new ErreurCorrection(
        message || MESSAGE_ECHEC_CORRECTION,
        details ? `HTTP ${response.status} : ${details}` : `HTTP ${response.status}`,
      );
    }
    if (!response.body) throw new ErreurCorrection(MESSAGE_ECHEC_CORRECTION, "Réponse sans corps.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let received = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";

      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith("data: ")) continue;
        const payload = JSON.parse(line.slice(6));

        if (payload.error) {
          throw new ErreurCorrection(
            String(payload.error),
            typeof payload.details === "string" ? payload.details : "",
          );
        }

        if (typeof payload.delta === "string") {
          received += payload.delta;
          callbacks?.onText?.(cleanLlmOutput(received));
        }

        if (payload.done) {
          return {
            text: typeof payload.text === "string" ? payload.text : cleanLlmOutput(received),
            duration: payload.duration ?? 0,
          };
        }
      }
    }

    throw new ErreurCorrection(MESSAGE_ECHEC_CORRECTION, "Flux terminé sans événement de fin.");
  } catch (error) {
    // DOMException n'hérite pas toujours d'Error (jsdom) : le nom suffit.
    if ((error as { name?: unknown } | null)?.name === "AbortError") {
      // Remplacée par une nouvelle correction : abandon, que l'interface ignore.
      if (!delaiDepasse) {
        const remplacee = new Error(CORRECTION_REMPLACEE);
        remplacee.name = "AbortError";
        throw remplacee;
      }
      throw new ErreurCorrection(
        messageErreurModele("delai", false),
        "Délai d'attente dépassé (aucune fin de réponse en 120 s).",
      );
    }
    if (error instanceof Error) {
      if (error.message.includes("Failed to fetch"))
        throw new Error("Impossible de contacter le serveur Grammaria. Vérifiez qu'il est lancé.");
    }
    throw error;
  } finally {
    clearTimeout(streamTimeoutId);
  }
}
