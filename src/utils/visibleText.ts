/**
 * Version lisible d'un passage de la liste des corrections. Une correction qui
 * ne porte que sur des espaces (« Bonjour ,comment » → « Bonjour, comment »)
 * s'affichait comme une ligne vide ; un ajout ou une suppression, comme une
 * colonne vide.
 */
export function visibleText(text: string): string {
  if (text === "") return "∅";
  if (text.trim() === "") {
    return text.replace(/\r?\n/g, "↵").replace(/[ \t  ]/g, "␣");
  }
  return text;
}
