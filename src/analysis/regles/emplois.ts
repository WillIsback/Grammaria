/**
 * Emplois corrects d'une règle (issue #60).
 *
 * « Quatorze jours sans faute » peut vouloir dire que la règle est maîtrisée,
 * ou qu'elle n'a pas servi. Pour les confusions de type paire (a / à,
 * on / ont…), on sait reconnaître un emploi correct : une forme de la paire
 * présente dans le texte d'origine et laissée intacte par la correction.
 *
 * Logique pure, sans mémoire : le journal n'en garde qu'un événement daté par
 * règle (« la règle a été employée correctement dans un texte »), jamais le
 * mot ni la phrase.
 */
import { paireDuMot } from "../fiches";

/** Vrai si l'on sait reconnaître les emplois corrects de la règle. */
export function detecteEmplois(ruleKey: string): boolean {
  return ruleKey.startsWith("PAIRE:");
}

// Un mot, apostrophes et traits d'union internes compris : « c'est » est une
// forme de paire, « qu'on » et « sont-ils » n'en sont pas.
const MOT_RE = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

/**
 * Règles de type paire employées correctement dans `original` : au moins une
 * de leurs formes y figure hors des passages modifiés par la correction
 * (`modifies`, positions dans le texte d'origine, fin exclue). Clés triées.
 */
export function reglesEmployees(
  original: string,
  modifies: readonly { start: number; end: number }[],
): string[] {
  const regles = new Set<string>();
  for (const m of original.matchAll(MOT_RE)) {
    const cle = paireDuMot(m[0]);
    if (!cle || regles.has(cle)) continue;
    const debut = m.index;
    const fin = debut + m[0].length;
    if (modifies.some((p) => p.start < fin && p.end > debut)) continue;
    regles.add(cle);
  }
  return [...regles].sort();
}
