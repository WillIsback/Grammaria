import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  classerErreurModele,
  ErreurCorrection,
  messageErreurModele,
} from "../../src/utils/erreursModele";
import { correctText } from "../../src/utils/llm";

const reglages = {
  mode: "formel",
  fixGrammar: true,
  fixSpelling: true,
  fixSyntax: true,
  fixStyle: true,
} as const;

// Validation finale : « Le serveur de correction a échoué (HTTP 502) : … tcp
// connect error … » était trop technique. Chaque cas a désormais un message simple.
describe("classerErreurModele", () => {
  it.each([
    // Relais Rust du bureau (reqwest)
    [
      "Liste des modèles indisponible : error sending request : client error (Connect) : tcp connect error : Connection refused (os error 111)",
      undefined,
      "injoignable",
    ],
    ["Serveur du modèle injoignable : dns error", undefined, "injoignable"],
    [
      "Serveur du modèle injoignable : le serveur du modèle ne répond pas (délai dépassé).",
      undefined,
      "delai",
    ],
    [
      "Aucun modèle n'est configuré : renseignez son adresse dans les réglages.",
      undefined,
      "non-configure",
    ],
    ["HTTP 401 Unauthorized", 401, "cle"],
    ["Forbidden", 403, "cle"],
    ["model not found", 404, "introuvable"],
    ["Bad Gateway", 502, "injoignable"],
    ["Gateway Timeout", 504, "delai"],
    // Serveur web : SDK OpenAI et liste des modèles
    ["Connection error.", undefined, "injoignable"],
    ["Request timed out.", undefined, "delai"],
    ["Le serveur du modèle (http://x) refuse GET /v1/models : HTTP 401", undefined, "cle"],
    [
      "Le serveur du modèle ne liste aucun modèle de génération. Renseignez LLM_MODEL_NAME.",
      undefined,
      "introuvable",
    ],
    ["Internal Server Error", 500, "autre"],
    ["quelque chose d'inattendu", undefined, "autre"],
  ])("%s (statut %s) → %s", (message, status, cause) => {
    expect(classerErreurModele(Object.assign(new Error(message), { status }))).toBe(cause);
  });
});

describe("messageErreurModele", () => {
  it("bureau : renvoie vers Paramètres → IA", () => {
    expect(messageErreurModele("injoignable", true)).toBe(
      "Le modèle ne répond pas. Vérifiez son adresse dans Paramètres → IA, et qu'il est bien démarré.",
    );
    expect(messageErreurModele("cle", true)).toBe(
      "Le modèle a refusé la clé API. Vérifiez-la dans Paramètres → IA.",
    );
  });

  it("aucun message ne contient de jargon technique", () => {
    for (const cause of [
      "non-configure",
      "injoignable",
      "cle",
      "introuvable",
      "delai",
      "autre",
    ] as const) {
      for (const modifiable of [true, false]) {
        expect(messageErreurModele(cause, modifiable)).not.toMatch(
          /HTTP|tcp|serveur de correction|\b\d{3}\b/i,
        );
      }
    }
  });
});

describe("correctText — erreurs du modèle", () => {
  afterEach(() => vi.restoreAllMocks());

  it("502 : le message simple du gestionnaire, le détail technique à part", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "LLM unavailable",
          message: "Le modèle a refusé la clé API. Vérifiez-la dans Paramètres → IA.",
          cause: "cle",
          details: "HTTP 401 Unauthorized",
        }),
        { status: 502 },
      ),
    );
    const erreur = await correctText("texte", reglages).catch((e) => e);
    expect(erreur).toBeInstanceOf(ErreurCorrection);
    expect(erreur.message).toBe("Le modèle a refusé la clé API. Vérifiez-la dans Paramètres → IA.");
    expect(erreur.details).toBe("HTTP 502 : HTTP 401 Unauthorized");
  });

  it("réponse sans message (ancien serveur) : message générique court", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("oups", { status: 500 }));
    const erreur = await correctText("texte", reglages).catch((e) => e);
    expect(erreur.message).toBe("La correction a échoué. Réessayez dans un instant.");
    expect(erreur.details).toBe("HTTP 500");
  });

  it("délai de 120 s dépassé : message simple", async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
        const signal = (init as RequestInit).signal!;
        return new Response(
          new ReadableStream({
            start(controller) {
              signal.addEventListener("abort", () =>
                controller.error(new DOMException("Aborted", "AbortError")),
              );
            },
          }),
        );
      });
      const promesse = correctText("texte", reglages).catch((e) => e);
      await vi.advanceTimersByTimeAsync(120_000);
      const erreur = await promesse;
      expect(erreur).toBeInstanceOf(ErreurCorrection);
      expect(erreur.message).toBe(
        "Le modèle a mis trop de temps à répondre. Réessayez, ou corrigez un texte plus court.",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
