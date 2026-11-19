import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ETATS_CYCLE } from "../src/analysis/regles/cycle.ts";
import { SEUILS } from "../src/analysis/regles/seuils.ts";
import { lancerServeur, type ServeurDeTest } from "./serveur.ts";

/**
 * Contrat HTTP de toutes les routes d'API, sur un vrai serveur lancé dans un
 * processus à part : statuts, en-têtes CORS, corps JSON, méthodes refusées,
 * contrôles du mode bureau. Un faux serveur de modèle (compatible OpenAI)
 * tourne dans ce processus pour les routes /v1/*.
 */

const CLE_API = "sk-secret-de-test";
const LOCAL = "http://localhost:5173";
const ETRANGER = "https://evil.example";

/** Dernière requête reçue par le faux serveur de modèle sur /v1/chat/completions. */
let requeteAmont: { body: Record<string, unknown>; authorization: string | null } | null = null;

const amont = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/v1/models") {
      return Response.json({ data: [{ id: "modele-test" }] }, { headers: { "X-Amont": "oui" } });
    }
    if (pathname === "/v1/chat/completions") {
      requeteAmont = {
        body: (await req.json()) as Record<string, unknown>,
        authorization: req.headers.get("Authorization"),
      };
      const chunk = (content: string) =>
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`;
      return new Response(`${chunk("Bonjour")}${chunk(" à tous.")}data: [DONE]\n\n`, {
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    return new Response("inconnu", { status: 418 });
  },
});
const CIBLE = `http://127.0.0.1:${amont.port}`;

const ENV_LLM = {
  LLM_TARGET: CIBLE,
  LLM_API_KEY: CLE_API,
  LLM_MODEL_NAME: "",
  LLM_DISABLE_THINKING: "true",
  LLM_TOP_K: "-1",
  CORS_ORIGIN: "",
};

let bureau: ServeurDeTest;
let serveur: ServeurDeTest;

beforeAll(async () => {
  [bureau, serveur] = await Promise.all([
    lancerServeur({
      env: ENV_LLM,
      // Une interface construite, pour les requêtes qui retombent sur les fichiers statiques.
      preparer: (dir) => writeFileSync(join(dir, "index.html"), "<!doctype html><title>G</title>"),
    }),
    lancerServeur({
      env: { ...ENV_LLM, GRAMMARIA_DESKTOP: "0", CORS_ORIGIN: "https://app.example" },
    }),
  ]);
}, 30_000);

afterAll(async () => {
  bureau?.arreter();
  serveur?.arreter();
  await amont.stop(true);
});

const appel = (path: string, init?: RequestInit, cible = bureau) => fetch(cible.base + path, init);

const json = (method: string, body: unknown, headers: Record<string, string> = {}) => ({
  method,
  headers: { "Content-Type": "application/json", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

async function attendJson(response: Response, status: number, corps?: unknown) {
  expect(response.status).toBe(status);
  expect(response.headers.get("Content-Type")).toBe("application/json");
  const body = await response.json();
  if (corps !== undefined) expect(body).toEqual(corps);
  return body;
}

const METHODE_REFUSEE = { error: "Method not allowed" };
const JSON_INVALIDE = { error: "Invalid JSON" };
const CONTENU_INVALIDE = { error: "Invalid payload" };

describe("En-têtes CORS", () => {
  it("renvoie l'origine locale, et aucune origine étrangère", async () => {
    const local = await appel("/api/journal", { headers: { Origin: LOCAL } });
    expect(local.headers.get("Access-Control-Allow-Origin")).toBe(LOCAL);
    const etranger = await appel("/api/journal", { headers: { Origin: ETRANGER } });
    expect(etranger.status).toBe(200);
    expect(etranger.headers.has("Access-Control-Allow-Origin")).toBe(false);
    const sansOrigine = await appel("/api/journal");
    expect(sansOrigine.headers.has("Access-Control-Allow-Origin")).toBe(false);
  });

  it("accepte les origines de CORS_ORIGIN", async () => {
    const autorisee = await appel(
      "/api/journal",
      { headers: { Origin: "https://app.example" } },
      serveur,
    );
    expect(autorisee.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example");
    const autre = await appel("/api/journal", { headers: { Origin: ETRANGER } }, serveur);
    expect(autre.headers.has("Access-Control-Allow-Origin")).toBe(false);
  });

  it.each([
    ["/api/valid-words", "GET, POST, OPTIONS"],
    ["/api/analyze", "GET, POST, DELETE, OPTIONS"],
    ["/api/journal", "GET, POST, DELETE, OPTIONS"],
    ["/api/progress", "GET, POST, DELETE, OPTIONS"],
    ["/api/badges", "GET, POST, DELETE, OPTIONS"],
    ["/api/rules", "GET, POST, DELETE, OPTIONS"],
    ["/api/rules/events", "GET, POST, DELETE, OPTIONS"],
    ["/api/rules/answer", "GET, POST, DELETE, OPTIONS"],
    ["/api/check", "POST, OPTIONS"],
  ])("OPTIONS %s : pré-vérification CORS sans corps", async (path, methods) => {
    const response = await appel(path, { method: "OPTIONS", headers: { Origin: LOCAL } }, serveur);
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe(methods);
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe("Content-Type");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(LOCAL);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(await response.text()).toBe("");
  });

  it("en mode bureau, une pré-vérification d'une autre origine est refusée (403)", async () => {
    const response = await appel("/api/check", { method: "OPTIONS", headers: { Origin: LOCAL } });
    expect(response.status).toBe(403);
    const memeOrigine = await appel("/api/check", {
      method: "OPTIONS",
      headers: { Origin: bureau.base },
    });
    expect(memeOrigine.status).toBe(200);
    expect(memeOrigine.headers.get("Access-Control-Allow-Origin")).toBe(bureau.base);
  });
});

describe("Contrôles du mode bureau", () => {
  it.each([
    "/api/settings",
    "/api/valid-words",
    "/api/analyze",
    "/api/journal",
    "/api/rules",
    "/api/rules/events",
    "/api/check",
    "/v1/models",
    "/",
  ])("refuse un en-tête Host étranger sur %s", async (path) => {
    const response = await appel(path, { headers: { Host: "evil.example" } });
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Forbidden");
  });

  it("refuse une modification venue d'une autre origine, accepte la même origine", async () => {
    for (const [path, method] of [
      ["/api/settings", "PUT"],
      ["/api/valid-words", "POST"],
      ["/api/analyze", "POST"],
      ["/api/journal", "DELETE"],
      ["/api/rules/answer", "POST"],
      ["/api/check", "POST"],
      ["/v1/chat/completions", "POST"],
    ] as const) {
      const response = await appel(path, json(method, "{", { Origin: ETRANGER }));
      expect(response.status).toBe(403);
      expect(await response.text()).toBe("Forbidden");
    }
    const memeOrigine = await appel("/api/check", json("POST", "{", { Origin: bureau.base }));
    await attendJson(memeOrigine, 400, JSON_INVALIDE);
  });

  it("hors mode bureau, ni l'hôte ni l'origine ne sont filtrés", async () => {
    const hote = await appel("/api/journal", { headers: { Host: "evil.example" } }, serveur);
    expect(hote.status).toBe(200);
    const origine = await appel("/api/check", json("POST", "{", { Origin: ETRANGER }), serveur);
    await attendJson(origine, 400, JSON_INVALIDE);
  });
});

describe("/api/settings", () => {
  it("GET renvoie la vue publique, sans jamais la clé API", async () => {
    const response = await appel("/api/settings", { headers: { Origin: LOCAL } });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(LOCAL);
    expect(await response.clone().text()).not.toContain(CLE_API);
    await attendJson(response, 200, {
      editable: true,
      configured: false,
      llmTarget: CIBLE,
      llmModelName: "",
      llmDisableThinking: true,
      hasApiKey: true,
    });
  });

  it("PUT refuse un corps invalide (400) et garde les réglages", async () => {
    const malforme = await attendJson(await appel("/api/settings", json("PUT", "{")), 400);
    expect(typeof malforme.error).toBe("string");
    await attendJson(await appel("/api/settings", json("PUT", { llmTarget: "ftp://x" })), 400, {
      error: "L'adresse du modèle doit commencer par http:// ou https://.",
    });
    await attendJson(await appel("/api/settings", json("PUT", null)), 400, {
      error: "Réglages invalides.",
    });
    const apres = await attendJson(await appel("/api/settings"), 200);
    expect(apres.llmTarget).toBe(CIBLE);
  });

  it("PUT enregistre, normalise l'adresse et ne renvoie pas la clé", async () => {
    const response = await appel(
      "/api/settings",
      json("PUT", { llmTarget: `${CIBLE}/v1/`, llmModelName: "modele-choisi" }),
    );
    expect(await response.clone().text()).not.toContain(CLE_API);
    await attendJson(response, 200, {
      editable: true,
      configured: true,
      llmTarget: CIBLE,
      llmModelName: "modele-choisi",
      llmDisableThinking: true,
      hasApiKey: true,
    });
    // Revient au modèle détecté pour la suite.
    await attendJson(await appel("/api/settings", json("PUT", { llmModelName: "" })), 200);
  });

  it("refuse les autres méthodes, OPTIONS compris (405)", async () => {
    for (const method of ["DELETE", "POST", "OPTIONS"]) {
      await attendJson(await appel("/api/settings", { method }), 405, METHODE_REFUSEE);
    }
  });

  it("hors mode bureau, les réglages sont en lecture seule (403)", async () => {
    const vue = await attendJson(await appel("/api/settings", undefined, serveur), 200);
    expect(vue).toMatchObject({ editable: false, hasApiKey: true });
    expect(JSON.stringify(vue)).not.toContain(CLE_API);
    await attendJson(
      await appel("/api/settings", json("PUT", { llmTarget: ETRANGER }), serveur),
      403,
      { error: "Settings are read-only" },
    );
  });
});

describe("/api/valid-words", () => {
  it("GET renvoie une liste vide sans fichier", async () => {
    await attendJson(await appel("/api/valid-words"), 200, { words: [] });
  });

  it("POST ajoute un mot une seule fois", async () => {
    await attendJson(await appel("/api/valid-words", json("POST", { word: " Grammaria " })), 200, {
      words: ["Grammaria"],
    });
    await attendJson(await appel("/api/valid-words", json("POST", { word: "Grammaria" })), 200, {
      words: ["Grammaria"],
    });
    await attendJson(await appel("/api/valid-words"), 200, { words: ["Grammaria"] });
  });

  it("POST refuse un mot invalide ou un corps invalide (400)", async () => {
    for (const word of ["", "1234", "a".repeat(101), 42]) {
      await attendJson(await appel("/api/valid-words", json("POST", { word })), 400, {
        error: "Invalid word",
      });
    }
    await attendJson(await appel("/api/valid-words", json("POST", "{")), 400, JSON_INVALIDE);
    await attendJson(await appel("/api/valid-words", json("POST", "null")), 400, JSON_INVALIDE);
  });

  it("une autre méthode n'a pas de 405 : elle retombe sur les fichiers statiques", async () => {
    const response = await appel("/api/valid-words", { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<title>G</title>");
  });
});

describe("/api/analyze et journal", () => {
  it("POST /api/analyze refuse un corps invalide (400)", async () => {
    await attendJson(await appel("/api/analyze", json("POST", "{")), 400, JSON_INVALIDE);
    for (const body of [
      null,
      { original: "a", corrected: "a" },
      { original: 1, corrected: "a", matches: [] },
      { original: "a".repeat(20_001), corrected: "a", matches: [] },
    ]) {
      await attendJson(await appel("/api/analyze", json("POST", body)), 400, CONTENU_INVALIDE);
    }
  });

  it("POST /api/analyze analyse, enregistre et annonce les badges", async () => {
    const body = await attendJson(
      await appel(
        "/api/analyze",
        json("POST", {
          original: "Ils on vu le film.",
          corrected: "Ils ont vu le film.",
          matches: [{ offset: "x" }, null],
        }),
      ),
      200,
    );
    expect(body.score).toBe(0);
    expect(body.week).toBeDefined();
    expect(body.nouveauxBadges.map((b: { id: string }) => b.id)).toEqual(["premier-texte"]);
  });

  it("GET /api/rules : règles, effectifs par état et seuils", async () => {
    const body = await attendJson(await appel("/api/rules"), 200);
    expect(Array.isArray(body.rules)).toBe(true);
    expect(Object.keys(body.counts)).toEqual([...ETATS_CYCLE]);
    expect(Object.values(body.counts).reduce((a, b) => Number(a) + Number(b), 0)).toBe(
      body.rules.length,
    );
    expect(body.thresholds).toEqual(SEUILS);
  });

  it("GET /api/rules/events : historique, filtré par règle et limité", async () => {
    const tous = await attendJson(await appel("/api/rules/events"), 200);
    expect(Array.isArray(tous.events)).toBe(true);
    expect(tous.events.length).toBeGreaterThan(0);
    const ruleKey = tous.events[0].ruleKey as string;
    const filtres = await attendJson(
      await appel(`/api/rules/events?ruleKey=${encodeURIComponent(ruleKey)}`),
      200,
    );
    expect(filtres.events.every((e: { ruleKey: string }) => e.ruleKey === ruleKey)).toBe(true);
    await attendJson(await appel("/api/rules/events?ruleKey=inconnue"), 200, { events: [] });
    const un = await attendJson(await appel("/api/rules/events?limit=1"), 200);
    expect(un.events).toHaveLength(1);
    const limiteInvalide = await attendJson(await appel("/api/rules/events?limit=abc"), 200);
    expect(limiteInvalide.events).toEqual(tous.events);
  });

  it("POST /api/rules/answer : 400, 404", async () => {
    await attendJson(await appel("/api/rules/answer", json("POST", "{")), 400, JSON_INVALIDE);
    for (const body of [null, { choiceId: 1.5, correct: true }, { choiceId: 1, correct: "oui" }]) {
      await attendJson(await appel("/api/rules/answer", json("POST", body)), 400, CONTENU_INVALIDE);
    }
    await attendJson(
      await appel("/api/rules/answer", json("POST", { choiceId: 999_999, correct: true })),
      404,
      { error: "Unknown choice" },
    );
  });

  it("GET /api/journal, /api/progress et /api/badges répondent en JSON", async () => {
    const bilan = await attendJson(await appel("/api/journal?days=7"), 200);
    expect(typeof bilan).toBe("object");
    const progression = await attendJson(await appel("/api/progress"), 200);
    expect(progression.empty).toBe(false);
    const badges = await attendJson(await appel("/api/badges"), 200);
    expect(badges.obtenus).toBe(1);
  });

  it.each([
    ["GET", "/api/analyze"],
    ["POST", "/api/journal"],
    ["POST", "/api/progress"],
    ["DELETE", "/api/badges"],
    ["POST", "/api/rules"],
    ["DELETE", "/api/rules/events"],
    ["GET", "/api/rules/answer"],
  ])("%s %s est refusé (405)", async (method, path) => {
    await attendJson(await appel(path, { method }), 405, METHODE_REFUSEE);
  });

  it("DELETE /api/journal efface le journal", async () => {
    await attendJson(await appel("/api/journal", { method: "DELETE" }), 200, { purged: true });
    await attendJson(await appel("/api/rules/events"), 200, { events: [] });
  });
});

describe("/api/check", () => {
  it("refuse les autres méthodes (405)", async () => {
    for (const method of ["GET", "PUT", "DELETE"]) {
      await attendJson(await appel("/api/check", { method }), 405, METHODE_REFUSEE);
    }
  });

  it("refuse un corps invalide (400)", async () => {
    await attendJson(await appel("/api/check", json("POST", "{")), 400, JSON_INVALIDE);
    await attendJson(await appel("/api/check", json("POST", "null")), 400, JSON_INVALIDE);
    for (const text of [undefined, 42, "   ", "a".repeat(20_001)]) {
      await attendJson(await appel("/api/check", json("POST", { text })), 400, CONTENU_INVALIDE);
    }
  });

  // Le premier appel attend le chargement des règles du correcteur.
  it("POST analyse le texte avec le correcteur intégré", async () => {
    const body = await attendJson(
      await appel("/api/check", json("POST", { text: "Il a manger une pomme." })),
      200,
    );
    expect(Array.isArray(body.matches)).toBe(true);
    expect(body.matches.length).toBeGreaterThan(0);
    expect(typeof body.matches[0].rule.id).toBe("string");
  }, 60_000);
});

describe("/v1/* (serveur du modèle)", () => {
  it("POST /v1/chat/completions relaie le flux en SSE", async () => {
    const response = await appel(
      "/v1/chat/completions",
      json(
        "POST",
        {
          model: "auto",
          correction_mode: "fluide",
          messages: [{ role: "user", content: "bonjour a tous" }],
        },
        { Origin: bureau.base },
      ),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
    expect(response.headers.get("X-Accel-Buffering")).toBe("no");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(bureau.base);

    const events = (await response.text())
      .split("\n\n")
      .filter((bloc) => bloc.startsWith("data: "))
      .map((bloc) => JSON.parse(bloc.slice("data: ".length)));
    expect(events.slice(0, 2)).toEqual([{ delta: "Bonjour" }, { delta: " à tous." }]);
    expect(events[2]).toMatchObject({ done: true, text: "Bonjour à tous.", reasoningChunks: 0 });
    expect(events).toHaveLength(3);

    expect(requeteAmont?.authorization).toBe(`Bearer ${CLE_API}`);
    expect(requeteAmont?.body).toMatchObject({
      model: "modele-test",
      stream: true,
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(requeteAmont?.body).not.toHaveProperty("correction_mode");
    expect(requeteAmont?.body).not.toHaveProperty("top_k");
  });

  it("POST /v1/chat/completions avec un corps invalide : 502", async () => {
    const response = await appel(
      "/v1/chat/completions",
      json("POST", "{", { Origin: bureau.base }),
    );
    const body = await attendJson(response, 502);
    expect(body.error).toBe("LLM unavailable");
    expect(typeof body.details).toBe("string");
    expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
  });

  it("relaie les autres routes avec l'origine autorisée ou une origine vide", async () => {
    const local = await appel("/v1/models", { headers: { Origin: LOCAL } });
    expect(local.status).toBe(200);
    expect(local.headers.get("Access-Control-Allow-Origin")).toBe(LOCAL);
    expect(local.headers.get("X-Amont")).toBe("oui");
    expect(await local.json()).toEqual({ data: [{ id: "modele-test" }] });

    const etranger = await appel("/v1/models", { headers: { Origin: ETRANGER } });
    expect(etranger.headers.get("Access-Control-Allow-Origin")).toBe("");

    const inconnue = await appel("/v1/inconnue");
    expect(inconnue.status).toBe(418);
    expect(await inconnue.text()).toBe("inconnu");
  });

  it("répond 502 quand le serveur du modèle est injoignable", async () => {
    await attendJson(
      await appel("/api/settings", json("PUT", { llmTarget: "http://127.0.0.1:9" })),
      200,
    );
    await attendJson(await appel("/v1/models"), 502, { error: "LLM unavailable" });
  });
});
