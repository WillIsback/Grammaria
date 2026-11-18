/**
 * Nettoie la sortie brute du correcteur, qui doit être le texte corrigé seul.
 * Certains modèles ajoutent malgré la consigne un bloc de réflexion, les
 * balises de délimitation du prompt ou une clôture de code.
 * Fonctionne aussi sur une sortie partielle en cours de streaming.
 */
export function cleanLlmOutput(raw: string): string {
  return raw
    .replace(/<think>[\s\S]*?(<\/think>|$)/g, "")
    .replace(/^\s*```[a-z]*\n?/i, "")
    .replace(/\n?```\s*$/, "")
    .replace(/^\s*<texte>\n?/i, "")
    .replace(/\n?<\/texte>\s*$/i, "")
    .trim();
}
