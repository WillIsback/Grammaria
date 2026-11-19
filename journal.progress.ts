import type { Database } from "bun:sqlite";
import type { LigneFaute, LigneTexte } from "./src/analysis/progression/calcul.ts";

/**
 * Lecture du journal pour l'écran « Progression » : uniquement des SELECT sur
 * les tables existantes. Le calcul est fait par `src/analysis/progression/`.
 */

/** Tous les textes corrigés (date, mots, fautes), du plus ancien au plus récent. */
export function lireTextes(db: Database): LigneTexte[] {
  return db
    .query(
      `SELECT created_at AS at, word_count AS words, fault_count AS faults
       FROM texts ORDER BY created_at`,
    )
    .all() as LigneTexte[];
}

/** Fautes comptées dans la note depuis `since` (millisecondes). */
export function lireFautes(db: Database, since: number): LigneFaute[] {
  return db
    .query(
      `SELECT created_at AS at, rule_key AS ruleKey, word, replacement, message,
              category_name AS categoryName
       FROM faults WHERE counted = 1 AND created_at >= ? ORDER BY created_at`,
    )
    .all(since) as LigneFaute[];
}
