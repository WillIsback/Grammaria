import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
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
    const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
      if (url === "/api/check") return json({ matches });
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
    expect(JSON.parse(analyzeCall?.[1]?.body as string)).toEqual({
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
    const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
      if (url === "/api/check") return json({ matches: [] });
      return json({}, false);
    });

    const result = await runCorrection(fetchMock);

    expect(result.current.outputText).toBe(CORRECTED);
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.analysisNotice).toContain("indisponible");
  });

  it("signale une analyse partielle quand le correcteur grammatical ne répond pas", async () => {
    const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
      if (url === "/api/check") return Promise.reject(new Error("down"));
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
    expect(JSON.parse(analyzeCall?.[1]?.body as string).matches).toEqual([]);
  });
});

// Régression QA (2026-11-18) : le texte envoyé au correcteur était nettoyé et
// tronqué, mais la détection grammaticale et /api/analyze recevaient le texte brut. La partie
// coupée apparaissait comme une « correction » comptée comme faute, sans que
// l'utilisateur sache que la fin de son texte avait disparu.
describe("useCorrector — texte préparé et troncature", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn().mockReturnValue(null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
    });
  });

  const analysisBody = {
    corrections: [],
    wordCount: 1,
    faultCount: 0,
    unclassifiedCount: 0,
    score: 20,
    week: { texts: 1, words: 1, faults: 0, score: 20 },
  };

  async function correctWith(input: string) {
    const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
      if (url === "/api/check") return json({ matches: [] });
      return json(analysisBody);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { correctText } = await import("../../src/utils/llm");
    vi.mocked(correctText).mockReset();
    vi.mocked(correctText).mockImplementation(async (text: string) => ({ text, duration: 1 }));

    const { result } = renderHook(() => useCorrector());
    await act(async () => {
      result.current.setTextContent(input);
    });
    await act(async () => {
      await result.current.handleCorrect();
    });
    await waitFor(() => expect(result.current.analysis).not.toBeNull());

    const ltBody = fetchMock.mock.calls.find(([url]) => url === "/api/check")?.[1]?.body;
    const analyzeBody = fetchMock.mock.calls.find(([url]) => url === "/api/analyze")?.[1]?.body;
    return {
      result,
      sentToLlm: vi.mocked(correctText).mock.calls[0]?.[0],
      sentToLt: JSON.parse(ltBody as string).text,
      analyzed: JSON.parse(analyzeBody as string),
    };
  }

  it("un texte trop long est coupé partout pareil et l'utilisateur est prévenu", async () => {
    const long = "Le projet avance bien. ".repeat(600); // 13 800 caractères
    const { result, sentToLlm, sentToLt, analyzed } = await correctWith(long);

    expect(sentToLlm.length).toBeLessThanOrEqual(10000);
    expect(sentToLt).toBe(sentToLlm);
    expect(analyzed.original).toBe(sentToLlm);
    expect(analyzed.corrected).toBe(sentToLlm);
    expect(result.current.analysisNotice).toMatch(/dépasse 10[\s\u202f]000 caractères/);
  });

  it("aucun avertissement pour un texte court", async () => {
    const { result } = await correctWith("Bonjour à tous.");
    expect(result.current.analysisNotice).toBeNull();
  });

  it("les caractères typographiques arrivent intacts au correcteur et à l'analyse", async () => {
    const text = "Le cœur de l’équipe a coûté 10 €… Brzęczyszczykiewicz 😊";
    const { sentToLlm, sentToLt, analyzed } = await correctWith(`  ${text}  `);
    expect(sentToLlm).toBe(text);
    expect(sentToLt).toBe(text);
    expect(analyzed.original).toBe(text);
  });

  describe("question de révision (issue #62)", () => {
    const QUESTION = {
      reviewId: 12,
      ruleKey: "PAIRE:on/ont",
      titre: "on / ont",
      explication: "Remplacez par « avaient ».",
      avant: "Les clients ",
      apres: " confirmé leur venue.",
      formes: [
        { texte: "on", correcte: false },
        { texte: "ont", correcte: true },
      ],
    };
    const ANALYSE = {
      corrections: [],
      wordCount: 5,
      faultCount: 0,
      unclassifiedCount: 0,
      score: 20,
    };
    const serveur = (question: unknown) =>
      vi.fn((url: string, _init?: RequestInit) => {
        if (url === "/api/check") return json({ matches: [] });
        if (url === "/api/revision") return json({ question });
        return json(ANALYSE);
      });
    const corpsAnalyse = (fetchMock: ReturnType<typeof vi.fn>) => {
      const appel = fetchMock.mock.calls.find(([url]) => url === "/api/analyze");
      if (!appel) throw new Error("l'analyse n'a pas été appelée");
      return JSON.parse((appel[1] as RequestInit).body as string);
    };

    it("demande une question au lancement et la rend disponible à l'écran", async () => {
      const fetchMock = serveur(QUESTION);
      const result = await runCorrection(fetchMock);
      expect(fetchMock.mock.calls.some(([url]) => url === "/api/revision")).toBe(true);
      await waitFor(() => expect(result.current.revision).toEqual(QUESTION));
    });

    it("prévient l'analyse qu'une question a été posée pour ce texte", async () => {
      const fetchMock = serveur(QUESTION);
      await runCorrection(fetchMock);
      expect(corpsAnalyse(fetchMock).revisionPosee).toBe(true);
    });

    it("ne signale rien à l'analyse quand aucune question n'était due", async () => {
      const fetchMock = serveur(null);
      const result = await runCorrection(fetchMock);
      expect(result.current.revision).toBeNull();
      expect(corpsAnalyse(fetchMock).revisionPosee).toBeUndefined();
    });

    it("ne demande rien quand le réglage est désactivé", async () => {
      const fetchMock = serveur(QUESTION);
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const { correctText } = await import("../../src/utils/llm");
      vi.mocked(correctText).mockResolvedValue({ text: CORRECTED, duration: 42 });
      const { result } = renderHook(() => useCorrector());
      await act(async () => {
        result.current.setTextContent(ORIGINAL);
        result.current.setSettings({ ...result.current.settings, revisionQuestion: false });
      });
      await act(async () => {
        await result.current.handleCorrect();
      });
      expect(fetchMock.mock.calls.some(([url]) => url === "/api/revision")).toBe(false);
      expect(result.current.revision).toBeNull();
    });

    it("une panne de la question ne gêne pas la correction", async () => {
      const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
        if (url === "/api/check") return json({ matches: [] });
        if (url === "/api/revision") return Promise.reject(new Error("panne"));
        return json(ANALYSE);
      });
      const result = await runCorrection(fetchMock);
      expect(result.current.outputText).toBe(CORRECTED);
      expect(result.current.revision).toBeNull();
    });
  });
});
