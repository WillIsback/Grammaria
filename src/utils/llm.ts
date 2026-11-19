import type { CorrectionSettings, LlmResult, StreamCallbacks } from "../types";
import { cleanLlmOutput } from "./llmText";
import { getCurrentModel } from "./models";
import { buildSystemPrompt, buildUserPrompt } from "./prompt";
import { sanitizeInput } from "./sanitize";

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
    temperature: 0.3,
    correction_mode: settings.mode,
  };

  currentAbortController?.abort();
  const controller = new AbortController();
  currentAbortController = controller;

  const streamTimeoutMs = 120_000;
  let streamTimeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    const response = await fetch("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer no-key-needed" },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    if (!response.ok) {
      // Le serveur renvoie { error, details } : afficher la cause plutôt qu'un code nu.
      let details = "";
      try {
        const body = await response.json();
        details = typeof body?.details === "string" ? body.details : "";
      } catch {
        /* corps absent ou non JSON */
      }
      throw new Error(
        details
          ? `Le serveur de correction a échoué (HTTP ${response.status}) : ${details}`
          : `Le serveur de correction a échoué (HTTP ${response.status}).`,
      );
    }
    if (!response.body) throw new Error("No response body");

    streamTimeoutId = setTimeout(() => controller.abort(), streamTimeoutMs);

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

        if (payload.error) throw new Error(payload.error);

        if (typeof payload.delta === "string") {
          received += payload.delta;
          callbacks?.onText?.(cleanLlmOutput(received));
        }

        if (payload.done) {
          clearTimeout(streamTimeoutId);
          return {
            text: typeof payload.text === "string" ? payload.text : cleanLlmOutput(received),
            duration: payload.duration ?? 0,
          };
        }
      }
    }

    throw new Error("Stream ended without done event");
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === "AbortError") throw new Error("Délai d'attente dépassé.");
      if (error.message.includes("Failed to fetch"))
        throw new Error("Impossible de contacter le serveur Grammaria. Vérifiez qu'il est lancé.");
    }
    throw error;
  }
}
