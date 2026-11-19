import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Journal } from "../journal.ts";
import { analyze } from "../src/analysis/analyze.ts";

/** Outils communs aux tests du journal. */

export const DAY = 24 * 60 * 60 * 1000;
/**
 * Lundi 6 janvier 2025, midi, heure locale : un décalage d'un jour change
 * toujours de jour calendaire. Date passée : la migration évalue les badges à
 * l'heure réelle.
 */
export const J0 = new Date(2025, 0, 6, 12).getTime();
export const jour = (n: number) => J0 + n * DAY;

/** Texte d'origine et texte corrigé : une faute « on / ont ». */
export const FAUTE_ON: [string, string] = [
  "Hier, ils on mangé tous les gâteaux.",
  "Hier, ils ont mangé tous les gâteaux.",
];
export const SANS_FAUTE: [string, string] = [
  "Tout va bien aujourd'hui.",
  "Tout va bien aujourd'hui.",
];

/** Journalise la correction d'un texte, comme `POST /api/analyze`. */
export function corriger(
  journal: Journal,
  [original, corrige]: string[],
  now: number,
  random = () => 0,
) {
  return journal.record(analyze(original, corrige, []), now, { original, random });
}

/** Lance `test` avec le chemin d'une base dans un dossier temporaire, effacé ensuite. */
export function avecBase(test: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "grammaria-journal-"));
  try {
    test(join(dir, "journal.db"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
