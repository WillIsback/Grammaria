/**
 * Fautes d'accord (nombre, genre, personne) reconnues dans le diff.
 *
 * LanguageTool laisse passer beaucoup d'accords (« les enfants était
 * content »). Sans cette détection, la correction du modèle restait « Non
 * classé » et la note était surévaluée. On reconnaît un accord quand le mot
 * garde son radical et que seules les terminaisons d'accord changent :
 * « content → contents », « aidés → aidé », « était → étaient ».
 */

/** Terminaisons de nombre, de genre et de personne (imparfait, présent). */
const TERMINAISONS_ACCORD = new Set([
  "",
  "s",
  "x",
  "e",
  "es",
  "t",
  "nt",
  "ent",
  "it",
  "is",
  "ait",
  "ais",
  "ient",
  "aient",
]);

const MOT_SEUL = /^[\p{L}]+$/u;
const RADICAL_MIN = 3;

function prefixeCommun(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

export const ACCORD_RULE_KEY = "ACCORD";
export const ACCORD_MESSAGE = "Accord (nombre, genre ou personne)";

/** Vrai si « avant → après » ne change qu'une terminaison d'accord. */
export function detecterAccord(avant: string, apres: string): boolean {
  const a = avant.trim();
  const b = apres.trim();
  if (!MOT_SEUL.test(a) || !MOT_SEUL.test(b)) return false;
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la === lb) return false;

  // Le radical commun doit porter le mot : « éta-it / éta-ient », pas « ma / mon ».
  let n = prefixeCommun(la, lb);
  while (n >= RADICAL_MIN) {
    const fa = la.slice(n);
    const fb = lb.slice(n);
    if (TERMINAISONS_ACCORD.has(fa) && TERMINAISONS_ACCORD.has(fb)) {
      return n * 5 >= Math.min(la.length, lb.length) * 3;
    }
    // « étai-t / étaie-nt » : reculer d'une lettre pour retrouver la terminaison.
    n--;
  }
  return false;
}
