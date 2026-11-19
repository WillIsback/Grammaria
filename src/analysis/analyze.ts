import type { LTMatch } from "../types";
import { ACCORD_MESSAGE, ACCORD_RULE_KEY, detecterAccord } from "./accord";
import { countWords, diffHunks, type Hunk } from "./diff";
import { detecterConfusion, FICHES, type Fiche } from "./fiches";
import { noteSur20 } from "./score";

interface Fault {
  /** Clé stable de la règle : fiche interne ou identifiant LanguageTool. */
  ruleKey: string;
  source: "fiche" | "lt" | "accord";
  categoryId: string;
  categoryName: string;
  issueType: string;
  message: string;
  /** Forme fautive telle qu'écrite (en minuscules). */
  word: string;
  /** Ce que le correcteur a écrit à la place. */
  replacement: string;
  /** Phrase d'origine contenant la faute. */
  sentence: string;
  /** Vrai si la faute entre dans la note (orthographe, grammaire). */
  counted: boolean;
}

export interface AnalyzedCorrection {
  /** Position du passage dans le texte d'origine (fin exclue). */
  start: number;
  end: number;
  avant: string;
  apres: string;
  /** Vide : modification du correcteur non classée. */
  faults: Fault[];
  fiche: Fiche | null;
}

export interface Analysis {
  corrections: AnalyzedCorrection[];
  wordCount: number;
  /** Fautes comptées dans la note. */
  faultCount: number;
  /** Modifications que ni les fiches ni LanguageTool n'expliquent. */
  unclassifiedCount: number;
  score: number | null;
}

const NON_COUNTED_ISSUE_TYPES = new Set([
  "typographical",
  "whitespace",
  "style",
  "register",
  "locale-violation",
]);
const NON_COUNTED_CATEGORY = /TYPOGRAPH|PUNCTUATION|PONCTUATION|STYLE|CASING/i;

/** La typographie, la ponctuation et le style n'entrent pas dans la note. */
export function isCounted(match: LTMatch): boolean {
  if (NON_COUNTED_ISSUE_TYPES.has(match.rule.issueType ?? "")) return false;
  return !NON_COUNTED_CATEGORY.test(match.rule.category?.id ?? "");
}

function overlaps(hunk: Hunk, match: LTMatch): boolean {
  const matchEnd = match.offset + match.length;
  // Une insertion pure n'occupe aucun caractère : on accepte le contact.
  if (hunk.start === hunk.end) return match.offset <= hunk.start && hunk.start <= matchEnd;
  return match.offset < hunk.end && hunk.start < matchEnd;
}

/**
 * Ponctuation retouchée sans conséquence pour l'apprentissage (virgule,
 * point, guillemets…). L'apostrophe et le trait d'union en sont exclus : ils
 * font partie des mots (« l'équipe », « est-ce »), les corriger relève de
 * l'orthographe.
 */
const PONCTUATION = /[^\P{P}'’\-\u2010\u2011]/gu;
const ESPACES = /\s/gu;

/** Vrai si « avant → après » ne diffère que par la ponctuation et les espaces. */
export function isPunctuationOnly(before: string, after: string): boolean {
  const strip = (s: string) => s.replace(PONCTUATION, "").replace(ESPACES, "");
  return before !== after && strip(before) === strip(after);
}

const MAX_SENTENCE_LENGTH = 300;

export function sentenceAt(text: string, offset: number): string {
  const isBoundary = (ch: string) => ch === "." || ch === "!" || ch === "?" || ch === "\n";
  let start = Math.min(offset, text.length);
  while (start > 0 && !isBoundary(text[start - 1])) start--;
  let end = Math.min(offset, text.length);
  while (end < text.length && !isBoundary(text[end])) end++;
  if (end < text.length && text[end] !== "\n") end++;
  return text.slice(start, end).trim().slice(0, MAX_SENTENCE_LENGTH);
}

/**
 * Croise les modifications du correcteur avec les détections LanguageTool.
 *
 * Une détection LanguageTool n'est retenue que si le correcteur a réellement
 * modifié le passage : ce croisement écarte les faux positifs. Une modification
 * sans détection correspondante reste visible mais n'est ni classée ni comptée.
 */
export function analyze(original: string, corrected: string, matches: LTMatch[]): Analysis {
  const used = new Set<LTMatch>();
  const corrections: AnalyzedCorrection[] = [];
  let unclassifiedCount = 0;

  for (const hunk of diffHunks(original, corrected)) {
    const overlapping = matches.filter((m) => !used.has(m) && overlaps(hunk, m));
    // Ponctuation : appliquée dans le texte corrigé, mais invisible. Ni
    // listée, ni comptée, ni journalisée (elle ne nourrit aucune intervention).
    if (isPunctuationOnly(hunk.before, hunk.after)) {
      for (const m of overlapping) used.add(m);
      continue;
    }
    const base = {
      replacement: hunk.after.trim(),
      sentence: sentenceAt(original, hunk.start),
    };

    const ficheKey = detecterConfusion(hunk.before, hunk.after);
    let faults: Fault[];
    if (ficheKey) {
      faults = [
        {
          ...base,
          ruleKey: ficheKey,
          source: "fiche",
          categoryId: "CONFUSION",
          categoryName: "Confusion de mots",
          issueType: "grammar",
          message: FICHES[ficheKey].titre,
          word: hunk.before.trim().toLowerCase(),
          counted: true,
        },
      ];
    } else {
      faults = overlapping.map((m) => ({
        ...base,
        ruleKey: m.rule.id,
        source: "lt" as const,
        categoryId: m.rule.category?.id ?? "",
        categoryName: m.rule.category?.name ?? "",
        issueType: m.rule.issueType ?? "",
        message: m.shortMessage || m.message,
        word: original.slice(m.offset, m.offset + m.length).toLowerCase(),
        counted: isCounted(m),
      }));
    }
    if (!ficheKey && faults.length === 0 && detecterAccord(hunk.before, hunk.after)) {
      faults = [
        {
          ...base,
          ruleKey: ACCORD_RULE_KEY,
          source: "accord",
          categoryId: "ACCORD",
          categoryName: "Accord",
          issueType: "grammar",
          message: ACCORD_MESSAGE,
          word: hunk.before.trim().toLowerCase(),
          counted: true,
        },
      ];
    }
    for (const m of overlapping) used.add(m);

    const whitespaceOnly = hunk.before.trim() === hunk.after.trim();
    if (faults.length === 0 && whitespaceOnly) continue;
    if (faults.length === 0) unclassifiedCount++;

    corrections.push({
      start: hunk.start,
      end: hunk.end,
      avant: hunk.before,
      apres: hunk.after,
      faults,
      fiche: ficheKey ? FICHES[ficheKey] : null,
    });
  }

  const wordCount = countWords(original);
  const faultCount = corrections.reduce((n, c) => n + c.faults.filter((f) => f.counted).length, 0);

  return {
    corrections,
    wordCount,
    faultCount,
    unclassifiedCount,
    score: noteSur20(faultCount, wordCount),
  };
}
