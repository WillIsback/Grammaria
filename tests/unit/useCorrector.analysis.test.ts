import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCorrector } from "../../src/hooks/useCorrector";

vi.mock("../../src/utils/llm", () => ({
  correctText: vi.fn(),
}));

const ORIGINAL = "Ils on vu les dossier.";
const CORRECTED = "Ils ont vu les dossiers.";

function json(body: unknown, ok = true) {
  return Promise.resolve({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(body) });
}

async function runCorrection(fetchMock: ReturnType<typeof vi.fn>) {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const { correctText } = await import("../../src/utils/llm");
  vi.mocked(correctText).mockResolvedValue({ text: CORRECTED, duration: 42 });

  const { result } = renderHook(() => useCorrector());
  await act(async () => {
    result.current.setTextContent(ORIGINAL);
  });
  await act(async () => {
    await result.current.handleCorrect();
  });
  return result;
}

describe("useCorrector — analyse des fautes", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn().mockReturnValue(null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
    });
  });

  it("envoie le texte d'origine, le texte corrigé et les détections au journal", async () => {
    const matches = [{ offset: 4, length: 2, rule: { id: "ON_ONT" } }];
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/api/lt/")) return json({ matches });
      return json({
        corrections: [
          {
            avant: "on",
            apres: "ont",
            faults: [
              { message: "on / ont", categoryName: "Confusion de mots", ruleKey: "PAIRE:on/ont" },
            ],
            fiche: { titre: "on / ont", astuce: "Remplacez par « avaient »." },
          },
          { avant: "dossier", apres: "dossiers", faults: [], fiche: null },
        ],
        wordCount: 5,
        faultCount: 1,
        unclassifiedCount: 1,
        score: 0,
        week: { texts: 3, words: 120, faults: 4, score: 13.3 },
      });
    });

    const result = await runCorrection(fetchMock);
    await waitFor(() => expect(result.current.analysis).not.toBeNull());

    const analyzeCall = fetchMock.mock.calls.find(([url]) => url === "/api/analyze");
    expect(JSON.parse((analyzeCall?.[1] as RequestInit).body as string)).toEqual({
      original: ORIGINAL,
      corrected: CORRECTED,
      matches,
    });

    expect(result.current.outputText).toBe(CORRECTED);
    expect(result.current.corrections).toEqual([
      { avant: "on", apres: "ont", regle: "on / ont", astuce: "Remplacez par « avaient »." },
      { avant: "dossier", apres: "dossiers", regle: "Non classé", astuce: undefined },
    ]);
    expect(result.current.analysis?.week.score).toBe(13.3);
    expect(result.current.stats).toEqual({ processingTime: 42, modificationCount: 2 });
    expect(result.current.analysisNotice).toBeNull();
  });

  it("rend le texte corrigé même si l'analyse échoue", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/api/lt/")) return json({ matches: [] });
      return json({}, false);
    });

    const result = await runCorrection(fetchMock);

    expect(result.current.outputText).toBe(CORRECTED);
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.analysisNotice).toContain("indisponible");
  });

  it("signale une analyse partielle quand LanguageTool ne répond pas", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/api/lt/")) return Promise.reject(new Error("down"));
      return json({
        corrections: [],
        wordCount: 5,
        faultCount: 0,
        unclassifiedCount: 0,
        score: 20,
        week: { texts: 1, words: 5, faults: 0, score: 20 },
      });
    });

    const result = await runCorrection(fetchMock);
    await waitFor(() => expect(result.current.analysis).not.toBeNull());

    expect(result.current.analysisNotice).toContain("partielle");
    const analyzeCall = fetchMock.mock.calls.find(([url]) => url === "/api/analyze");
    expect(JSON.parse((analyzeCall?.[1] as RequestInit).body as string).matches).toEqual([]);
  });
});
