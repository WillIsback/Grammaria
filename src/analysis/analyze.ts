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
  /**
   * Message du correcteur grammatical, affiché pendant la correction. Il peut citer les
   * mots du texte : il n'est JAMAIS journalisé.
   */
  message: string;
  /**
   * Nom fixe de la règle (titre de la fiche, description de la règle du moteur) : le seul
   * libellé journalisé, il ne dépend jamais du texte analysé.
   */
  label: string;
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

/**
 * Règles du moteur rapportées sous un identifiant par entrée de dictionnaire : l'identifiant
 * et la description contiennent alors le mot écrit (`FR_SIMPLE_REPLACE_SIMPLE_JAI`,
 * « Mot incorrect : jai » ; `FR_COMPOUNDS_PILE_POIL`). Elles sont ramenées à leur règle
 * d'origine, sous un libellé fixe : ni la clé ni le libellé ne gardent un mot du texte.
 */
export const REGLES_PAR_MOT: Readonly<Record<string, string>> = {
  FR_SIMPLE_REPLACE_SIMPLE: "Mot incorrect",
  FR_COMPOUNDS: "Mots avec trait d’union",
};

/** Règle d'origine d'un identifiant de `REGLES_PAR_MOT` ; null pour une autre règle. */
export function regleParMot(id: string): string | null {
  for (const cle of Object.keys(REGLES_PAR_MOT)) {
    if (id === cle || id.startsWith(`${cle}_`)) return cle;
  }
  return null;
}

/**
 * Formes attendues des identifiants fixes d'une règle du moteur et d'une
 * catégorie (issue #41). Le serveur ne réexécute pas son moteur pour
 * `/api/analyze` : il reçoit les détections de la page. Un client falsifié
 * pourrait y glisser du texte de l'utilisateur dans `rule.id`,
 * `rule.description` ou `rule.category` — qui finissent dans le journal sur
 * disque. Les identifiants d'une vraie règle du moteur sont des codes en
 * capitales ; tout ce qui n'y ressemble pas est ramené à une valeur neutre, et
 * les libellés sont nettoyés et bornés, pour qu'aucun texte libre non borné ne
 * soit stocké. (Les deux familles de règles « par mot » sont déjà neutralisées
 * en amont par `REGLES_PAR_MOT`.)
 */
const RE_ID_REGLE = /^[A-Z0-9_]{1,80}(\[[0-9]{1,6}\])?$/;
const RE_ID_CATEGORIE = /^[A-Z0-9_]{0,64}$/;
/** Un libellé de règle (description fixe du moteur) est court ; on le plafonne. */
const LIBELLE_MAX = 120;
const CATEGORIE_NOM_MAX = 80;
// Caractères de contrôle C0 (hors tab/retours), DEL et C1.
// oxlint-disable-next-line no-control-regex -- on les retire volontairement
const CONTROLES = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/** Nettoie un libellé destiné au journal : contrôles retirés, espaces compactés, borné. */
function libelleFixe(valeur: string | undefined, max: number): string {
  return (valeur ?? "").replace(CONTROLES, "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Clé et libellé fixes d'une règle du moteur (voir `REGLES_PAR_MOT`). */
export function regleDuMoteur(rule: LTMatch["rule"]): { ruleKey: string; label: string } {
  const parMot = regleParMot(rule.id);
  if (parMot) return { ruleKey: parMot, label: REGLES_PAR_MOT[parMot] };
  // Identifiant non conforme à celui d'une règle du moteur : détection forgée,
  // ramenée à une clé et un libellé neutres (aucun texte libre stocké).
  if (!RE_ID_REGLE.test(rule.id)) return { ruleKey: "AUTRE", label: "Autre" };
  // La description est un attribut fixe de la règle, contrairement au message ;
  // elle est tout de même nettoyée et bornée avant d'entrer dans le journal.
  return {
    ruleKey: rule.id,
    label: libelleFixe(rule.description || rule.category?.name || rule.id, LIBELLE_MAX),
  };
}

/** Catégorie fixe d'une détection, validée avant stockage (issue #41). */
function categorieFixe(rule: LTMatch["rule"]): { categoryId: string; categoryName: string } {
  const id = rule.category?.id ?? "";
  // Un identifiant de catégorie non conforme trahit une détection forgée : on
  // n'en garde ni l'identifiant ni le nom (qui pourrait porter du texte libre).
  if (!RE_ID_CATEGORIE.test(id)) return { categoryId: "", categoryName: "" };
  return { categoryId: id, categoryName: libelleFixe(rule.category?.name, CATEGORIE_NOM_MAX) };
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
    const ficheKey = detecterConfusion(hunk.before, hunk.after);
    let faults: Fault[];
    if (ficheKey) {
      faults = [
        {
          ruleKey: ficheKey,
          source: "fiche",
          categoryId: "CONFUSION",
          categoryName: "Confusion de mots",
          issueType: "grammar",
          message: FICHES[ficheKey].titre,
          label: FICHES[ficheKey].titre,
          counted: true,
        },
      ];
    } else {
      faults = overlapping.map((m) => ({
        ...regleDuMoteur(m.rule),
        source: "lt" as const,
        ...categorieFixe(m.rule),
        // Type fixe (« grammar », « typographical »… ) ; validé avant stockage.
        issueType: /^[a-z-]{0,40}$/.test(m.rule.issueType ?? "") ? (m.rule.issueType ?? "") : "",
        message: m.shortMessage || m.message,
        counted: isCounted(m),
      }));
    }
    if (!ficheKey && faults.length === 0 && detecterAccord(hunk.before, hunk.after)) {
      faults = [
        {
          ruleKey: ACCORD_RULE_KEY,
          source: "accord",
          categoryId: "ACCORD",
          categoryName: "Accord",
          issueType: "grammar",
          message: ACCORD_MESSAGE,
          label: ACCORD_MESSAGE,
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
