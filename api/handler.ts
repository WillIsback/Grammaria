import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { analyze } from "../src/analysis/analyze.ts";
import { compterEtats } from "../src/analysis/regles/cycle.ts";
import { SEUILS } from "../src/analysis/regles/seuils.ts";
import { parsePeriodDays } from "../src/analysis/score.ts";
import { cleanLlmOutput } from "../src/utils/llmText.ts";
import { creerDetecteurModele } from "../src/utils/modeles.ts";
import { isStreamTeardownError } from "../src/utils/streamErrors.ts";
import {
  downstreamHeaders,
  isThinkingParamRejection,
  resolveModel,
} from "../src/utils/upstream.ts";
import type { DependancesApi, FragmentModele, JournalDeps } from "./deps.ts";
import { parseUpdate } from "./reglages.ts";

/**
 * Gestionnaire des routes d'API (`/api/*`) et du relais du modèle (`/v1/*`).
 *
 * Source unique partagée par le serveur Bun (`server.ts`) et l'application de
 * bureau, où il tourne dans la WebView (appelé à la place de `window.fetch`).
 * Il n'importe rien de Bun ni de Node : seulement des API web standard
 * (`Request`, `Response`, `Headers`, `URL`, `ReadableStream`, `TextEncoder`).
 * Le journal, le correcteur, les réglages, les mots valides et le modèle sont
 * injectés (`api/deps.ts`).
 *
 * Le contrôle de l'hôte et de l'origine du mode bureau (DNS rebinding, CSRF)
 * n'est pas ici : il protège le port local du serveur Bun, absent du bureau.
 */

/** Taille maximale d'un texte accepté par /api/check et /api/analyze (caractères). */
const MAX_ANALYZE_LENGTH = 20_000;
/** Routes de l'analyse et du journal (badges, progression, cycle de vie des règles). */
const JOURNAL_PATHS = new Set([
  "/api/analyze",
  "/api/journal",
  "/api/progress",
  "/api/badges",
  "/api/rules",
  "/api/rules/events",
  "/api/rules/answer",
]);
/** Fenêtre de la note moyenne affichée près du bouton copier (jours). */
const SCORE_WINDOW_DAYS = 7;

/** En-têtes des erreurs du relais LLM : sans CORS. */
const JSON_ONLY = { "Content-Type": "application/json" };

/** Origine servie depuis cette machine : le nom d'hôte exact, pas une sous-chaîne. */
function isLocalOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function json(body: unknown, headers: HeadersInit, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

/** Réponse à une pré-vérification CORS (OPTIONS). */
function preflight(headers: Headers, methods: string): Response {
  headers.set("Access-Control-Allow-Methods", methods);
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  return new Response(null, { headers });
}

/** Corps JSON non typé de la requête, validé par l'appelant ; undefined s'il est illisible. */
async function readJson(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

/** Badges : une erreur de calcul n'empêche jamais l'analyse ni la réponse. */
async function awardBadgesSafely(journal: JournalDeps) {
  try {
    return await journal.badges.award();
  } catch (error) {
    console.error("[Badges] Évaluation impossible :", error);
    return [];
  }
}

/**
 * Crée le gestionnaire. Il renvoie null quand la requête ne relève pas de
 * l'API : l'appelant sert alors les fichiers statiques.
 */
export function creerGestionnaire(
  deps: DependancesApi,
): (req: Request) => Promise<Response | null> {
  const { journal, correcteur, reglages, motsValides, modele, options } = deps;
  const horloge = options.horloge ?? Date.now;
  const tracer = trace.getTracer("grammaria");

  /** Modèle par défaut du serveur LLM, quand ni la config ni l'interface n'en fixent un. */
  const detectModel = creerDetecteurModele(() => modele.listerModeles());

  /**
   * Vrai quand le serveur du modèle a refusé `chat_template_kwargs` (paramètre
   * de vLLM / SGLang qui coupe le raisonnement) : on ne le renvoie plus jusqu'au
   * prochain changement de réglages.
   */
  let thinkingParamRejected = false;

  /** Nouveaux réglages : nouveau serveur de modèle possible, on oublie ce qu'on en savait. */
  function oublierModele(): void {
    thinkingParamRejected = false;
    detectModel.oublier();
  }

  /** Origine de la requête si elle a le droit de lire la réponse (CORS), sinon null. */
  function allowedOrigin(req: Request): string | null {
    const origin = req.headers.get("Origin") ?? "";
    return isLocalOrigin(origin) || options.originesCors.includes(origin) ? origin : null;
  }

  function getCorsHeaders(req: Request): Headers {
    const headers = new Headers({ "Content-Type": "application/json" });
    const origin = allowedOrigin(req);
    if (origin !== null) headers.set("Access-Control-Allow-Origin", origin);
    return headers;
  }

  return async function gestionnaire(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    const path = url.pathname;

    // === API: Réglages du LLM (modifiables en mode bureau uniquement) ===
    if (path === "/api/settings") {
      const headers = getCorsHeaders(req);
      if (req.method === "GET") return json(await reglages.vuePublique(), headers);
      if (req.method === "PUT") {
        const vue = await reglages.vuePublique();
        if (!vue.editable) return json({ error: "Settings are read-only" }, headers, 403);
        try {
          const view = await reglages.mettreAJour(parseUpdate(await req.json()));
          oublierModele();
          return json(view, headers);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Invalid settings";
          return json({ error: message }, headers, 400);
        }
      }
      return json({ error: "Method not allowed" }, headers, 405);
    }

    // === API: Valid Words ===
    // Les autres méthodes n'ont pas de 405 : elles retombent sur les fichiers statiques.
    if (path === "/api/valid-words") {
      const headers = getCorsHeaders(req);

      if (req.method === "OPTIONS") return preflight(headers, "GET, POST, OPTIONS");

      if (req.method === "GET") return json({ words: await motsValides.lire() }, headers);

      if (req.method === "POST") {
        const body = await readJson(req);
        // null aussi : il n'a pas de champ à lire.
        if (body == null) return json({ error: "Invalid JSON" }, headers, 400);
        const word = typeof body.word === "string" ? body.word.trim() : "";
        if (!word || word.length > 100 || !/^[\p{L}''\-\s]+$/u.test(word)) {
          return json({ error: "Invalid word" }, headers, 400);
        }

        try {
          return json({ words: await motsValides.ajouter(word) }, headers);
        } catch (error) {
          // Bureau : Rust valide le mot à son tour et répond « Invalid word ».
          if (error instanceof Error && error.message === "Invalid word") {
            return json({ error: "Invalid word" }, headers, 400);
          }
          return json({ error: "Failed to save word" }, headers, 500);
        }
      }
      return null;
    }

    // === API: Analyse (diff + croisement des détections grammaticales) et journal ===
    if (JOURNAL_PATHS.has(path)) {
      const headers = getCorsHeaders(req);

      if (req.method === "OPTIONS") return preflight(headers, "GET, POST, DELETE, OPTIONS");

      if (path === "/api/analyze" && req.method === "POST") {
        const body = await readJson(req);
        if (body === undefined) return json({ error: "Invalid JSON" }, headers, 400);
        const { original, corrected, matches } = body ?? {};
        if (
          typeof original !== "string" ||
          typeof corrected !== "string" ||
          !Array.isArray(matches) ||
          original.length > MAX_ANALYZE_LENGTH ||
          corrected.length > MAX_ANALYZE_LENGTH
        ) {
          return json({ error: "Invalid payload" }, headers, 400);
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
        const suivi = await journal.record(analysis, horloge(), { original });
        // Badges : une erreur de calcul n'empêche jamais l'analyse.
        const nouveauxBadges = await awardBadgesSafely(journal);
        return json(
          {
            ...analysis,
            week: await journal.period(SCORE_WINDOW_DAYS),
            ...suivi,
            nouveauxBadges,
          },
          headers,
        );
      }

      // Badges de progression : catalogue complet, obtenus ou non.
      if (path === "/api/badges" && req.method === "GET") {
        return json(await journal.badges.catalogue(), headers);
      }

      // Cycle de vie des règles : lecture pour le tableau de bord et les badges.
      if (path === "/api/rules" && req.method === "GET") {
        const rules = await journal.rules();
        return json({ rules, counts: compterEtats(rules), thresholds: SEUILS }, headers);
      }

      if (path === "/api/rules/events" && req.method === "GET") {
        const limit = Number(url.searchParams.get("limit") ?? 200);
        const events = await journal.ruleEvents({
          limit: Number.isFinite(limit) ? limit : 200,
          ruleKey: url.searchParams.get("ruleKey") ?? undefined,
        });
        return json({ events }, headers);
      }

      // Réponse au choix à deux formes du bouton Copier.
      if (path === "/api/rules/answer" && req.method === "POST") {
        const body = await readJson(req);
        if (body === undefined) return json({ error: "Invalid JSON" }, headers, 400);
        if (!Number.isSafeInteger(body?.choiceId) || typeof body?.correct !== "boolean") {
          return json({ error: "Invalid payload" }, headers, 400);
        }
        const result = await journal.answerChoice(body.choiceId, body.correct);
        if (result === "unknown") return json({ error: "Unknown choice" }, headers, 404);
        if (result === "conflict") {
          return json({ error: "Choice already answered or replaced" }, headers, 409);
        }
        const nouveauxBadges = await awardBadgesSafely(journal);
        return json({ recorded: true, nouveauxBadges }, headers);
      }

      // Écran « Progression » : tout l'écran en une seule requête (issue #15).
      if (path === "/api/progress" && req.method === "GET") {
        return json(await journal.progress(), headers);
      }

      if (path === "/api/journal" && req.method === "GET") {
        const days = parsePeriodDays(url.searchParams.get("days"));
        return json(await journal.summary(days), headers);
      }

      if (path === "/api/journal" && req.method === "DELETE") {
        await journal.purge();
        return json({ purged: true }, headers);
      }

      return json({ error: "Method not allowed" }, headers, 405);
    }

    // === API: Correcteur grammatical intégré (règles LanguageTool) ===
    if (path === "/api/check") {
      const headers = getCorsHeaders(req);

      if (req.method === "OPTIONS") return preflight(headers, "POST, OPTIONS");

      if (req.method !== "POST") return json({ error: "Method not allowed" }, headers, 405);

      const body = await readJson(req);
      // null aussi : il n'a pas de champ à lire.
      if (body == null) return json({ error: "Invalid JSON" }, headers, 400);
      const text: unknown = body.text;
      if (typeof text !== "string" || !text.trim() || text.length > MAX_ANALYZE_LENGTH) {
        return json({ error: "Invalid payload" }, headers, 400);
      }

      try {
        const matches = await correcteur.check(text);
        return json({ matches }, headers);
      } catch (error) {
        console.error("[Grammar] Check failed:", error);
        return json({ error: "Grammar checker unavailable" }, headers, 503);
      }
    }

    // === API: LLM — Chat Completions (flux du modèle → OTEL instrumented) ===
    if (path === "/v1/chat/completions" && req.method === "POST") {
      console.log("[LLM] Chat completion via SDK");
      const startTime = horloge();

      const span = tracer.startSpan("llm.chat", {
        kind: SpanKind.CLIENT,
      });

      // Annule la requête au modèle quand l'interface abandonne le flux.
      const abort = new AbortController();
      // Bureau : l'abandon de la requête par l'interface annule aussi l'attente du premier
      // fragment (le flux de réponse n'existe pas encore).
      if (options.suivreAbandonRequete) {
        req.signal.addEventListener("abort", () => abort.abort(), { once: true });
      }

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

        const vue = await reglages.vuePublique();
        const resolvedModel = await resolveModel(vue.llmModelName, llmBody.model, detectModel);
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
        let disableThinking = vue.llmDisableThinking && !thinkingParamRejected;
        const extraParams = disableThinking
          ? { chat_template_kwargs: { enable_thinking: false } }
          : {};

        const createParams = {
          ...llmBody,
          model: resolvedModel,
          stream: true,
          // -1 désactive top_k pour SGLang, comme son absence : on ne l'envoie
          // que s'il est fixé, car des API compatibles OpenAI refusent ce paramètre.
          ...(options.llmTopK > 0 ? { top_k: options.llmTopK } : {}),
          ...extraParams,
        };

        let stream: AsyncIterable<FragmentModele>;
        try {
          stream = await modele.ouvrirFlux(createParams, abort.signal);
        } catch (err) {
          // API qui refuse le paramètre de raisonnement : relancer sans lui.
          if (!disableThinking || !isThinkingParamRejection(err)) throw err;
          console.warn(
            "[LLM] chat_template_kwargs refusé par le serveur du modèle : relance sans ce paramètre.",
          );
          thinkingParamRejected = true;
          disableThinking = false;
          const { chat_template_kwargs: _kwargs, ...withoutThinking } = createParams;
          stream = await modele.ouvrirFlux(withoutThinking, abort.signal);
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
                for await (const fragment of stream) {
                  if (fragment.reasoning) reasoningChunks++;
                  reasoningChunks += fragment.reasoningChunks ?? 0;
                  const delta: string = fragment.content ?? "";
                  if (!delta) continue;
                  firstTokenMs ??= horloge() - startTime;
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

              const totalDuration = horloge() - startTime;
              const outputText = cleanLlmOutput(fullContent);

              console.log(
                `[LLM] Stream terminé en ${totalDuration}ms (premier mot après ${firstTokenMs ?? "—"}ms, ` +
                  `fragments de raisonnement : ${reasoningChunks}, raisonnement coupé : ${disableThinking})`,
              );
              try {
                options.surFinCorrection?.({
                  dureeMs: totalDuration,
                  premierMotMs: firstTokenMs,
                  fragmentsRaisonnement: reasoningChunks,
                  raisonnementCoupe: disableThinking,
                });
              } catch {
                /* un journal en échec n'interrompt pas la réponse */
              }
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
          cancel() {
            abort.abort();
          },
        });

        const headers = getCorsHeaders(req);
        headers.set("Content-Type", "text/event-stream");
        headers.set("Cache-Control", "no-cache");
        headers.set("X-Accel-Buffering", "no");
        return new Response(readable, { headers });
      } catch (error) {
        const duration = horloge() - startTime;
        console.error(
          `[LLM] Erreur après ${duration}ms:`,
          error instanceof Error ? error.message : error,
        );
        const message = error instanceof Error ? error.message : "Unknown error";
        span.setStatus({ code: SpanStatusCode.ERROR, message });
        span.end();
        return json({ error: "LLM unavailable", details: message }, JSON_ONLY, 502);
      }
    }

    // === API: LLM Proxy (fallback for other LLM routes) ===
    if (path.startsWith("/v1/")) {
      try {
        let llmResponse: Response;
        if (modele.relayer) {
          llmResponse = await modele.relayer(req);
        } else if (path === "/v1/models" && req.method === "GET") {
          llmResponse = json(await modele.listerModeles(), JSON_ONLY);
        } else {
          llmResponse = json({ error: "Not found" }, JSON_ONLY, 404);
        }

        // Déjà fait par le relais du serveur ; sans effet sur une réponse construite ici.
        const responseHeaders = downstreamHeaders(llmResponse.headers);
        responseHeaders.set("Access-Control-Allow-Origin", allowedOrigin(req) ?? "");

        return new Response(llmResponse.body, {
          status: llmResponse.status,
          headers: responseHeaders,
        });
      } catch {
        return json({ error: "LLM unavailable" }, JSON_ONLY, 502);
      }
    }

    return null;
  };
}
