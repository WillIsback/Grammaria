// Télémétrie importée en premier : elle installe le fournisseur de traces
// OpenTelemetry (export OTLP) avant toute autre chose. Elle n'instrumente pas
// le SDK OpenAI : les traces sont créées à la main par `api/handler.ts`.
import "./telemetry.ts";

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import OpenAI from "openai";
import { creerGestionnaire } from "./api/handler.ts";
import type { FragmentModele, ModeleDeps } from "./api/deps.ts";
import { config } from "./config.ts";
import { GrammarChecker } from "./grammar.ts";
import { SettingsStore } from "./settings.ts";
import { Journal } from "./journal.ts";
import { ouvrirPiloteBun } from "./journal.driver.bun.ts";
import { listerModelesAmont } from "./src/utils/modeles.ts";
import { downstreamHeaders, upstreamHeaders } from "./src/utils/upstream.ts";

/**
 * Serveur Bun (version web, Docker ou serveur local) : fichiers de l'interface,
 * contrôles du mode bureau, et dépendances réelles (SQLite, fichiers, SDK OpenAI)
 * du gestionnaire d'API. Les routes `/api/*` et `/v1/*` sont dans
 * `api/handler.ts`, partagé avec l'application de bureau (qui ne lance pas ce
 * serveur : le gestionnaire y tourne dans la page).
 */

const DIST_DIR = resolve(config.distDir || join(import.meta.dir, "dist"));
const VALID_WORDS_PATH =
  config.validWordsPath || join(import.meta.dir, "public", "data", "valid-words.json");

// En mode bureau, les réglages du LLM saisis dans l'interface remplacent ceux
// de l'environnement (chargés ici, avant la création du client).
const settings = new SettingsStore(
  config.desktop && config.settingsPath ? config.settingsPath : null,
);

// Journal impossible à ouvrir (créé par une version plus récente, fichier
// abîmé, dossier interdit) : arrêt net avec la cause, sans pile d'appels.
async function ouvrirJournal(): Promise<Journal> {
  try {
    return await Journal.ouvrir(ouvrirPiloteBun(config.journalPath));
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    console.error(`[Journal] Impossible d'ouvrir ${config.journalPath} : ${cause}`);
    process.exit(1);
  }
}
const journal = await ouvrirJournal();

const grammar = new GrammarChecker();
grammar.warmUp();

// Arrêt du serveur (docker stop, Ctrl+C) : sortie propre, et le moteur grammatical
// s'arrête avec lui (grammar.ts tue à la sortie tout moteur encore en vie). Sans
// gestionnaire, Bun lancé en PID 1 dans le conteneur ignorerait SIGTERM.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    grammar.close();
    process.exit(0);
  });
}

let llmClient: OpenAI;

/** (Re)crée le client du LLM ; rappelé quand les réglages changent (mode bureau). */
function connectLlm(): void {
  llmClient = new OpenAI({
    baseURL: `${config.llmTarget}/v1`,
    apiKey: config.llmApiKey || "unused",
  });
}
connectLlm();

/**
 * Mode bureau (serveur local d'un seul utilisateur, GRAMMARIA_DESKTOP=1) : le
 * serveur n'écoute qu'en local, mais une page web ouverte
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

type LlmChunk = {
  choices?: Array<{
    delta?: { content?: string; reasoning_content?: string; reasoning?: string };
  }>;
};

/** Fragments du SDK OpenAI → fragments du gestionnaire (texte, raisonnement). */
async function* fragments(stream: AsyncIterable<LlmChunk>): AsyncIterable<FragmentModele> {
  for await (const chunk of stream) {
    const choiceDelta = chunk.choices?.[0]?.delta;
    yield {
      content: choiceDelta?.content,
      reasoning: choiceDelta?.reasoning_content || choiceDelta?.reasoning,
    };
  }
}

/** Serveur du modèle via le SDK OpenAI et relais HTTP brut (les traces OTEL sont posées par `api/handler.ts`). */
const modele: ModeleDeps = {
  listerModeles: () => listerModelesAmont(config.llmTarget, config.llmApiKey),

  async ouvrirFlux(corps, signal) {
    // OpenAI SDK requires escape hatch for spread params
    const stream = (await llmClient.chat.completions.create(corps as any, {
      signal,
    })) as unknown as AsyncIterable<LlmChunk>;
    return fragments(stream);
  },

  async relayer(req) {
    const url = new URL(req.url);
    const llmResponse = await fetch(`${config.llmTarget}${url.pathname}${url.search}`, {
      method: req.method,
      // Override Authorization with the real LLM API key (frontend sends a placeholder)
      // and drop Host & co., which describe the browser → Grammaria hop.
      headers: upstreamHeaders(req.headers, config.llmApiKey),
      body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
      redirect: "follow",
    });
    return new Response(llmResponse.body, {
      status: llmResponse.status,
      headers: downstreamHeaders(llmResponse.headers),
    });
  },
};

const gestionnaireApi = creerGestionnaire({
  journal,
  correcteur: grammar,
  reglages: {
    vuePublique: () => settings.publicView(),
    mettreAJour(update) {
      const view = settings.update(update);
      connectLlm();
      return view;
    },
  },
  motsValides: {
    lire: readValidWords,
    ajouter(word) {
      const words = readValidWords();
      if (!words.includes(word)) {
        words.push(word);
        writeValidWords(words);
      }
      return words;
    },
  },
  modele,
  options: {
    bureau: config.desktop,
    originesCors: config.corsOrigins,
    llmTopK: config.llmTopK,
  },
});

Bun.serve({
  port: config.port,
  hostname: config.host,
  async fetch(req: Request, server: Bun.Server<undefined>): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    const forbidden = rejectForeignRequest(req, url);
    if (forbidden) return forbidden;

    // Large inputs can spend >10s in prefill before the first token. Bun.serve
    // closes idle connections after 10s by default, which aborted the request
    // with an HTTP 500 and then crashed the process via the SSE keepalive.
    // Disable the idle timeout for this streaming route only.
    if (path === "/v1/chat/completions" && req.method === "POST") server.timeout(req, 0);

    // === API (/api/*, /v1/*) : api/handler.ts ===
    const apiResponse = await gestionnaireApi(req);
    if (apiResponse) return apiResponse;

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
