/**
 * Worker du correcteur grammatical (portage JavaScript de LanguageTool).
 *
 * L'analyse est un calcul CPU de plusieurs centaines de millisecondes sur un
 * long texte : dans le thread principal, elle figerait les flux SSE de la
 * correction en cours. Le chargement des règles françaises (quelques
 * secondes) se fait une seule fois, au démarrage du worker.
 */

interface CheckRequest {
  id: number;
  text: string;
}

// Import relatif : résolu dans le code embarqué, y compris dans l'exécutable
// compilé. Le gestionnaire ci-dessous est posé tout de suite, pendant le
// chargement : un message reçu avant serait perdu.
const engine = import("./grammar.engine.ts");

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
