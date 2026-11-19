// Telemetry MUST be imported first — instruments OpenAI SDK before it loads
import "./telemetry.ts";

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import OpenAI from "openai";
import { config } from "./config.ts";
import { GrammarChecker } from "./grammar.ts";
import { SettingsStore } from "./settings.ts";
import { Journal } from "./journal.ts";
import { awardBadgesSafely } from "./journal.badges.ts";
import { ETATS_CYCLE } from "./src/analysis/regles/cycle.ts";
import { SEUILS } from "./src/analysis/regles/seuils.ts";
import { analyze } from "./src/analysis/analyze.ts";
import { parsePeriodDays } from "./src/analysis/score.ts";
import { cleanLlmOutput } from "./src/utils/llmText.ts";
import { isStreamTeardownError } from "./src/utils/streamErrors.ts";
import {
  createModelDetector,
  downstreamHeaders,
  isThinkingParamRejection,
  resolveModel,
  upstreamHeaders,
} from "./src/utils/upstream.ts";

const tracer = trace.getTracer("grammaria");

const PORT = config.port;
const DIST_DIR = resolve(config.distDir || join(import.meta.dir, "dist"));
const VALID_WORDS_PATH =
  config.validWordsPath || join(import.meta.dir, "public", "data", "valid-words.json");

// En mode bureau, les réglages du LLM saisis dans l'interface remplacent ceux
// de l'environnement (chargés ici, avant la création du client).
const settings = new SettingsStore(
  config.desktop && config.settingsPath ? config.settingsPath : null,
);

const journal = new Journal(config.journalPath);

const grammar = new GrammarChecker();
grammar.warmUp();

/** Taille maximale d'un texte accepté par /api/check et /api/analyze (caractères). */
const MAX_ANALYZE_LENGTH = 20_000;
/** Routes du cycle de vie des règles. */
const RULE_PATHS = new Set(["/api/rules", "/api/rules/events", "/api/rules/answer"]);
/** Écran « Progression » : tout l'écran en une seule requête (issue #15). */
const PROGRESS_PATH = "/api/progress";
/** Fenêtre de la note moyenne affichée près du bouton copier (jours). */
const SCORE_WINDOW_DAYS = 7;

let llmClient: OpenAI;
/** Modèle par défaut du serveur LLM, quand ni la config ni l'interface n'en fixent un. */
let detectModel: () => Promise<string | null>;

/**
 * Vrai quand le serveur du modèle a refusé `chat_template_kwargs` (paramètre
 * de vLLM / SGLang qui coupe le raisonnement) : on ne le renvoie plus jusqu'au
 * prochain changement de réglages.
 */
let thinkingParamRejected = false;

/** (Re)crée le client du LLM ; rappelé quand les réglages changent (mode bureau). */
function connectLlm(): void {
  thinkingParamRejected = false;
  llmClient = new OpenAI({
    baseURL: `${config.llmTarget}/v1`,
    apiKey: config.llmApiKey || "unused",
  });
  detectModel = createModelDetector(config.llmTarget, config.llmApiKey);
}
connectLlm();

/**
 * Mode bureau : le serveur n'écoute qu'en local, mais une page web ouverte
 * dans le navigateur peut quand même l'appeler. On refuse donc un en-tête
 * Host étranger (DNS rebinding) et toute requête de modification venue d'une
 * autre origine (CSRF), par exemple pour rediriger les textes vers un autre LLM.
 */
function rejectForeignRequest(req: Request, url: URL): Response | null {
  if (!config.desktop) return null;
  const allowedHosts = [`127.0.0.1:${config.port}`, `localhost:${config.port}`];
  if (!allowedHosts.includes(req.headers.get("Host") ?? "")) {
    return new Response("Forbidden", { status: 403 });
  }
  const origin = req.headers.get("Origin");
  const safe = req.method === "GET" || req.method === "HEAD";
  if (!safe && origin !== null && origin !== url.origin) {
    return new Response("Forbidden", { status: 403 });
  }
  return null;
}

function getCorsHeaders(req: Request): Headers {
  const origin = req.headers.get("Origin") ?? "";
  const isLocalhost = origin.includes("localhost") || origin.includes("127.0.0.1");
  const isAllowed = isLocalhost || config.corsOrigins.some((o) => origin === o);
  const headers = new Headers();
  headers.set("Content-Type", "application/json");
  if (isAllowed) {
    headers.set("Access-Control-Allow-Origin", origin);
  }
  return headers;
}

function readValidWords(): string[] {
  try {
    const data = JSON.parse(readFileSync(VALID_WORDS_PATH, "utf-8"));
    return data.words || [];
  } catch {
    return [];
  }
}

function writeValidWords(words: string[]): void {
  const tmpPath = `${VALID_WORDS_PATH}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify({ words }, null, 2)}\n`);
  renameSync(tmpPath, VALID_WORDS_PATH);
}

Bun.serve({
  port: PORT,
  hostname: config.host,
  async fetch(req: Request, server: Bun.Server<undefined>): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    const forbidden = rejectForeignRequest(req, url);
    if (forbidden) return forbidden;

    // === API: Réglages du LLM (modifiables en mode bureau uniquement) ===
    if (path === "/api/settings") {
      const headers = getCorsHeaders(req);
      if (req.method === "GET") {
        return new Response(JSON.stringify(settings.publicView()), { headers });
      }
      if (req.method === "PUT") {
        if (!settings.editable) {
          return new Response(JSON.stringify({ error: "Settings are read-only" }), {
            status: 403,
            headers,
          });
        }
        try {
          const view = settings.update(await req.json());
          connectLlm();
          return new Response(JSON.stringify(view), { headers });
        } catch (error) {
          return new Response(
            JSON.stringify({ error: error instanceof Error ? error.message : "Invalid settings" }),
            { status: 400, headers },
          );
        }
      }
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers,
      });
    }

    // === API: Valid Words ===
    if (path === "/api/valid-words") {
      const headers = getCorsHeaders(req);

      if (req.method === "OPTIONS") {
        const corsHeaders = getCorsHeaders(req);
        corsHeaders.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        corsHeaders.set("Access-Control-Allow-Headers", "Content-Type");
        return new Response(null, { headers: corsHeaders });
      }

      if (req.method === "GET") {
        return new Response(JSON.stringify({ words: readValidWords() }), { headers });
      }

      if (req.method === "POST") {
        try {
          const body = await req.json();
          const word = typeof body.word === "string" ? body.word.trim() : "";
          if (!word || word.length > 100 || !/^[\p{L}''\-\s]+$/u.test(word)) {
            return new Response(JSON.stringify({ error: "Invalid word" }), {
              status: 400,
              headers,
            });
          }

          const words = readValidWords();
          if (!words.includes(word)) {
            words.push(word);
            try {
              writeValidWords(words);
            } catch {
              return new Response(JSON.stringify({ error: "Failed to save word" }), {
                status: 500,
                headers,
              });
            }
          }

          return new Response(JSON.stringify({ words }), { headers });
        } catch {
          return new Response(JSON.stringify({ error: "Invalid JSON" }), {
            status: 400,
            headers,
          });
        }
      }
    }

    // === API: Analyse (diff + croisement des détections grammaticales) et journal ===
    if (
      path === "/api/analyze" ||
      path === "/api/journal" ||
      path === PROGRESS_PATH ||
      path === "/api/badges" ||
      RULE_PATHS.has(path)
    ) {
      const headers = getCorsHeaders(req);

      if (req.method === "OPTIONS") {
        headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
        headers.set("Access-Control-Allow-Headers", "Content-Type");
        return new Response(null, { headers });
      }

      if (path === "/api/analyze" && req.method === "POST") {
        // corps JSON non typé, validé ci-dessous
        let body: any;
        try {
          body = await req.json();
        } catch {
          return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers });
        }
        const { original, corrected, matches } = body ?? {};
        if (
          typeof original !== "string" ||
          typeof corrected !== "string" ||
          !Array.isArray(matches) ||
          original.length > MAX_ANALYZE_LENGTH ||
          corrected.length > MAX_ANALYZE_LENGTH
        ) {
          return new Response(JSON.stringify({ error: "Invalid payload" }), {
            status: 400,
            headers,
          });
        }
        const validMatches = matches.filter(
          (m) =>
            m &&
            typeof m.offset === "number" &&
            typeof m.length === "number" &&
            typeof m.rule?.id === "string",
        );
        const analysis = analyze(original, corrected, validMatches);
        // L'état des règles est mis à jour ici ; le serveur décide de ce qui
        // s'affiche près du bouton Copier (astuce, choix à deux formes, réussite).
        const suivi = journal.record(analysis, Date.now(), { original });
        // Badges : une erreur de calcul n'empêche jamais l'analyse.
        const nouveauxBadges = awardBadgesSafely(journal.badges);
        return new Response(
          JSON.stringify({
            ...analysis,
            week: journal.period(SCORE_WINDOW_DAYS),
            ...suivi,
            nouveauxBadges,
          }),
          { headers },
        );
      }

      // Badges de progression : catalogue complet, obtenus ou non.
      if (path === "/api/badges" && req.method === "GET") {
        return new Response(JSON.stringify(journal.badges.catalogue()), { headers });
      }

      // Cycle de vie des règles : lecture pour le tableau de bord et les badges.
      if (path === "/api/rules" && req.method === "GET") {
        const rules = journal.rules();
        const counts = Object.fromEntries(
          ETATS_CYCLE.map((etat) => [etat, rules.filter((r) => r.state === etat).length]),
        );
        return new Response(JSON.stringify({ rules, counts, thresholds: SEUILS }), { headers });
      }

      if (path === "/api/rules/events" && req.method === "GET") {
        const limit = Number(url.searchParams.get("limit") ?? 200);
        const events = journal.ruleEvents({
          limit: Number.isFinite(limit) ? limit : 200,
          ruleKey: url.searchParams.get("ruleKey") ?? undefined,
        });
        return new Response(JSON.stringify({ events }), { headers });
      }

      // Réponse au choix à deux formes du bouton Copier.
      if (path === "/api/rules/answer" && req.method === "POST") {
        // corps JSON non typé, validé ci-dessous
        let body: any;
        try {
          body = await req.json();
        } catch {
          return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers });
        }
        if (!Number.isSafeInteger(body?.choiceId) || typeof body?.correct !== "boolean") {
          return new Response(JSON.stringify({ error: "Invalid payload" }), {
            status: 400,
            headers,
          });
        }
        const result = journal.answerChoice(body.choiceId, body.correct);
        if (result === "unknown") {
          return new Response(JSON.stringify({ error: "Unknown choice" }), {
            status: 404,
            headers,
          });
        }
        if (result === "conflict") {
          return new Response(JSON.stringify({ error: "Choice already answered or replaced" }), {
            status: 409,
            headers,
          });
        }
        const nouveauxBadges = awardBadgesSafely(journal.badges);
        return new Response(JSON.stringify({ recorded: true, nouveauxBadges }), { headers });
      }

      if (path === PROGRESS_PATH && req.method === "GET") {
        return new Response(JSON.stringify(journal.progress()), { headers });
      }

      if (path === "/api/journal" && req.method === "GET") {
        const days = parsePeriodDays(url.searchParams.get("days"));
        return new Response(JSON.stringify(journal.summary(days)), { headers });
      }

      if (path === "/api/journal" && req.method === "DELETE") {
        journal.purge();
        return new Response(JSON.stringify({ purged: true }), { headers });
      }

      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers,
      });
    }

    // === API: Correcteur grammatical intégré (règles LanguageTool) ===
    if (path === "/api/check") {
      const headers = getCorsHeaders(req);

      if (req.method === "OPTIONS") {
        headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
        headers.set("Access-Control-Allow-Headers", "Content-Type");
        return new Response(null, { headers });
      }

      if (req.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
          status: 405,
          headers,
        });
      }

      let text: unknown;
      try {
        ({ text } = (await req.json()) as { text?: unknown });
      } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers });
      }
      if (typeof text !== "string" || !text.trim() || text.length > MAX_ANALYZE_LENGTH) {
        return new Response(JSON.stringify({ error: "Invalid payload" }), {
          status: 400,
          headers,
        });
      }

      try {
        const matches = await grammar.check(text);
        return new Response(JSON.stringify({ matches }), { headers });
      } catch (error) {
        console.error("[Grammar] Check failed:", error);
        return new Response(JSON.stringify({ error: "Grammar checker unavailable" }), {
          status: 503,
          headers,
        });
      }
    }

    // === API: LLM — Chat Completions (OpenAI SDK → OTEL instrumented) ===
    if (path === "/v1/chat/completions" && req.method === "POST") {
      console.log("[LLM] Chat completion via SDK");
      const startTime = Date.now();

      // Large inputs can spend >10s in prefill before the first token. Bun.serve
      // closes idle connections after 10s by default, which aborted the request
      // with an HTTP 500 and then crashed the process via the SSE keepalive
      // (issue #17). Disable the idle timeout for this streaming route only.
      server.timeout(req, 0);

      const span = tracer.startSpan("llm.chat", {
        kind: SpanKind.CLIENT,
      });

      try {
        // req.json() returns unknown JSON structure
        const body = (await req.json()) as any;

        // Extraire les métadonnées de correction (non transmises à vLLM)
        const correctionMode: string = body.correction_mode ?? "unknown";
        const { correction_mode: _mode, ...llmBody } = body;

        // Extraire le texte d'entrée depuis le dernier message user
        const messages: Array<{ role: string; content: string }> = llmBody.messages ?? [];
        const userMessage = [...messages].reverse().find((m) => m.role === "user");
        const inputText: string = userMessage?.content ?? "";

        const resolvedModel = await resolveModel(config.llmModelName, llmBody.model, detectModel);
        span.setAttributes({
          "openinference.span.kind": "LLM",
          "llm.model_name": resolvedModel,
          "input.value": JSON.stringify(messages),
          "input.mime_type": "application/json",
          "input.text": inputText.slice(0, 2000),
          "correction.mode": correctionMode,
        });

        // Un modèle à raisonnement (Qwen3…) réfléchit avant d'écrire : plusieurs
        // secondes sans aucun texte affiché. Il est coupé par défaut.
        let disableThinking = config.llmDisableThinking && !thinkingParamRejected;
        const extraParams = disableThinking
          ? { chat_template_kwargs: { enable_thinking: false } }
          : {};

        const createParams = {
          ...llmBody,
          model: resolvedModel,
          stream: true,
          // -1 désactive top_k pour SGLang, comme son absence : on ne l'envoie
          // que s'il est fixé, car des API compatibles OpenAI refusent ce paramètre.
          ...(config.llmTopK > 0 ? { top_k: config.llmTopK } : {}),
          ...extraParams,
        };
        type LlmChunk = {
          choices?: Array<{
            delta?: { content?: string; reasoning_content?: string; reasoning?: string };
          }>;
        };
        const openStream = async (params: object) =>
          // OpenAI SDK requires escape hatch for spread params
          (await llmClient.chat.completions.create(
            params as any,
          )) as unknown as AsyncIterable<LlmChunk>;

        let stream: AsyncIterable<LlmChunk>;
        try {
          stream = await openStream(createParams);
        } catch (err) {
          // API qui refuse le paramètre de raisonnement : relancer sans lui.
          if (!disableThinking || !isThinkingParamRejection(err)) throw err;
          console.warn(
            "[LLM] chat_template_kwargs refusé par le serveur du modèle : relance sans ce paramètre.",
          );
          thinkingParamRejected = true;
          disableThinking = false;
          const { chat_template_kwargs: _kwargs, ...withoutThinking } = createParams as any;
          stream = await openStream(withoutThinking);
        }

        const encoder = new TextEncoder();
        const readable = new ReadableStream({
          async start(controller) {
            let fullContent = "";
            // Must stay below Bun.serve's idle timeout (10s default) so the
            // keepalive actually prevents idle disconnects (issue #17).
            const keepaliveIntervalMs = 5_000;
            let keepaliveId: ReturnType<typeof setInterval> | null = null;

            function stopKeepalive(): void {
              if (keepaliveId) {
                clearInterval(keepaliveId);
                keepaliveId = null;
              }
            }

            // A client disconnect or an idle-timeout close can close the stream
            // controller while the keepalive interval is still firing. Guard
            // every enqueue so a closed controller can never throw uncaught and
            // crash the process (issue #17).
            function safeEnqueue(chunk: Uint8Array): boolean {
              try {
                controller.enqueue(chunk);
                return true;
              } catch {
                stopKeepalive();
                return false;
              }
            }

            function startKeepalive(): void {
              keepaliveId = setInterval(() => {
                safeEnqueue(encoder.encode(": keepalive\n\n"));
              }, keepaliveIntervalMs);
            }

            // Où passe le temps : délai avant le premier mot, et raisonnement
            // éventuel du modèle (fragments reçus mais jamais affichés).
            let firstTokenMs: number | null = null;
            let reasoningChunks = 0;

            try {
              startKeepalive();
              try {
                for await (const chunk of stream) {
                  const choiceDelta = chunk.choices?.[0]?.delta;
                  if (choiceDelta?.reasoning_content || choiceDelta?.reasoning) reasoningChunks++;
                  const delta: string = choiceDelta?.content ?? "";
                  if (!delta) continue;
                  firstTokenMs ??= Date.now() - startTime;
                  fullContent += delta;
                  // The model answers with the corrected text only: forward each
                  // fragment so the client can display it as it arrives.
                  safeEnqueue(encoder.encode(`data: ${JSON.stringify({ delta })}\n\n`));
                }
              } catch (loopErr) {
                // Issue #14: at the end of a successful stream, Bun/Node can
                // double-close the response-body ReadableStream controller and
                // surface "Controller is already closed" from the SDK iterator.
                // The stream has already delivered all its data (fullContent is
                // complete), so fall through to the normal `done` event
                // instead of turning a completed ~12s stream into an error. Any
                // other error is rethrown to the outer catch (→ SSE error event).
                if (isStreamTeardownError(loopErr)) {
                  console.warn(`[LLM] Stream teardown race ignored: ${String(loopErr)}`);
                } else {
                  throw loopErr;
                }
              }

              const totalDuration = Date.now() - startTime;
              const outputText = cleanLlmOutput(fullContent);

              console.log(
                `[LLM] Stream terminé en ${totalDuration}ms (premier mot après ${firstTokenMs ?? "—"}ms, ` +
                  `fragments de raisonnement : ${reasoningChunks}, raisonnement coupé : ${disableThinking})`,
              );
              span.setAttributes({
                "llm.first_token_ms": firstTokenMs ?? -1,
                "llm.reasoning_chunks": reasoningChunks,
                "output.text": outputText.slice(0, 2000),
                "output.value": fullContent.slice(0, 2000),
                "output.mime_type": "text/plain",
              });
              span.setStatus({ code: SpanStatusCode.OK });
              span.end();

              safeEnqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ done: true, text: outputText, duration: totalDuration, firstTokenMs, reasoningChunks })}\n\n`,
                ),
              );
            } catch (err) {
              span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
              span.end();
              safeEnqueue(encoder.encode(`data: ${JSON.stringify({ error: String(err) })}\n\n`));
            } finally {
              stopKeepalive();
              try {
                controller.close();
              } catch {
                /* stream already closed by the client */
              }
            }
          },
        });

        const headers = getCorsHeaders(req);
        headers.set("Content-Type", "text/event-stream");
        headers.set("Cache-Control", "no-cache");
        headers.set("X-Accel-Buffering", "no");
        return new Response(readable, { headers });
      } catch (error) {
        const duration = Date.now() - startTime;
        console.error(
          `[LLM] Erreur après ${duration}ms:`,
          error instanceof Error ? error.message : error,
        );
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : "Unknown error",
        });
        span.end();
        return new Response(
          JSON.stringify({
            error: "LLM unavailable",
            details: error instanceof Error ? error.message : "Unknown error",
          }),
          { status: 502, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    // === API: LLM Proxy (fallback for other LLM routes) ===
    if (path.startsWith("/v1/")) {
      const llmPath = path;
      const llmUrl = `${config.llmTarget}${llmPath}${url.search}`;

      try {
        // Override Authorization with the real LLM API key (frontend sends a placeholder)
        // and drop Host & co., which describe the browser → Grammaria hop.
        const proxyHeaders = upstreamHeaders(req.headers, config.llmApiKey);

        const llmResponse = await fetch(llmUrl, {
          method: req.method,
          headers: proxyHeaders,
          body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
          redirect: "follow",
        });

        const responseHeaders = downstreamHeaders(llmResponse.headers);
        const origin = req.headers.get("Origin") ?? "";
        const isLocalhost = origin.includes("localhost") || origin.includes("127.0.0.1");
        const allowed = isLocalhost || config.corsOrigins.some((o) => origin === o);
        responseHeaders.set("Access-Control-Allow-Origin", allowed ? origin : "");

        return new Response(llmResponse.body, {
          status: llmResponse.status,
          headers: responseHeaders,
        });
      } catch {
        return new Response(JSON.stringify({ error: "LLM unavailable" }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // === Static Files ===
    let filePath = join(DIST_DIR, path === "/" ? "index.html" : path);

    // Path traversal protection
    const resolved = resolve(filePath);
    if (!resolved.startsWith(DIST_DIR)) {
      return new Response("Forbidden", { status: 403 });
    }

    if (!existsSync(filePath)) {
      filePath = join(DIST_DIR, "index.html");
    }

    return new Response(Bun.file(filePath));
  },
});

console.log(`🚀 Grammaria server running on http://${config.host}:${config.port}`);

// Application de bureau : la coquille garde un tube ouvert sur l'entrée
// standard du serveur. S'il se ferme (fermeture, plantage ou arrêt forcé de
// l'application), le serveur s'arrête au lieu de rester orphelin avec ~1 Go
// de mémoire.
if (process.env.GRAMMARIA_EXIT_WITH_PARENT === "1") {
  const exitWithParent = () => {
    console.log("[Desktop] Application fermée : arrêt du serveur.");
    process.exit(0);
  };
  process.stdin.on("end", exitWithParent);
  process.stdin.on("close", exitWithParent);
  process.stdin.resume();
}
