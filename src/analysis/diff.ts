import DiffMatchPatch from "diff-match-patch";

/** Un passage du texte d'origine remplacé par le correcteur. */
export interface Hunk {
  /** Position de début dans le texte d'origine. */
  start: number;
  /** Position de fin (exclue) dans le texte d'origine. */
  end: number;
  before: string;
  after: string;
}

// Un mot (avec apostrophes et traits d'union internes : « c'est », « est-ce »),
// une suite d'espaces, ou un signe isolé.
const TOKEN_RE = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*|\s+|[^\s\p{L}\p{N}]/gu;
const WORD_RE = /[\p{L}\p{N}]/u;

export function tokenize(text: string): string[] {
  return text.match(TOKEN_RE) ?? [];
}

export function countWords(text: string): number {
  return tokenize(text).filter((t) => WORD_RE.test(t)).length;
}

/**
 * Diff au niveau du mot entre le texte d'origine et le texte corrigé.
 * Chaque token est encodé sur un caractère pour que diff-match-patch compare
 * des mots entiers et non des lettres.
 */
export function diffHunks(original: string, corrected: string): Hunk[] {
  const table = new Map<string, string>();
  const tokens: string[] = [""];
  const encode = (text: string): string =>
    tokenize(text)
      .map((token) => {
        let code = table.get(token);
        if (code === undefined) {
          code = String.fromCharCode(tokens.length);
          table.set(token, code);
          tokens.push(token);
        }
        return code;
      })
      .join("");
  const decode = (encoded: string): string =>
    Array.from(encoded, (ch) => tokens[ch.charCodeAt(0)]).join("");

  const dmp = new DiffMatchPatch();
  dmp.Diff_Timeout = 0;
  const diffs = dmp.diff_main(encode(original), encode(corrected), false);

  const hunks: Hunk[] = [];
  let pos = 0;
  let pending: Hunk | null = null;
  const flush = () => {
    if (pending) hunks.push(pending);
    pending = null;
  };

  for (const [op, encoded] of diffs) {
    const text = decode(encoded);
    if (op === DiffMatchPatch.DIFF_EQUAL) {
      flush();
      pos += text.length;
      continue;
    }
    if (!pending) pending = { start: pos, end: pos, before: "", after: "" };
    if (op === DiffMatchPatch.DIFF_DELETE) {
      pending.before += text;
      pending.end += text.length;
      pos += text.length;
    } else {
      pending.after += text;
    }
  }
  flush();
  return hunks;
}
