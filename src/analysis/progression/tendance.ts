/**
 * Tendance d'une règle, affichée avant la note sur 20 (issue #63).
 *
 * Choix de conception : la notation met l'accent sur la progression, pas sur
 * le constat d'échec. On ne montre donc une tendance que lorsqu'elle est
 * favorable : le taux de fautes de la règle a baissé depuis sa première
 * intervention, sur un volume suffisant (mêmes critères que « Ce que changent
 * les astuces », `mesure.ts`). Quand une règle ne progresse pas, rien ne
 * s'affiche ici : l'astuce et le choix à deux formes font déjà le travail.
 *
 * Logique pure : un titre de règle et des chiffres, jamais un mot du texte.
 */
import type { Mesure } from "./mesure";

export interface TendanceRegle {
  ruleKey: string;
  /** Nom lisible de la règle. */
  titre: string;
  /** Fautes pour `motsParTaux` mots avant la première intervention, puis depuis. */
  avant: number;
  depuis: number;
  motsParTaux: number;
}

/**
 * Tendance à afficher pour un texte qui contient des fautes sur `reglesDuTexte` :
 * parmi ces règles, celle dont le taux a le plus baissé ; null si aucune ne
 * progresse de façon mesurable.
 */
export function choisirTendance(
  mesure: Mesure,
  reglesDuTexte: readonly string[],
): TendanceRegle | null {
  const duTexte = new Set(reglesDuTexte);
  let meilleure: (typeof mesure.suivies)[number] | null = null;
  for (const r of mesure.suivies) {
    if (!duTexte.has(r.ruleKey) || !r.suffisant) continue;
    if (r.evolution === null || r.evolution >= 0) continue;
    if (r.avant.taux === null || r.depuis.taux === null) continue;
    if (!meilleure || r.evolution < (meilleure.evolution ?? 0)) meilleure = r;
  }
  if (!meilleure) return null;
  return {
    ruleKey: meilleure.ruleKey,
    titre: meilleure.label,
    avant: meilleure.avant.taux as number,
    depuis: meilleure.depuis.taux as number,
    motsParTaux: mesure.motsParTaux,
  };
}
