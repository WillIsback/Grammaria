/** Longueur maximale d'un texte envoyé au correcteur (caractères). */
export const MAX_CONTENT_LENGTH = 10000;

/**
 * Au-delà de cette distance de la limite, on coupe au caractère près plutôt
 * que de reculer jusqu'à la dernière espace (texte sans espace, par exemple).
 */
const WORD_BOUNDARY_LOOKBACK = 200;

/**
 * Caractères de contrôle C0 (sauf tabulation, saut de ligne, retour chariot),
 * DEL et contrôles C1. Tout le reste d'Unicode est conservé : apostrophe
 * typographique, œ, €, points de suspension, espaces insécables, lettres
 * accentuées d'autres langues, emojis…
 */
// oxlint-disable-next-line no-control-regex -- c'est précisément le but
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

export interface PreparedInput {
  /** Texte réellement envoyé au correcteur. */
  text: string;
  /** Vrai si le texte d'origine dépassait la limite et a été coupé. */
  truncated: boolean;
  /** Longueur du texte nettoyé avant la coupe. */
  originalLength: number;
}

function truncateAtWordBoundary(text: string, max: number): string {
  const cut = text.slice(0, max);
  // Si le caractère suivant est une espace, la coupe tombe déjà entre deux mots.
  if (/\s/.test(text[max] ?? "")) return cut.trimEnd();
  const lastSpace = cut.search(/\s\S*$/);
  if (lastSpace >= max - WORD_BOUNDARY_LOOKBACK) return cut.slice(0, lastSpace).trimEnd();
  return cut;
}

/**
 * Prépare le texte à corriger : retire les espaces de bord et les caractères
 * de contrôle, puis le coupe à MAX_CONTENT_LENGTH sur une frontière de mot.
 */
export function prepareInput(text: string): PreparedInput {
  const sanitized = text.trim().replace(CONTROL_CHARS, "");

  if (sanitized.length === 0) {
    throw new Error("Le texte ne peut pas être vide");
  }

  if (sanitized.length <= MAX_CONTENT_LENGTH) {
    return { text: sanitized, truncated: false, originalLength: sanitized.length };
  }

  return {
    text: truncateAtWordBoundary(sanitized, MAX_CONTENT_LENGTH),
    truncated: true,
    originalLength: sanitized.length,
  };
}

export function sanitizeInput(text: string): string {
  return prepareInput(text).text;
}
