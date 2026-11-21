/**
 * Export anonyme de la bêta : format `grammaria-beta`, version 1 (issue #34).
 *
 * Un seul module pour le format : ses types, sa construction (pure, à partir
 * des mêmes lignes du journal que la mesure « avant / depuis ») et sa
 * validation stricte. La validation sert deux fois : à l'export (on vérifie
 * ce qu'on écrit) et à la collecte (`scripts/beta/agreger.ts`).
 *
 * Ce que contient un export, et rien d'autre : des nombres, des booléens et
 * des identifiants dont la forme est contrôlée (identifiant de règle, de
 * catégorie, état du cycle, version de l'application, identifiant aléatoire
 * du participant). Aucun texte, aucun libellé de règle (les libellés se
 * retrouvent à partir des identifiants), aucune date ni heure absolue : le
 * temps est compté en semaines depuis le premier texte corrigé (blocs de
 * 7 × 24 heures, sans calendrier ni fuseau).
 */
import { FICHES } from "../fiches";
import { ETATS_CYCLE, type EtatCycle } from "../regles/cycle";
import { SEUILS } from "../regles/seuils";
import { calculerMesure, type EntreeMesure, type MesureRegle, type SyntheseGroupe } from "./mesure";
import { MESURE } from "./reglages";

export const FORMAT_EXPORT = "grammaria-beta";
export const VERSION_EXPORT = 1;

/** Durée d'une semaine relative : 7 × 24 heures, sans calendrier ni fuseau. */
export const SEMAINE_MS = 7 * 24 * 60 * 60 * 1000;

/** Bornes de taille : au-delà, l'export est refusé. */
export const LIMITES_EXPORT = {
  /** Semaines relatives, au plus (10 ans). */
  semaines: 520,
  /** Règles, au plus. */
  regles: 1000,
  /** Plus grand nombre accepté (compteurs, mots). */
  nombre: 1_000_000_000,
  /** Taille du fichier, en octets (le JSON indenté). */
  octets: 2_000_000,
} as const;

export type Plateforme = "bureau" | "serveur";

/** Volume d'une période : textes, mots, fautes comptées. */
export interface VolumeExport {
  textes: number;
  mots: number;
  fautes: number;
}

export interface SemaineExport extends VolumeExport {
  /** Semaine relative : 0 pour la semaine du premier texte corrigé. */
  semaine: number;
}

export interface RegleExport {
  /** Identifiant de la règle (forme contrôlée, voir `estIdentifiantRegle`). */
  regle: string;
  /** Identifiant de catégorie du moteur (majuscules, chiffres, _), éventuellement vide. */
  categorie: string;
  groupe: "suivie" | "comparaison";
  /** État dans le cycle ; null hors cycle (groupe de comparaison). */
  etat: EtatCycle | null;
  /** Semaine relative de la première intervention, ou du critère de signalement. */
  semainePivot: number;
  avant: VolumeExport;
  depuis: VolumeExport;
  /** Les deux périodes atteignent le volume minimal (`mesure` des seuils). */
  suffisant: boolean;
  astuces: number;
  choix: number;
  reponsesJustes: number;
  reponsesFausses: number;
  rechutes: number;
  /** Semaine relative de la première acquisition ; null si jamais acquise. */
  semaineAcquisition: number | null;
}

export interface SyntheseExport {
  regles: number;
  reglesSuffisantes: number;
  /** Sommes sur les règles suffisantes (un même texte compte pour chaque règle). */
  avant: VolumeExport;
  depuis: VolumeExport;
}

export interface ExportBeta {
  format: typeof FORMAT_EXPORT;
  version: typeof VERSION_EXPORT;
  /** Version de Grammaria (x.y.z). */
  application: string;
  plateforme: Plateforme;
  /** Identifiant aléatoire de 128 bits, en hexadécimal ; ne dérive d'aucune donnée. */
  participant: string;
  /** Seuils du cycle et réglages de la mesure en vigueur. */
  seuils: {
    cycle: Record<keyof typeof SEUILS, number>;
    mesure: Record<keyof typeof MESURE, number>;
  };
  semaines: SemaineExport[];
  regles: RegleExport[];
  synthese: {
    suivies: SyntheseExport;
    comparaison: SyntheseExport;
    choix: { justes: number; fausses: number };
    acquises: { total: number; restees: number; rechutes: number };
  };
}

// ───────────────────────── Formes autorisées ─────────────────────────

const RE_PARTICIPANT = /^[0-9a-f]{32}$/;
const RE_APPLICATION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(-[0-9A-Za-z.]{1,20})?$/;
/** Règles du moteur : majuscules, chiffres et _ (aucun mot du texte, voir #32). */
const RE_REGLE_MOTEUR = /^[A-Z0-9_]{1,80}$/;
const RE_CATEGORIE = /^[A-Z0-9_]{0,64}$/;

/**
 * Vrai pour un identifiant de règle exportable : une règle du moteur
 * (`[A-Z0-9_]+`) ou l'une des fiches maison, prises dans leur liste fermée
 * (`PAIRE:a/à`, `TERMINAISON:er/é`… : leur forme admet des lettres
 * accentuées et une apostrophe, donc pas d'expression régulière ouverte).
 */
export function estIdentifiantRegle(id: string): boolean {
  return RE_REGLE_MOTEUR.test(id) || Object.hasOwn(FICHES, id);
}

/** Nouvel identifiant de participant : 128 bits aléatoires, en hexadécimal. */
export function nouveauParticipant(): string {
  const octets = new Uint8Array(16);
  crypto.getRandomValues(octets);
  return Array.from(octets, (o) => o.toString(16).padStart(2, "0")).join("");
}

/** Nom du fichier d'un export : `grammaria-beta-<8 premiers caractères du participant>.json`. */
export function nomFichierExport(participant: string): string {
  return `grammaria-beta-${participant.slice(0, 8)}.json`;
}

/** Contenu exact du fichier : le JSON indenté. */
export function texteExport(exp: ExportBeta): string {
  return `${JSON.stringify(exp, null, 2)}\n`;
}

// ───────────────────────── Construction ─────────────────────────

export interface EntreeExport {
  application: string;
  plateforme: Plateforme;
  participant: string;
  /** Lignes du journal (voir `EntreeMesure`). */
  journal: EntreeMesure;
  /** Heure de l'export : fixe le nombre de semaines d'usage. */
  now: number;
}

const volume = (p: VolumeExport): VolumeExport => ({
  textes: p.textes,
  mots: p.mots,
  fautes: p.fautes,
});

function syntheseExport(s: SyntheseGroupe): SyntheseExport {
  return {
    regles: s.regles,
    reglesSuffisantes: s.reglesSuffisantes,
    avant: volume(s.avant),
    depuis: volume(s.depuis),
  };
}

/**
 * Construit l'export. Les règles dont l'identifiant n'a pas une forme
 * autorisée (règle inconnue transmise par une interface modifiée, par
 * exemple) sont laissées de côté ; leurs fautes restent comptées dans les
 * semaines, qui ne portent que des nombres.
 */
export function construireExport(entree: EntreeExport): ExportBeta {
  const { journal, now } = entree;
  const mesure = calculerMesure(journal);
  const premier = mesure.premierTexte;
  const semaine = (at: number) =>
    premier === null ? 0 : Math.max(0, Math.floor((at - premier) / SEMAINE_MS));

  const semaines: SemaineExport[] = [];
  if (premier !== null) {
    const derniere = Math.max(semaine(now), ...journal.texts.map((t) => semaine(t.at)));
    for (let s = 0; s <= Math.min(derniere, LIMITES_EXPORT.semaines - 1); s++) {
      semaines.push({ semaine: s, textes: 0, mots: 0, fautes: 0 });
    }
    for (const t of journal.texts) {
      const s = semaines[semaine(t.at)];
      if (s) {
        s.textes++;
        s.mots += t.words;
      }
    }
    for (const f of journal.faults) {
      const s = semaines[semaine(f.at)];
      if (s) s.fautes++;
    }
  }

  // Une date d'événement au-delà de la dernière semaine (horloge déréglée) y est ramenée.
  const borner = (s: number) => Math.min(s, Math.max(0, semaines.length - 1));
  const regle = (r: MesureRegle): RegleExport => ({
    regle: r.ruleKey,
    categorie: RE_CATEGORIE.test(r.categoryId) ? r.categoryId : "",
    groupe: r.groupe,
    etat: r.etat,
    semainePivot: borner(semaine(r.pivot)),
    avant: volume(r.avant),
    depuis: volume(r.depuis),
    suffisant: r.suffisant,
    astuces: r.astuces,
    choix: r.choix,
    reponsesJustes: r.reponsesJustes,
    reponsesFausses: r.reponsesFausses,
    rechutes: r.rechutes,
    semaineAcquisition: r.acquiseLe === null ? null : borner(semaine(r.acquiseLe)),
  });

  return {
    format: FORMAT_EXPORT,
    version: VERSION_EXPORT,
    application: entree.application,
    plateforme: entree.plateforme,
    participant: entree.participant,
    seuils: { cycle: { ...SEUILS }, mesure: { ...MESURE } },
    semaines,
    regles: [...mesure.suivies, ...mesure.comparaison]
      .filter((r) => estIdentifiantRegle(r.ruleKey))
      // Une règle suivie sans état enregistré (journal incohérent) n'est pas exportée.
      .filter((r) => (r.groupe === "comparaison") === (r.etat === null))
      .slice(0, LIMITES_EXPORT.regles)
      .map(regle),
    synthese: {
      suivies: syntheseExport(mesure.synthese.suivies),
      comparaison: syntheseExport(mesure.synthese.comparaison),
      choix: { justes: mesure.choix.justes, fausses: mesure.choix.fausses },
      acquises: { ...mesure.acquises },
    },
  };
}

// ───────────────────────── Validation stricte ─────────────────────────

/** Description d'une valeur attendue. */
type Schema =
  | { type: "entier" }
  | { type: "exact"; valeur: number }
  | { type: "booleen" }
  | { type: "chaine"; forme: (s: string) => boolean }
  | { type: "ou-nul"; schema: Schema }
  | { type: "objet"; champs: Record<string, Schema> }
  | { type: "liste"; element: Schema; max: number };

const entier: Schema = { type: "entier" };
const booleen: Schema = { type: "booleen" };
const chaine = (forme: (s: string) => boolean): Schema => ({ type: "chaine", forme });
const parmi = (valeurs: readonly string[]) => chaine((s) => valeurs.includes(s));
const objet = (champs: Record<string, Schema>): Schema => ({ type: "objet", champs });
const entiers = (cles: readonly string[]) =>
  objet(Object.fromEntries(cles.map((cle) => [cle, entier])));

const VOLUME = entiers(["textes", "mots", "fautes"]);
const SYNTHESE = objet({
  regles: entier,
  reglesSuffisantes: entier,
  avant: VOLUME,
  depuis: VOLUME,
});

const SCHEMA_EXPORT: Schema = objet({
  format: parmi([FORMAT_EXPORT]),
  version: { type: "exact", valeur: VERSION_EXPORT },
  application: chaine((s) => RE_APPLICATION.test(s)),
  plateforme: parmi(["bureau", "serveur"]),
  participant: chaine((s) => RE_PARTICIPANT.test(s)),
  seuils: objet({ cycle: entiers(Object.keys(SEUILS)), mesure: entiers(Object.keys(MESURE)) }),
  semaines: {
    type: "liste",
    max: LIMITES_EXPORT.semaines,
    element: entiers(["semaine", "textes", "mots", "fautes"]),
  },
  regles: {
    type: "liste",
    max: LIMITES_EXPORT.regles,
    element: objet({
      regle: chaine(estIdentifiantRegle),
      categorie: chaine((s) => RE_CATEGORIE.test(s)),
      groupe: parmi(["suivie", "comparaison"]),
      etat: { type: "ou-nul", schema: parmi(ETATS_CYCLE) },
      semainePivot: entier,
      avant: VOLUME,
      depuis: VOLUME,
      suffisant: booleen,
      astuces: entier,
      choix: entier,
      reponsesJustes: entier,
      reponsesFausses: entier,
      rechutes: entier,
      semaineAcquisition: { type: "ou-nul", schema: entier },
    }),
  },
  synthese: objet({
    suivies: SYNTHESE,
    comparaison: SYNTHESE,
    choix: entiers(["justes", "fausses"]),
    acquises: entiers(["total", "restees", "rechutes"]),
  }),
});

/**
 * Vérifie `valeur` contre `schema`. Les messages ne citent que des noms de
 * champs connus et des positions : jamais le contenu refusé, qui peut être
 * n'importe quoi.
 */
function verifier(valeur: unknown, schema: Schema, chemin: string): string | null {
  switch (schema.type) {
    case "entier":
      return typeof valeur === "number" &&
        Number.isSafeInteger(valeur) &&
        valeur >= 0 &&
        valeur <= LIMITES_EXPORT.nombre
        ? null
        : `${chemin} : nombre entier positif attendu`;
    case "exact":
      return valeur === schema.valeur ? null : `${chemin} : valeur non prise en charge`;
    case "booleen":
      return typeof valeur === "boolean" ? null : `${chemin} : booléen attendu`;
    case "chaine":
      return typeof valeur === "string" && valeur.length <= 100 && schema.forme(valeur)
        ? null
        : `${chemin} : valeur non autorisée`;
    case "ou-nul":
      return valeur === null ? null : verifier(valeur, schema.schema, chemin);
    case "liste": {
      if (!Array.isArray(valeur)) return `${chemin} : liste attendue`;
      if (valeur.length > schema.max) return `${chemin} : trop d'éléments`;
      for (let i = 0; i < valeur.length; i++) {
        const erreur = verifier(valeur[i], schema.element, `${chemin}[${i}]`);
        if (erreur) return erreur;
      }
      return null;
    }
    case "objet": {
      if (typeof valeur !== "object" || valeur === null || Array.isArray(valeur)) {
        return `${chemin} : objet attendu`;
      }
      if (Object.getPrototypeOf(valeur) !== Object.prototype) return `${chemin} : objet attendu`;
      const cles = Object.keys(valeur);
      if (cles.some((cle) => !Object.hasOwn(schema.champs, cle))) {
        return `${chemin} : champ inconnu`;
      }
      for (const [cle, sous] of Object.entries(schema.champs)) {
        if (!Object.hasOwn(valeur, cle)) return `${chemin}.${cle} : champ manquant`;
        const erreur = verifier((valeur as Record<string, unknown>)[cle], sous, `${chemin}.${cle}`);
        if (erreur) return erreur;
      }
      return null;
    }
  }
}

export type ResultatValidation = { ok: true; export: ExportBeta } | { ok: false; erreur: string };

/**
 * Validation stricte d'un export : tout champ inconnu, tout type inattendu,
 * toute chaîne hors des formes autorisées, tout nombre non entier, négatif ou
 * démesuré, et toute liste trop longue sont refusés. Quelques cohérences
 * simples sont vérifiées aussi (semaines dans l'ordre, pas de semaine au-delà
 * de la dernière). Le message d'erreur ne cite jamais le contenu refusé.
 */
export function validerExport(valeur: unknown): ResultatValidation {
  const erreur = verifier(valeur, SCHEMA_EXPORT, "export");
  if (erreur) return { ok: false, erreur };
  const exp = valeur as ExportBeta;
  const n = exp.semaines.length;
  if (exp.semaines.some((s, i) => s.semaine !== i)) {
    return { ok: false, erreur: "export.semaines : semaines manquantes ou dans le désordre" };
  }
  for (const [i, r] of exp.regles.entries()) {
    if (r.semainePivot >= Math.max(n, 1) || (r.semaineAcquisition ?? 0) >= Math.max(n, 1)) {
      return { ok: false, erreur: `export.regles[${i}] : semaine au-delà de la dernière` };
    }
    if ((r.groupe === "comparaison") !== (r.etat === null)) {
      return { ok: false, erreur: `export.regles[${i}] : état incohérent avec le groupe` };
    }
  }
  return { ok: true, export: exp };
}

/**
 * Valide le texte d'un fichier d'export : taille bornée, JSON lisible, puis
 * `validerExport`.
 */
export function validerTexteExport(texte: string): ResultatValidation {
  if (texte.length > LIMITES_EXPORT.octets) return { ok: false, erreur: "fichier trop gros" };
  let valeur: unknown;
  try {
    valeur = JSON.parse(texte);
  } catch {
    return { ok: false, erreur: "JSON illisible" };
  }
  return validerExport(valeur);
}
