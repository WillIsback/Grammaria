import { describe, expect, it, vi } from "vite-plus/test";
import { creerDetecteurModele, listerModelesAmont, modelesDuCorps } from "../../src/utils/modeles";

// Liste des modèles et détection du modèle par défaut, utilisées par le
// gestionnaire d'API (serveur et bureau). Mêmes garanties que createModelDetector.

const okResponse = (body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

describe("listerModelesAmont", () => {
  it("interroge /v1/models avec la clé et renvoie le corps", async () => {
    const fetchMock = vi.fn(() => okResponse({ data: [{ id: "m1" }] }));
    const corps = await listerModelesAmont(
      "https://llm.example",
      "sk-1",
      fetchMock as unknown as typeof fetch,
    );
    expect(corps).toEqual({ data: [{ id: "m1" }] });
    expect(fetchMock).toHaveBeenCalledWith("https://llm.example/v1/models", {
      headers: { Authorization: "Bearer sk-1" },
    });
  });

  it("serveur injoignable ou refus : erreur explicite ; non JSON : null", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(new Response("<html>", { status: 200 }));
    const lister = () => listerModelesAmont("http://x", "", fetchMock as unknown as typeof fetch);
    await expect(lister()).rejects.toThrow(
      "Le serveur du modèle (http://x) est injoignable : ECONNREFUSED",
    );
    await expect(lister()).rejects.toThrow("HTTP 401");
    expect(await lister()).toBeNull();
    expect(fetchMock.mock.calls[2]).toEqual(["http://x/v1/models", { headers: {} }]);
  });
});

describe("modelesDuCorps", () => {
  it.each([[null], [{}], [{ data: "x" }], ["<html>"]])("corps sans liste %j : []", (corps) => {
    expect(modelesDuCorps(corps)).toEqual([]);
  });
});

describe("creerDetecteurModele", () => {
  it("retient le premier modèle de génération, en cache jusqu'à oublier()", async () => {
    const lister = vi.fn(async () => ({
      data: [
        { id: "e", type: "embedding" },
        { id: "m1", type: "chat" },
      ],
    }));
    const detecter = creerDetecteurModele(lister);
    expect(await detecter()).toBe("m1");
    expect(await detecter()).toBe("m1");
    expect(lister).toHaveBeenCalledOnce();
    detecter.oublier();
    expect(await detecter()).toBe("m1");
    expect(lister).toHaveBeenCalledTimes(2);
  });

  it("un échec n'est pas mis en cache ; une liste vide donne null", async () => {
    const lister = vi
      .fn()
      .mockRejectedValueOnce(new Error("injoignable"))
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [{ id: "m2" }] });
    const detecter = creerDetecteurModele(lister);
    await expect(detecter()).rejects.toThrow("injoignable");
    expect(await detecter()).toBeNull();
    expect(await detecter()).toBe("m2");
  });
});
