// Telemetry MUST be imported first — instruments OpenAI SDK before it loads
import "./telemetry.ts";

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import OpenAI from "openai";
import { config } from "./config.ts";
import { Journal } from "./journal.ts";
import { analyze } from "./src/analysis/analyze.ts";
import { cleanLlmOutput } from "./src/utils/llmText.ts";
import { isStreamTeardownError } from "./src/utils/streamErrors.ts";

const tracer = trace.getTracer("grammaria");

const PORT = config.port;
const DIST_DIR = join(import.meta.dir, "dist");
const VALID_WORDS_PATH = join(import.meta.dir, "public", "data", "valid-words.json");

const journal = new Journal(config.journalPath);

/** Taille maximale d'un texte accepté par /api/analyze (caractères). */
const MAX_ANALYZE_LENGTH = 20_000;
/** Fenêtre de la note moyenne affichée près du bouton copier (jours). */
const SCORE_WINDOW_DAYS = 7;

const llmClient = new OpenAI({
  baseURL: `${config.llmTarget}/v1`,
  apiKey: config.llmApiKey || "unused",
});

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
  async fetch(req: Request, server: Bun.Server): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

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

    // === API: Analyse (diff + croisement LanguageTool) et journal ===
    if (path === "/api/analyze" || path === "/api/journal") {
      const headers = getCorsHeaders(req);

      if (req.method === "OPTIONS") {
        headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
        headers.set("Access-Control-Allow-Headers", "Content-Type");
        return new Response(null, { headers });
      }

      if (path === "/api/analyze" && req.method === "POST") {
        // biome-ignore lint/suspicious/noExplicitAny: corps JSON non typé, validé ci-dessous
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
        journal.record(analysis);
        return new Response(
          JSON.stringify({ ...analysis, week: journal.period(SCORE_WINDOW_DAYS) }),
          { headers },
        );
      }

      if (path === "/api/journal" && req.method === "GET") {
        const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 7, 1), 365);
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

    // === API: LanguageTool Proxy ===
    if (path.startsWith("/api/lt/")) {
      const ltPath = path.replace("/api/lt", "");
      const ltUrl = `${config.ltTarget}${ltPath}${url.search}`;

      try {
        const ltResponse = await fetch(ltUrl, {
          method: req.method,
          headers: req.headers,
          body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
          redirect: "follow",
        });

        const responseHeaders = new Headers(ltResponse.headers);
        const origin = req.headers.get("Origin") ?? "";
        const isLocalhost = origin.includes("localhost") || origin.includes("127.0.0.1");
        const allowed = isLocalhost || config.corsOrigins.some((o) => origin === o);
        responseHeaders.set("Access-Control-Allow-Origin", allowed ? origin : "");

        return new Response(ltResponse.body, {
          status: ltResponse.status,
          headers: responseHeaders,
        });
      } catch {
        return new Response(JSON.stringify({ error: "LanguageTool unavailable" }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
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
        // biome-ignore lint/suspicious/noExplicitAny: req.json() returns unknown JSON structure
        const body = (await req.json()) as any;

        // Extraire les métadonnées de correction (non transmises à vLLM)
        const correctionMode: string = body.correction_mode ?? "unknown";
        const { correction_mode: _mode, ...llmBody } = body;

        // Extraire le texte d'entrée depuis le dernier message user
        const messages: Array<{ role: string; content: string }> = llmBody.messages ?? [];
        const userMessage = [...messages].reverse().find((m) => m.role === "user");
        const inputText: string = userMessage?.content ?? "";

        const resolvedModel = config.llmModelName || llmBody.model || "unknown";
        span.setAttributes({
          "openinference.span.kind": "LLM",
          "llm.model_name": resolvedModel,
          "input.value": JSON.stringify(messages),
          "input.mime_type": "application/json",
          "input.text": inputText.slice(0, 2000),
          "correction.mode": correctionMode,
        });

        const extraParams = config.llmDisableThinking
          ? { chat_template_kwargs: { enable_thinking: false } }
          : {};

        const createParams = {
          ...llmBody,
          model: resolvedModel,
          stream: true,
          top_k: config.llmTopK,
          ...extraParams,
        };
        // biome-ignore lint/suspicious/noExplicitAny: OpenAI SDK requires escape hatch for spread params
        const stream = (await llmClient.chat.completions.create(
          createParams as any,
        )) as unknown as AsyncIterable<{
          choices?: Array<{ delta?: { content?: string } }>;
        }>;

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

            try {
              startKeepalive();
              try {
                for await (const chunk of stream) {
                  const delta: string = chunk.choices?.[0]?.delta?.content ?? "";
                  if (!delta) continue;
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

              console.log(`[LLM] Stream terminé en ${totalDuration}ms`);
              span.setAttributes({
                "output.text": outputText.slice(0, 2000),
                "output.value": fullContent.slice(0, 2000),
                "output.mime_type": "text/plain",
              });
              span.setStatus({ code: SpanStatusCode.OK });
              span.end();

              safeEnqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ done: true, text: outputText, duration: totalDuration })}\n\n`,
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
        const proxyHeaders = new Headers(req.headers);
        if (config.llmApiKey) proxyHeaders.set("Authorization", `Bearer ${config.llmApiKey}`);

        const llmResponse = await fetch(llmUrl, {
          method: req.method,
          headers: proxyHeaders,
          body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
          redirect: "follow",
        });

        const responseHeaders = new Headers(llmResponse.headers);
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

console.log(`🚀 Grammaria server running on http://localhost:${config.port}`);
