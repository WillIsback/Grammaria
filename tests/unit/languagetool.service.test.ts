import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { runLanguageTool } from "../../src/services/languagetool";
import type { LTResponse } from "../../src/types";

describe("runLanguageTool", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("texte vide → throw", async () => {
    await expect(runLanguageTool("   ")).rejects.toThrow("Le texte ne peut pas être vide");
  });

  it("interroge le correcteur intégré du serveur et retourne ses détections", async () => {
    const mockResponse: LTResponse = {
      matches: [
        {
          message: "Accord",
          shortMessage: "",
          offset: 4,
          length: 2,
          replacements: [{ value: "ont" }],
          rule: { id: "ON_ONT", category: { id: "CAT_GRAMMAIRE", name: "Grammaire" } },
        },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => mockResponse });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await runLanguageTool("Ils on vu.");

    expect(result).toEqual(mockResponse.matches);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/check");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ text: "Ils on vu." });
  });

  it("erreur du serveur → throw", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 503 }) as unknown as typeof fetch;
    await expect(runLanguageTool("Texte")).rejects.toThrow(
      "Le correcteur grammatical a échoué (HTTP 503).",
    );
  });

  it("propage l'annulation demandée par l'appelant", async () => {
    globalThis.fetch = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    ) as unknown as typeof fetch;
    const controller = new AbortController();
    const pending = runLanguageTool("Texte", controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("aborted");
  });
});
