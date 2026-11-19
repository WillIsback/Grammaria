// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type {
  DependancesApi,
  ErreurModele,
  FragmentModele,
  JournalDeps,
  ModeleDeps,
} from "../../api/deps";
import { creerGestionnaire } from "../../api/handler";
import type { ServerSettings, SettingsUpdate } from "../../api/reglages";

/**
 * Le gestionnaire d'API avec des dépendances factices : un journal
 * ASYNCHRONE (comme sur le bureau, où il passe par les commandes Rust), un
 * correcteur, des réglages, des mots valides et un modèle factices. Aucun
 * serveur : on appelle directement `Request → Response`.
 */

const BASE = "http://grammaria.test";
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
/** Résout après un tour de boucle : vérifie que le gestionnaire attend chaque appel. */
const plusTard = async <T>(value: T): Promise<T> => {
  await tick();
  return value;
};

function journalAsynchrone() {
  const appels: string[] = [];
  let choix: "recorded" | "unknown" | "conflict" = "recorded";
  const journal: JournalDeps = {
    async record(_analysis, now, options) {
      appels.push(`record:${now}:${options.original}`);
      return plusTard({ intervention: null, reussites: [] });
    },
    period: (days) => plusTard({ days, average: 15 }),
    summary: (days) => plusTard({ days, rules: [] }),
    progress: () => plusTard({ empty: true }),
    rules: () => plusTard([{ state: "observee" as const }, { state: "acquise" as const }]),
    ruleEvents: (options) => plusTard([{ id: 1, ...options }]),
    answerChoice: (choiceId, correct) => {
      appels.push(`answer:${choiceId}:${correct}`);
      return plusTard(choix);
    },
    async purge() {
      await tick();
      appels.push("purge");
    },
    badges: {
      award: () => plusTard([{ id: "premier-texte", titre: "Premier texte" } as never]),
      catalogue: () => plusTard({ obtenus: 0, badges: [] }),
    },
  };
  return { journal, appels, setChoix: (c: typeof choix) => (choix = c) };
}

/** Modèle factice : enregistre chaque corps reçu ; `refus` simule une API qui refuse un paramètre. */
function modeleFactice(options: { refus?: ErreurModele; fragments?: FragmentModele[] } = {}) {
  const corps: Record<string, unknown>[] = [];
  const listerModeles = vi.fn(async () => ({
    data: [
      { id: "embed", type: "embedding" },
      { id: "modele-detecte", type: "text-generation" },
    ],
  }));
  const modele: ModeleDeps = {
    listerModeles,
    async ouvrirFlux(body) {
      corps.push(body);
      await tick();
      if (options.refus && "chat_template_kwargs" in body) {
        throw Object.assign(new Error(options.refus.message), options.refus);
      }
      const fragments = options.fragments ?? [
        { reasoning: "je réfléchis" },
        { content: "Bonjour" },
        { content: " à tous." },
      ];
      return (async function* () {
        for (const fragment of fragments) {
          await tick();
          yield fragment;
        }
      })();
    },
  };
  return { modele, corps, listerModeles };
}

function creer(overrides: Partial<DependancesApi> = {}, settings: Partial<ServerSettings> = {}) {
  const { journal, appels, setChoix } = journalAsynchrone();
  const { modele, corps } = modeleFactice();
  let vue: ServerSettings = {
    editable: true,
    configured: true,
    llmTarget: "http://modele.test",
    llmModelName: "",
    llmDisableThinking: true,
    hasApiKey: false,
    ...settings,
  };
  const mises: SettingsUpdate[] = [];
  let mots: string[] = [];
  let horloge = 1_000;
  const deps: DependancesApi = {
    journal,
    correcteur: {
      check: async (text) => [
        { offset: 0, length: text.length, message: "m", rule: { id: "R" } } as never,
      ],
    },
    reglages: {
      vuePublique: () => plusTard(vue),
      async mettreAJour(update) {
        mises.push(update);
        vue = { ...vue, ...update };
        return vue;
      },
    },
    motsValides: {
      lire: () => plusTard(mots),
      async ajouter(word) {
        if (!mots.includes(word)) mots = [...mots, word];
        return mots;
      },
    },
    modele,
    options: {
      bureau: true,
      originesCors: ["https://app.example"],
      llmTopK: -1,
      horloge: () => (horloge += 10),
    },
    ...overrides,
  };
  return { traiter: creerGestionnaire(deps), appels, setChoix, corps, mises, modele };
}

const requete = (path: string, init: RequestInit = {}) => new Request(BASE + path, init);
const post = (path: string, body: unknown, method = "POST") =>
  requete(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

/** Événements `data:` d'une réponse SSE. */
async function evenements(response: Response): Promise<Record<string, unknown>[]> {
  return (await response.text())
    .split("\n\n")
    .filter((bloc) => bloc.startsWith("data: "))
    .map((bloc) => JSON.parse(bloc.slice("data: ".length)));
}

describe("creerGestionnaire — routes hors API", () => {
  it("renvoie null pour les fichiers statiques et les méthodes sans route", async () => {
    const { traiter } = creer();
    expect(await traiter(requete("/"))).toBeNull();
    expect(await traiter(requete("/assets/app.js"))).toBeNull();
    expect(await traiter(requete("/api/valid-words", { method: "DELETE" }))).toBeNull();
  });
});

describe("creerGestionnaire — CORS", () => {
  it("autorise les origines locales et celles des options, pas les autres", async () => {
    const { traiter } = creer();
    const origine = async (o: string) =>
      (await traiter(requete("/api/journal", { headers: { Origin: o } })))?.headers.get(
        "Access-Control-Allow-Origin",
      ) ?? null;
    expect(await origine("http://localhost:5173")).toBe("http://localhost:5173");
    expect(await origine("https://app.example")).toBe("https://app.example");
    expect(await origine("https://localhost.evil.example")).toBeNull();
  });

  it("répond aux pré-vérifications OPTIONS sans corps", async () => {
    const { traiter } = creer();
    const response = (await traiter(requete("/api/check", { method: "OPTIONS" }))) as Response;
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe("POST, OPTIONS");
    expect(await response.text()).toBe("");
  });
});

describe("creerGestionnaire — journal asynchrone", () => {
  it("POST /api/analyze attend le journal, les badges et la période", async () => {
    const { traiter, appels } = creer();
    const response = (await traiter(
      post("/api/analyze", {
        original: "Ils on vu le film.",
        corrected: "Ils ont vu le film.",
        matches: [],
      }),
    )) as Response;
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.week).toEqual({ days: 7, average: 15 });
    expect(body.intervention).toBeNull();
    expect(body.nouveauxBadges).toEqual([{ id: "premier-texte", titre: "Premier texte" }]);
    expect(appels).toEqual(["record:1010:Ils on vu le film."]);
  });

  it("une erreur des badges n'empêche pas l'analyse (même asynchrone)", async () => {
    const { journal } = journalAsynchrone();
    journal.badges.award = () => Promise.reject(new Error("panne"));
    const erreur = vi.spyOn(console, "error").mockImplementation(() => {});
    const { traiter } = creer({ journal });
    const response = (await traiter(
      post("/api/analyze", { original: "a", corrected: "a", matches: [] }),
    )) as Response;
    expect(response.status).toBe(200);
    expect((await response.json()).nouveauxBadges).toEqual([]);
    erreur.mockRestore();
  });

  it("GET /api/rules compte les états des règles lues", async () => {
    const { traiter } = creer();
    const body = await ((await traiter(requete("/api/rules"))) as Response).json();
    expect(body.counts).toMatchObject({ observee: 1, acquise: 1, signalee: 0 });
    expect(body.thresholds).toBeDefined();
  });

  it("POST /api/rules/answer : 404, 409 puis réponse enregistrée", async () => {
    const { traiter, setChoix, appels } = creer();
    setChoix("unknown");
    expect((await traiter(post("/api/rules/answer", { choiceId: 3, correct: true })))?.status).toBe(
      404,
    );
    setChoix("conflict");
    expect((await traiter(post("/api/rules/answer", { choiceId: 3, correct: true })))?.status).toBe(
      409,
    );
    setChoix("recorded");
    const ok = (await traiter(post("/api/rules/answer", { choiceId: 3, correct: false })))!;
    expect(await ok.json()).toMatchObject({ recorded: true });
    expect(appels).toContain("answer:3:false");
  });

  it("DELETE /api/journal attend l'effacement", async () => {
    const { traiter, appels } = creer();
    const response = (await traiter(requete("/api/journal", { method: "DELETE" }))) as Response;
    expect(await response.json()).toEqual({ purged: true });
    expect(appels).toEqual(["purge"]);
  });

  it("GET /api/journal lit la période, /api/progress et /api/badges répondent", async () => {
    const { traiter } = creer();
    expect(await (await traiter(requete("/api/journal?days=0")))!.json()).toEqual({
      days: 1,
      rules: [],
    });
    expect(await (await traiter(requete("/api/progress")))!.json()).toEqual({ empty: true });
    expect(await (await traiter(requete("/api/badges")))!.json()).toMatchObject({ obtenus: 0 });
    expect((await traiter(requete("/api/progress", { method: "POST" })))!.status).toBe(405);
  });
});

describe("creerGestionnaire — correcteur, mots valides et réglages", () => {
  it("POST /api/check valide le texte puis appelle le correcteur", async () => {
    const { traiter } = creer();
    expect((await traiter(post("/api/check", { text: "  " })))!.status).toBe(400);
    expect((await traiter(post("/api/check", "{")))!.status).toBe(400);
    const body = await (await traiter(post("/api/check", { text: "Il a manger." })))!.json();
    expect(body.matches).toHaveLength(1);
  });

  it("POST /api/check : 503 si le correcteur échoue", async () => {
    const erreur = vi.spyOn(console, "error").mockImplementation(() => {});
    const { traiter } = creer({
      correcteur: { check: () => Promise.reject(new Error("pas prêt")) },
    });
    expect((await traiter(post("/api/check", { text: "Bonjour." })))!.status).toBe(503);
    erreur.mockRestore();
  });

  it("/api/valid-words : ajout validé, une seule fois ; 500 si l'enregistrement échoue", async () => {
    const { traiter } = creer();
    expect((await traiter(post("/api/valid-words", { word: "1234" })))!.status).toBe(400);
    await traiter(post("/api/valid-words", { word: " Grammaria " }));
    const body = await (await traiter(post("/api/valid-words", { word: "Grammaria" })))!.json();
    expect(body).toEqual({ words: ["Grammaria"] });

    const enPanne = creer({
      motsValides: { lire: () => [], ajouter: () => Promise.reject(new Error("disque plein")) },
    });
    const echec = (await enPanne.traiter(post("/api/valid-words", { word: "mot" })))!;
    expect(echec.status).toBe(500);
    expect(await echec.json()).toEqual({ error: "Failed to save word" });
  });

  it("PUT /api/settings valide avant d'appliquer, et refuse en lecture seule", async () => {
    const { traiter, mises } = creer();
    const invalide = (await traiter(post("/api/settings", { llmTarget: "ftp://x" }, "PUT")))!;
    expect(invalide.status).toBe(400);
    expect(await invalide.json()).toEqual({
      error: "L'adresse du modèle doit commencer par http:// ou https://.",
    });
    expect(mises).toEqual([]);

    const ok = (await traiter(
      post("/api/settings", { llmTarget: "https://api.example.com/v1/" }, "PUT"),
    ))!;
    expect((await ok.json()).llmTarget).toBe("https://api.example.com");
    expect(mises).toEqual([{ llmTarget: "https://api.example.com" }]);

    const lectureSeule = creer({}, { editable: false });
    const refus = (await lectureSeule.traiter(
      post("/api/settings", { llmTarget: "http://x" }, "PUT"),
    ))!;
    expect(refus.status).toBe(403);
    expect(lectureSeule.mises).toEqual([]);
  });
});

describe("creerGestionnaire — conversation (/v1/chat/completions)", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    return () => vi.restoreAllMocks();
  });

  const conversation = {
    model: "auto",
    correction_mode: "fluide",
    messages: [{ role: "user", content: "bonjour a tous" }],
  };

  it("choisit le modèle détecté, coupe le raisonnement et relaie le flux en SSE", async () => {
    const { traiter, corps } = creer();
    const response = (await traiter(
      post("/v1/chat/completions", conversation, "POST"),
    )) as Response;
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
    expect(response.headers.get("X-Accel-Buffering")).toBe("no");

    const events = await evenements(response);
    expect(events.slice(0, 2)).toEqual([{ delta: "Bonjour" }, { delta: " à tous." }]);
    expect(events[2]).toMatchObject({ done: true, text: "Bonjour à tous.", reasoningChunks: 1 });
    expect(typeof events[2].duration).toBe("number");
    expect(typeof events[2].firstTokenMs).toBe("number");
    expect(events).toHaveLength(3);

    expect(corps).toHaveLength(1);
    expect(corps[0]).toMatchObject({
      model: "modele-detecte",
      stream: true,
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(corps[0]).not.toHaveProperty("correction_mode");
    expect(corps[0]).not.toHaveProperty("top_k");
  });

  it("relance sans chat_template_kwargs quand l'API refuse le paramètre, puis ne l'envoie plus", async () => {
    const { modele, corps } = modeleFactice({
      refus: { status: 400, message: "Unrecognized request argument: chat_template_kwargs" },
    });
    const { traiter } = creer({ modele });

    const events = await evenements((await traiter(post("/v1/chat/completions", conversation)))!);
    expect(events.at(-1)).toMatchObject({ done: true, text: "Bonjour à tous." });
    expect(corps).toHaveLength(2);
    expect(corps[0]).toHaveProperty("chat_template_kwargs");
    expect(corps[1]).not.toHaveProperty("chat_template_kwargs");
    expect(corps[1]).toMatchObject({ model: "modele-detecte", stream: true });

    // Le refus est retenu jusqu'au prochain changement de réglages.
    await (await traiter(post("/v1/chat/completions", conversation)))!.text();
    expect(corps).toHaveLength(3);
    expect(corps[2]).not.toHaveProperty("chat_template_kwargs");

    await traiter(post("/api/settings", { llmModelName: "" }, "PUT"));
    await (await traiter(post("/v1/chat/completions", conversation)))!.text();
    expect(corps[3]).toHaveProperty("chat_template_kwargs");
  });

  it("une autre erreur du modèle n'est pas relancée : 502 sans CORS", async () => {
    const { modele, corps } = modeleFactice({
      refus: { status: 500, message: "chat_template_kwargs : panne" },
    });
    const erreur = vi.spyOn(console, "error").mockImplementation(() => {});
    const { traiter } = creer({ modele });
    const response = (await traiter(
      requete("/v1/chat/completions", {
        method: "POST",
        headers: { Origin: "http://localhost:5173" },
        body: JSON.stringify(conversation),
      }),
    ))!;
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: "LLM unavailable" });
    expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
    expect(corps).toHaveLength(1);
    erreur.mockRestore();
  });

  it("modèle des réglages, top_k des options, et compte de raisonnement d'un relais", async () => {
    const { modele, corps, listerModeles } = modeleFactice({
      fragments: [{ content: "Salut" }, { reasoningChunks: 4 }],
    });
    const { traiter } = creer(
      {
        modele,
        options: { bureau: true, originesCors: [], llmTopK: 20 },
      },
      { llmModelName: "modele-regle", llmDisableThinking: false },
    );
    const events = await evenements((await traiter(post("/v1/chat/completions", conversation)))!);
    expect(events.at(-1)).toMatchObject({ done: true, text: "Salut", reasoningChunks: 4 });
    expect(corps[0]).toMatchObject({ model: "modele-regle", top_k: 20 });
    expect(corps[0]).not.toHaveProperty("chat_template_kwargs");
    expect(listerModeles).not.toHaveBeenCalled();
  });

  it("une erreur en cours de flux devient un événement error", async () => {
    const { modele } = modeleFactice();
    modele.ouvrirFlux = async () =>
      (async function* () {
        yield { content: "Bon" };
        throw new Error("coupure");
      })();
    const { traiter } = creer({ modele });
    const events = await evenements((await traiter(post("/v1/chat/completions", conversation)))!);
    expect(events).toEqual([{ delta: "Bon" }, { error: "Error: coupure" }]);
  });

  it("annule la requête au modèle quand l'interface abandonne le flux", async () => {
    let signalRecu: AbortSignal | null = null;
    const { modele } = modeleFactice();
    modele.ouvrirFlux = async (_corps, signal) => {
      signalRecu = signal;
      return (async function* () {
        yield { content: "Bon" };
        await new Promise((resolve) => setTimeout(resolve, 50));
        yield { content: "jour" };
      })();
    };
    const { traiter } = creer({ modele });
    const response = (await traiter(post("/v1/chat/completions", conversation)))!;
    const lecteur = response.body!.getReader();
    await lecteur.read();
    await lecteur.cancel();
    expect(signalRecu!.aborted).toBe(true);
  });
});

describe("creerGestionnaire — autres routes /v1/*", () => {
  it("sans relais (bureau) : /v1/models par listerModeles, 404 sinon, CORS ajouté", async () => {
    const { traiter } = creer();
    const models = (await traiter(
      requete("/v1/models", { headers: { Origin: "http://localhost:5173" } }),
    ))!;
    expect(models.status).toBe(200);
    expect(models.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
    expect((await models.json()).data).toHaveLength(2);
    const inconnue = (await traiter(requete("/v1/inconnue")))!;
    expect(inconnue.status).toBe(404);
    expect(inconnue.headers.get("Access-Control-Allow-Origin")).toBe("");
  });

  it("avec relais (serveur) : réponse relayée telle quelle ; 502 si le relais échoue", async () => {
    const { modele } = modeleFactice();
    modele.relayer = async (req) =>
      new Response(`relayé ${new URL(req.url).pathname}`, {
        status: 418,
        headers: { "X-Amont": "oui", "Content-Encoding": "gzip" },
      });
    const { traiter } = creer({ modele });
    const response = (await traiter(requete("/v1/inconnue")))!;
    expect(response.status).toBe(418);
    expect(response.headers.get("X-Amont")).toBe("oui");
    expect(response.headers.has("Content-Encoding")).toBe(false);
    expect(await response.text()).toBe("relayé /v1/inconnue");

    modele.relayer = () => Promise.reject(new Error("injoignable"));
    const echec = (await traiter(requete("/v1/models")))!;
    expect(echec.status).toBe(502);
    expect(await echec.json()).toEqual({ error: "LLM unavailable" });
  });
});
