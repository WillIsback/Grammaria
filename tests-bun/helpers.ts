import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal } from "../journal.ts";
import { ouvrirPiloteBun } from "../journal.driver.bun.ts";
import type { JournalDriver, Query, Statement } from "../journal.driver.ts";
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

/** Ouvre le journal sur le pilote Bun (`:memory:` par défaut). */
export function ouvrirJournal(path = ":memory:"): Promise<Journal> {
  return Journal.ouvrir(ouvrirPiloteBun(path));
}

/** Appels reçus par un pilote espion. */
export interface Appels {
  read: number;
  readMany: number;
  batch: number;
  /** Instructions de chaque lot. */
  lots: (readonly Statement[])[];
}

/**
 * Pilote espion : enveloppe le pilote Bun, compte ses appels et laisse un
 * test modifier une lecture ou un lot (`readMany`, `batch`) pour simuler une panne.
 */
export function piloteEspion(path = ":memory:") {
  const pilote = ouvrirPiloteBun(path);
  const appels: Appels = { read: 0, readMany: 0, batch: 0, lots: [] };
  const espion: JournalDriver & {
    /** Pilote enveloppé, pour écrire « à côté » du journal. */
    pilote: typeof pilote;
    appels: Appels;
    remettreAZero(): void;
    /** Transforme le résultat de chaque `readMany`. */
    apresReadMany?: (queries: readonly Query[], lignes: unknown[][]) => unknown[][];
    /** Appelé avant chaque lot ; peut lever une erreur. */
    avantBatch?: (statements: readonly Statement[]) => void;
  } = {
    pilote,
    appels,
    remettreAZero() {
      Object.assign(appels, { read: 0, readMany: 0, batch: 0, lots: [] });
    },
    read(sql, params) {
      appels.read++;
      return pilote.read(sql, params);
    },
    async readMany(queries) {
      appels.readMany++;
      const lignes = await pilote.readMany(queries);
      return espion.apresReadMany ? espion.apresReadMany(queries, lignes) : lignes;
    },
    batch(statements) {
      appels.batch++;
      appels.lots.push(statements);
      espion.avantBatch?.(statements);
      return pilote.batch(statements);
    },
    close: () => pilote.close(),
  };
  return espion;
}

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
export async function avecBase(test: (path: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "grammaria-journal-"));
  try {
    await test(join(dir, "journal.db"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
