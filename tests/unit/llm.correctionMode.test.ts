import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { CorrectionSettings } from "../../src/types";
import { correctText } from "../../src/utils/llm";

const defaultSettings: CorrectionSettings = {
  mode: "formel",
  fixGrammar: true,
  fixSpelling: true,
  fixSyntax: true,
  fixStyle: true,
};

function makeSseMock(textPayload = "Texte corrigé.") {
  const encoder = new TextEncoder();
  const half = Math.ceil(textPayload.length / 2);
  const chunks = [
    encoder.encode(`data: ${JSON.stringify({ delta: textPayload.slice(0, half) })}\n\n`),
    encoder.encode(`data: ${JSON.stringify({ delta: textPayload.slice(half) })}\n\n`),
    encoder.encode(`data: ${JSON.stringify({ done: true, text: textPayload, duration: 100 })}\n\n`),
  ];
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
  });
}

describe("correctText — correction_mode", () => {
  beforeEach(() => {
    vi.stubGlobal("import.meta", { env: {} });
  });

  it("envoie correction_mode dans le body de la requête LLM", async () => {
    const mockFetch = makeSseMock();
    vi.spyOn(globalThis, "fetch").mockImplementation(mockFetch);

    await correctText("Texte a corriger.", { ...defaultSettings, mode: "informel" });

    const fetchCall = mockFetch.mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.correction_mode).toBe("informel");
  });

  it("envoie correction_mode pour chaque mode", async () => {
    for (const mode of ["formel", "semi-formel", "informel", "technical"] as const) {
      const mockFetch = makeSseMock();
      vi.spyOn(globalThis, "fetch").mockImplementation(mockFetch);

      await correctText("Texte.", { ...defaultSettings, mode: mode as CorrectionSettings["mode"] });

      const fetchCall = mockFetch.mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.correction_mode).toBe(mode);
    }
  });

  it("transmet le texte au fil du streaming puis renvoie le texte final", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(makeSseMock("Bonjour à tous."));
    const seen: string[] = [];

    const result = await correctText("Bonjour a tous.", defaultSettings, {
      onText: (text) => seen.push(text),
    });

    expect(seen).toEqual(["Bonjour", "Bonjour à tous."]);
    expect(result).toEqual({ text: "Bonjour à tous.", duration: 100 });
  });

  it("envoie le texte à corriger entre balises", async () => {
    const mockFetch = makeSseMock();
    vi.spyOn(globalThis, "fetch").mockImplementation(mockFetch);

    await correctText("Texte a corriger.", defaultSettings);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.messages[1].content).toBe("<texte>\nTexte a corriger.\n</texte>");
  });
});
