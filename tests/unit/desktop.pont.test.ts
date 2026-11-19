// @vitest-environment node
/**
 * Le pont de l'application de bureau, de bout en bout dans Node : `fetch` intercepté → gestionnaire
 * d'API partagé avec le serveur → dépendances du bureau → commandes Rust simulées
 * (helpers/tauriSimule.ts : SQLite réel en mémoire, réglages, mots valides, relais du modèle par
 * Channel). Chaque route doit répondre comme le serveur (mêmes cas que api.handler.test.ts), et
 * `src/utils/llm.ts`, inchangé, doit lire le flux de conversation, interruption comprise.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { creerGestionnaire } from "../../api/handler";
import { Journal } from "../../journal";
import { dependancesBureau } from "../../src/desktop/dependances";
import { creerPiloteTauri } from "../../src/desktop/journal.driver.tauri";
import { estRouteApi, installerPont } from "../../src/desktop/pont";
import { correctText } from "../../src/utils/llm";
import { tauriSimule, type OptionsSimulation } from "./helpers/tauriSimule";

const PAGE = "tauri://localhost/";
const attendre = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function bureau(
  options: OptionsSimulation & { check?: (text: string) => Promise<unknown[]> } = {},
) {
  const tauri = tauriSimule(options);
  const journal = await Journal.ouvrir(creerPiloteTauri(tauri.api.invoke));
  const deps = dependancesBureau({
    api: tauri.api,
    journal,
    correcteur: {
      check: (options.check ??
        (async (text: string) => [
          { offset: 0, length: text.length, message: "m", rule: { id: "R" } },
        ])) as never,
    },
    modele: { pauseAnnulationMs: 5 },
  });
  const natif = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("natif"),
  );
  const cible = { fetch: natif as unknown as typeof fetch, location: { href: PAGE } };
  const pont = installerPont(creerGestionnaire(deps), cible);
  const envoyer = (path: string, init: RequestInit = {}) => cible.fetch(path, init);
  const json = (path: string, body: unknown, method = "POST") =>
    envoyer(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const compter = (table: string) =>
    (tauri.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return { tauri, cible, natif, pont, envoyer, json, compter };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("pont — ce qui est intercepté", () => {
  it("seules les routes /api/ et /v1/ de la page passent par le gestionnaire", () => {
    const page = new URL(PAGE);
    expect(estRouteApi(new URL("tauri://localhost/api/check"), page)).toBe(true);
    expect(estRouteApi(new URL("tauri://localhost/v1/models"), page)).toBe(true);
    expect(estRouteApi(new URL("tauri://localhost/lt/worker.js"), page)).toBe(false);
    expect(estRouteApi(new URL("tauri://localhost/api"), page)).toBe(false);
    expect(estRouteApi(new URL("http://127.0.0.1:31977/v1/models"), page)).toBe(false);
    expect(estRouteApi(new URL("https://localhost/api/check"), page)).toBe(false);
    const windows = new URL("http://tauri.localhost/");
    expect(estRouteApi(new URL("http://tauri.localhost/api/settings"), windows)).toBe(true);
    expect(estRouteApi(new URL("http://tauri.localhost.exemple.com/api/settings"), windows)).toBe(
      false,
    );
  });

  it("le reste part par le fetch d'origine, requête intacte", async () => {
    const { cible, natif, tauri } = await bureau();
    const requete = new Request("https://exemple.com/api/x", { method: "POST", body: "corps" });
    await cible.fetch(requete);
    await cible.fetch("lt/fr.pack");
    await cible.fetch(new URL("http://127.0.0.1:31977/v1/models"));
    expect(natif).toHaveBeenCalledTimes(3);
    expect(natif.mock.calls[0][0]).toBe(requete);
    expect(await (natif.mock.calls[0][0] as Request).text()).toBe("corps");
    expect(tauri.commandes().filter((c) => !c.startsWith("db_"))).toEqual([]);
  });

  it("une route de l'API n'atteint jamais le fetch d'origine ; null → 404", async () => {
    const { envoyer, natif, pont } = await bureau();
    expect((await envoyer("/api/settings")).status).toBe(200);
    expect((await envoyer("/v1/embeddings", { method: "POST", body: "{}" })).status).toBe(404);
    expect((await envoyer("/api/inconnue")).status).toBe(404);
    expect(natif).not.toHaveBeenCalled();
    expect(pont.journal.map((e) => `${e.route} ${e.statut}`)).toEqual([
      "GET /api/settings 200",
      "POST /v1/embeddings 404",
      "GET /api/inconnue 404",
    ]);
  });

  it("une exception du gestionnaire devient une réponse 500", async () => {
    const erreur = vi.spyOn(console, "error").mockImplementation(() => {});
    const natif = vi.fn();
    const cible = { fetch: natif as unknown as typeof fetch, location: { href: PAGE } };
    installerPont(() => Promise.reject(new Error("panne")), cible);
    const reponse = await cible.fetch("/api/check");
    expect(reponse.status).toBe(500);
    expect(await reponse.json()).toEqual({ error: "Internal error" });
    expect(erreur).toHaveBeenCalled();
  });

  it("desinstaller remet le fetch d'origine", async () => {
    const { cible, natif, pont } = await bureau();
    pont.desinstaller();
    expect(cible.fetch).toBe(natif);
  });
});

describe("pont — réglages et mots valides", () => {
  it("GET/PUT /api/settings : validation du gestionnaire, puis settings_set ; la clé ne sort jamais", async () => {
    const { json, envoyer, tauri } = await bureau();
    const invalide = await json("/api/settings", { llmTarget: "ftp://x" }, "PUT");
    expect(invalide.status).toBe(400);
    expect(await invalide.json()).toEqual({
      error: "L'adresse du modèle doit commencer par http:// ou https://.",
    });
    expect(tauri.commandes()).not.toContain("settings_set");

    const ok = await json(
      "/api/settings",
      { llmTarget: "https://api.example.com/v1/", llmApiKey: "sk-SECRET" },
      "PUT",
    );
    const texte = await ok.text();
    expect(JSON.parse(texte)).toMatchObject({
      llmTarget: "https://api.example.com",
      hasApiKey: true,
    });
    expect(texte).not.toContain("SECRET");
    expect(tauri.appels.find((a) => a.commande === "settings_set")?.args).toEqual({
      update: { llmTarget: "https://api.example.com", llmApiKey: "sk-SECRET" },
    });
    expect(await (await envoyer("/api/settings")).text()).not.toContain("SECRET");
  });

  it("PUT /api/settings refusé par Rust : 400 avec son message", async () => {
    const { json } = await bureau();
    const refus = await json("/api/settings", { llmTarget: "http://refuse.test" }, "PUT");
    expect(refus.status).toBe(400);
    expect(await refus.json()).toEqual({ error: "Adresse refusée par l'application." });
  });

  it("/api/valid-words : validation, ajout unique, « Invalid word » → 400, panne → 500", async () => {
    const { json, envoyer, tauri } = await bureau();
    expect((await json("/api/valid-words", { word: "1234" })).status).toBe(400);
    await json("/api/valid-words", { word: " Grammaria " });
    expect(await (await json("/api/valid-words", { word: "Grammaria" })).json()).toEqual({
      words: ["Grammaria"],
    });
    expect(await (await envoyer("/api/valid-words")).json()).toEqual({ words: ["Grammaria"] });

    tauri.pannes.mots = "Invalid word";
    const invalide = await json("/api/valid-words", { word: "mot" });
    expect(invalide.status).toBe(400);
    expect(await invalide.json()).toEqual({ error: "Invalid word" });
    tauri.pannes.mots = "Failed to save word";
    const echec = await json("/api/valid-words", { word: "mot" });
    expect(echec.status).toBe(500);
    expect(await echec.json()).toEqual({ error: "Failed to save word" });
  });
});

describe("pont — correcteur et journal (SQLite par les commandes simulées)", () => {
  it("POST /api/check : validation, détections, 503 si le correcteur échoue", async () => {
    const { json } = await bureau();
    expect((await json("/api/check", { text: "  " })).status).toBe(400);
    expect((await json("/api/check", "{")).status).toBe(400);
    expect(
      (await (await json("/api/check", { text: "Il a manger." })).json()).matches,
    ).toHaveLength(1);
    const erreur = vi.spyOn(console, "error").mockImplementation(() => {});
    const enPanne = await bureau({ check: () => Promise.reject(new Error("pas prêt")) });
    expect((await enPanne.json("/api/check", { text: "Bonjour." })).status).toBe(503);
    expect(erreur).toHaveBeenCalled();
  });

  it("analyse enregistrée en un lot, lue par /api/journal, /api/progress, /api/badges ; effacement", async () => {
    const { json, envoyer, compter, tauri } = await bureau();
    const reponse = await json("/api/analyze", {
      original: "Ils on vu le film.",
      corrected: "Ils ont vu le film.",
      matches: [],
    });
    expect(reponse.status).toBe(200);
    const corps = await reponse.json();
    expect(corps.week).toMatchObject({ texts: 1 });
    expect(Array.isArray(corps.nouveauxBadges)).toBe(true);
    expect(compter("texts")).toBe(1);
    expect(compter("faults")).toBe(1);
    expect(tauri.commandes()).toContain("db_batch");

    expect((await (await envoyer("/api/journal?days=7")).json()).period).toMatchObject({
      texts: 1,
    });
    expect((await envoyer("/api/progress")).status).toBe(200);
    expect((await (await envoyer("/api/badges")).json()).badges.length).toBeGreaterThan(0);
    expect((await (await envoyer("/api/rules")).json()).rules).toHaveLength(1);
    expect((await envoyer("/api/progress", { method: "POST" })).status).toBe(405);

    expect(await (await envoyer("/api/journal", { method: "DELETE" })).json()).toEqual({
      purged: true,
    });
    expect(compter("texts")).toBe(0);
    expect(compter("rule_states")).toBe(0);
  });

  it("schéma créé par le journal : version 2, pragmas lus par db_read", async () => {
    const { tauri } = await bureau();
    expect(tauri.db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    const lectures = tauri.appels.filter((a) => a.commande === "db_read");
    expect(lectures.some((a) => /PRAGMA user_version/i.test(String(a.args?.sql)))).toBe(true);
  });

  it("POST /api/rules/answer : 404, conflit (« Conflit : » de Rust) → 409, puis enregistré", async () => {
    const { json, tauri } = await bureau();
    const t = Date.now();
    tauri.db
      .prepare(
        `INSERT INTO rule_states (rule_key, state, state_since, occurrences, first_fault_at, last_fault_at)
         VALUES ('REGLE', 'signalee', ?, 3, ?, ?)`,
      )
      .run(t, t, t);
    const choix = Number(
      tauri.db
        .prepare(
          `INSERT INTO rule_events (rule_key, created_at, type) VALUES ('REGLE', ?, 'choix')`,
        )
        .run(t).lastInsertRowid,
    );

    expect((await json("/api/rules/answer", { choiceId: 999, correct: true })).status).toBe(404);

    // Réponse concurrente juste avant le lot : la garde `expectChanges` échoue côté « Rust ».
    let concurrente = true;
    tauri.avantLot = (sqls) => {
      if (concurrente && sqls.some((s) => s.includes("INSERT OR REPLACE INTO rule_states"))) {
        concurrente = false;
        tauri.db
          .prepare(
            `INSERT INTO rule_events (rule_key, created_at, type) VALUES ('REGLE', ?, 'reponse_juste')`,
          )
          .run(t);
      }
    };
    const conflit = await json("/api/rules/answer", { choiceId: choix, correct: true });
    expect(conflit.status).toBe(409);
    expect(await conflit.json()).toEqual({ error: "Choice already answered or replaced" });

    // Nouveau choix, sans concurrence : enregistré.
    const autre = Number(
      tauri.db
        .prepare(
          `INSERT INTO rule_events (rule_key, created_at, type) VALUES ('REGLE', ?, 'choix')`,
        )
        .run(t).lastInsertRowid,
    );
    const ok = await json("/api/rules/answer", { choiceId: autre, correct: false });
    expect(await ok.json()).toMatchObject({ recorded: true });
  });
});

describe("pont — modèle", () => {
  const conversation = {
    model: "auto",
    correction_mode: "fluide",
    messages: [{ role: "user", content: "bonjour a tous" }],
  };

  it("GET /v1/models par llm_models ; 502 si le modèle est injoignable", async () => {
    const { envoyer, tauri } = await bureau();
    expect(await (await envoyer("/v1/models")).json()).toEqual({
      data: [{ id: "normal", type: "text-generation" }],
    });
    tauri.pannes.modeles = "Liste des modèles indisponible";
    const echec = await envoyer("/v1/models");
    expect(echec.status).toBe(502);
    expect(await echec.json()).toEqual({ error: "LLM unavailable" });
  });

  it("flux SSE dans l'ordre, modèle détecté, raisonnement coupé et compté par le relais", async () => {
    const { json, tauri } = await bureau();
    const reponse = await json("/v1/chat/completions", conversation);
    expect(reponse.headers.get("Content-Type")).toBe("text/event-stream");
    const evenements = (await reponse.text())
      .split("\n\n")
      .filter((b) => b.startsWith("data: "))
      .map((b) => JSON.parse(b.slice(6)));
    expect(evenements.slice(0, 3)).toEqual([
      { delta: "Bonjour" },
      { delta: " à " },
      { delta: "tous." },
    ]);
    expect(evenements[3]).toMatchObject({
      done: true,
      text: "Bonjour à tous.",
      reasoningChunks: 2,
    });
    expect(tauri.corpsModele[0]).toMatchObject({
      model: "normal",
      stream: true,
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(tauri.corpsModele[0]).not.toHaveProperty("correction_mode");
    expect(tauri.corpsModele[0]).not.toHaveProperty("top_k");
  });

  it("src/utils/llm.ts lit le flux du pont sans modification", async () => {
    const { cible, tauri } = await bureau();
    tauri.reglages.llmModelName = "normal";
    vi.stubGlobal("fetch", cible.fetch);
    const textes: string[] = [];
    const resultat = await correctText("bonjour a tous", { mode: "fluide" } as never, {
      onText: (t) => textes.push(t),
    });
    expect(resultat.text).toBe("Bonjour à tous.");
    expect(textes.at(-1)).toBe("Bonjour à tous.");
  });

  it("refus de chat_template_kwargs avant le premier fragment : relance sans lui, puis retenu", async () => {
    const { json, tauri } = await bureau();
    tauri.reglages.llmModelName = "rejet";
    const texte = await (await json("/v1/chat/completions", conversation)).text();
    expect(texte).toContain('"done":true');
    expect(tauri.corpsModele).toHaveLength(2);
    expect(tauri.corpsModele[0]).toHaveProperty("chat_template_kwargs");
    expect(tauri.corpsModele[1]).not.toHaveProperty("chat_template_kwargs");
    await (await json("/v1/chat/completions", conversation)).text();
    expect(tauri.corpsModele[2]).not.toHaveProperty("chat_template_kwargs");
  });

  it("erreur en cours de flux : événement d'erreur, que llm.ts lève", async () => {
    const { cible, tauri } = await bureau();
    tauri.reglages.llmModelName = "panne";
    vi.stubGlobal("fetch", cible.fetch);
    await expect(correctText("texte", { mode: "fluide" } as never)).rejects.toThrow(
      "Connexion au modèle coupée.",
    );
  });

  it("interruption par llm.ts (nouvelle correction) : AbortError, requête du modèle annulée", async () => {
    const { cible, tauri } = await bureau();
    tauri.reglages.llmModelName = "lent";
    vi.stubGlobal("fetch", cible.fetch);
    const textes: string[] = [];
    const premiere = correctText("texte", { mode: "fluide" } as never, {
      onText: (t) => textes.push(t),
    });
    const rejet = expect(premiere).rejects.toThrow("Délai d'attente dépassé.");
    await vi.waitFor(() => expect(textes.length).toBeGreaterThan(2));
    tauri.reglages.llmModelName = "normal";
    // correctText annule la requête en cours avant d'en lancer une autre.
    const seconde = await correctText("texte", { mode: "fluide" } as never);
    await rejet;
    expect(seconde.text).toBe("Bonjour à tous.");
    await vi.waitFor(() => expect(tauri.annulees).toHaveLength(1));
    expect(tauri.enCours.size).toBe(0);
  });

  it("abandon avant le premier fragment : fetch rejeté (AbortError), requête annulée", async () => {
    const { cible, tauri } = await bureau();
    tauri.reglages.llmModelName = "muet";
    const controleur = new AbortController();
    const p = cible.fetch("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify(conversation),
      signal: controleur.signal,
    });
    await vi.waitFor(() => expect(tauri.enCours.size).toBe(1));
    controleur.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(tauri.annulees).toHaveLength(1));
    expect(tauri.enCours.size).toBe(0);
  });

  it("signal déjà abandonné : rien n'est envoyé", async () => {
    const { cible, tauri } = await bureau();
    const avant = tauri.appels.length;
    await expect(
      cible.fetch("/api/settings", { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(tauri.appels.length).toBe(avant);
  });

  it("annulation demandée avant que Rust n'ait enregistré la requête : llm_cancel est rappelé", async () => {
    const { cible, tauri } = await bureau({ delaiEnregistrementMs: 40 });
    tauri.reglages.llmModelName = "lent";
    const controleur = new AbortController();
    const p = cible.fetch("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify(conversation),
      signal: controleur.signal,
    });
    await attendre(5);
    controleur.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(tauri.annulees).toHaveLength(1));
    const essais = tauri.commandes().filter((c) => c === "llm_cancel").length;
    expect(essais).toBeGreaterThan(1);
  });

  it("abandon pendant la lecture du corps : la lecture échoue (AbortError) et la requête est annulée", async () => {
    const { cible, tauri } = await bureau();
    tauri.reglages.llmModelName = "lent";
    const controleur = new AbortController();
    const reponse = await cible.fetch("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify(conversation),
      signal: controleur.signal,
    });
    const lecteur = reponse.body!.getReader();
    expect((await lecteur.read()).done).toBe(false);
    controleur.abort();
    await expect(lecteur.read()).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(tauri.annulees).toHaveLength(1));
  });
});
