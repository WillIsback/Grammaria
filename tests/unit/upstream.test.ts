import { describe, expect, it, vi } from "vite-plus/test";
import {
  AUTO_MODEL,
  downstreamHeaders,
  pickChatModel,
  resolveModel,
  upstreamHeaders,
  isThinkingParamRejection,
} from "../../src/utils/upstream";

describe("upstreamHeaders", () => {
  // Régression QA : le relais transmettait `Host: 127.0.0.1:25000` au
  // fournisseur LLM ; derrière un reverse proxy (Albert, OpenAI, CDN), la
  // requête était rejetée et la liste des modèles ne se chargeait pas.
  it("ne retransmet pas Host ni les en-têtes de connexion", () => {
    const incoming = new Headers({
      Host: "127.0.0.1:25000",
      Connection: "keep-alive",
      "Content-Length": "42",
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    });
    const out = upstreamHeaders(incoming);
    expect(out.get("host")).toBeNull();
    expect(out.get("connection")).toBeNull();
    expect(out.get("content-length")).toBeNull();
    expect(out.get("content-type")).toBe("application/json");
    expect(out.get("accept")).toBe("text/event-stream");
  });

  it("remplace l'Authorization factice de l'interface par la clé configurée", () => {
    const out = upstreamHeaders(
      new Headers({ Authorization: "Bearer no-key-needed" }),
      "sk-réelle",
    );
    expect(out.get("authorization")).toBe("Bearer sk-réelle");
  });

  it("sans clé configurée, laisse l'Authorization reçue", () => {
    const out = upstreamHeaders(new Headers({ Authorization: "Bearer x" }), "");
    expect(out.get("authorization")).toBe("Bearer x");
  });

  it("ne modifie pas les en-têtes d'origine", () => {
    const incoming = new Headers({ Host: "localhost:25000" });
    upstreamHeaders(incoming);
    expect(incoming.get("host")).toBe("localhost:25000");
  });
});

describe("downstreamHeaders", () => {
  // Régression QA : Albert répond en gzip ; fetch décompresse le corps mais le
  // relais renvoyait Content-Encoding: gzip → ERR_CONTENT_DECODING_FAILED dans
  // le navigateur, et la liste des modèles restait vide.
  it("retire Content-Encoding et Content-Length, garde le reste", () => {
    const out = downstreamHeaders(
      new Headers({
        "Content-Encoding": "gzip",
        "Content-Length": "123",
        "Content-Type": "application/json",
        "X-Request-Id": "abc",
      }),
    );
    expect(out.get("content-encoding")).toBeNull();
    expect(out.get("content-length")).toBeNull();
    expect(out.get("content-type")).toBe("application/json");
    expect(out.get("x-request-id")).toBe("abc");
  });
});

describe("pickChatModel", () => {
  it("liste typée (Albert) : écarte embeddings, reranking, transcription", () => {
    expect(
      pickChatModel([
        { id: "bge-m3", type: "text-embeddings-inference" },
        { id: "whisper-large-v3", type: "automatic-speech-recognition" },
        { id: "mistral-small", type: "text-generation" },
        { id: "gemma", type: "text-generation" },
      ]),
    ).toBe("mistral-small");
  });

  it("liste non typée (vLLM, Ollama) : premier modèle", () => {
    expect(pickChatModel([{ id: "qwen2.5:3b" }, { id: "llama3" }])).toBe("qwen2.5:3b");
  });

  it("types inconnus : premier modèle plutôt que rien", () => {
    expect(pickChatModel([{ id: "a", type: "custom" }])).toBe("a");
  });

  it("liste vide ou invalide : null", () => {
    expect(pickChatModel([])).toBeNull();
    expect(pickChatModel([{ id: "" }])).toBeNull();
  });
});

describe("resolveModel", () => {
  const never = vi.fn(async () => "détecté");

  it("LLM_MODEL_NAME l'emporte", async () => {
    expect(await resolveModel("config", "ui", never)).toBe("config");
  });

  it("puis le modèle choisi dans l'interface", async () => {
    expect(await resolveModel("", "ui", never)).toBe("ui");
  });

  // Régression QA : sans LLM_MODEL_NAME et sans liste de modèles, l'interface
  // envoie « auto », transmis tel quel → 404 chez le fournisseur.
  it.each([AUTO_MODEL, "", undefined, null])(
    "détecte le modèle quand l'interface envoie %j",
    async (requested) => {
      const detect = vi.fn(async () => "mistral-small");
      expect(await resolveModel("", requested, detect)).toBe("mistral-small");
      expect(detect).toHaveBeenCalledOnce();
    },
  );

  it("échec de détection : erreur explicite", async () => {
    await expect(resolveModel("", AUTO_MODEL, async () => null)).rejects.toThrow(/LLM_MODEL_NAME/);
  });
});

// Issue #10 : relancer sans chat_template_kwargs quand une API le refuse.
describe("isThinkingParamRejection", () => {
  it.each([
    [{ status: 400, message: "Unrecognized request argument supplied: chat_template_kwargs" }],
    [{ status: 422, message: "extra fields not permitted: chat_template_kwargs" }],
    [{ status: 400, message: "Unknown parameter: 'chat_template_kwargs'." }],
  ])("reconnaît un refus du paramètre : %j", (err) => {
    expect(isThinkingParamRejection(err)).toBe(true);
  });

  it.each([
    [{ status: 401, message: "chat_template_kwargs" }],
    [{ status: 400, message: "maximum context length exceeded" }],
    [new Error("fetch failed")],
    [null],
  ])("ignore une autre erreur : %j", (err) => {
    expect(isThinkingParamRejection(err)).toBe(false);
  });
});
