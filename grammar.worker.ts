/**
 * Worker du correcteur grammatical (portage JavaScript de LanguageTool).
 *
 * L'analyse est un calcul CPU de plusieurs centaines de millisecondes sur un
 * long texte : dans le thread principal, elle figerait les flux SSE de la
 * correction en cours. Le chargement des règles françaises (quelques
 * secondes) se fait une seule fois, au premier message.
 */

interface CheckRequest {
  id: number;
  text: string;
}

const engine = import("@valueerror/ltjs-core");

self.onmessage = async (event: MessageEvent<CheckRequest>) => {
  const { id, text } = event.data;
  try {
    const { check } = await engine;
    const result = await check(text, { language: "fr" });
    self.postMessage({ id, matches: result.matches });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
