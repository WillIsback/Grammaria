import type { JournalDriver, Query, Statement } from "./journal.driver.ts";
import { BADGES, type DefinitionBadge, definitionBadge } from "./src/analysis/badges/catalogue.ts";
import {
  evaluerBadges,
  type FaitEvenement,
  type FaitsBadges,
} from "./src/analysis/badges/evaluation.ts";
import {
  annonce,
  type BadgeAnnonce,
  type CatalogueBadges,
  vueCatalogue,
} from "./src/analysis/badges/vue.ts";
import type { LigneTexte } from "./src/analysis/progression/calcul.ts";

/** Table `badges`, une instruction par entrée. Idempotent. */
export const SCHEMA_BADGES: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS badges (
    badge_id TEXT NOT NULL PRIMARY KEY,
    obtained_at INTEGER NOT NULL
  )`,
];

export const PURGE_BADGES: readonly Statement[] = [{ sql: "DELETE FROM badges" }];

const TYPES_FAITS = ["acquise", "rechute", "reponse_juste"] as const;
const SQL_TYPES_FAITS = `type IN (${TYPES_FAITS.map((t) => `'${t}'`).join(", ")})`;

const SELECT_TEXTES =
  "SELECT created_at AS at, word_count AS words, fault_count AS faults FROM texts";
const SELECT_EVENEMENTS = "SELECT rule_key AS ruleKey, created_at AS at, type FROM rule_events";

/** Tous les textes corrigés, du plus ancien au plus récent (badges et « Progression »). */
export const REQUETE_TEXTES: Query = { sql: `${SELECT_TEXTES} ORDER BY created_at, id` };
/** Événements de l'historique des règles utiles aux badges, dans l'ordre d'écriture. */
export const REQUETE_EVENEMENTS: Query = {
  sql: `${SELECT_EVENEMENTS} WHERE ${SQL_TYPES_FAITS} ORDER BY id`,
};
const REQUETE_OBTENUS: Query = { sql: "SELECT badge_id AS id, obtained_at AS at FROM badges" };
/** Date du fait le plus récent du journal (texte ou événement utile aux badges). */
const REQUETE_DERNIER_FAIT: Query = {
  sql: `SELECT MAX(COALESCE((SELECT MAX(created_at) FROM texts), 0),
                   COALESCE((SELECT MAX(created_at) FROM rule_events WHERE ${SQL_TYPES_FAITS}), 0)) AS at`,
};

/** Faits lus de la base, badges obtenus et date du fait le plus récent. */
export interface InstantaneBadges {
  faits: FaitsBadges;
  obtenus: Map<string, number>;
  dernierFait: number;
}

/** Faits complets, pour le catalogue : chaque badge y montre sa progression. */
const REQUETES_CATALOGUE: readonly Query[] = [
  REQUETE_TEXTES,
  REQUETE_EVENEMENTS,
  REQUETE_OBTENUS,
  REQUETE_DERNIER_FAIT,
];

const MESURES_EVENEMENTS = new Set<string>([
  "reglesAcquises",
  "homophonesAcquis",
  "rechutesSurmontees",
  "reponsesJustes",
]);

/**
 * `SELECT … WHERE condition ORDER BY …`, qui ne renvoie des lignes que si l'un
 * des badges `definitions` n'est pas encore obtenu.
 */
function siUnBadgeAVenir(
  select: string,
  condition: string,
  orderBy: string,
  definitions: DefinitionBadge[],
): Query {
  const ids = definitions.map((d) => d.id);
  return {
    sql: `${select} WHERE ${condition}
          AND (SELECT COUNT(*) FROM badges WHERE badge_id IN (${ids.map(() => "?").join(", ")})) < ${ids.length}
          ORDER BY ${orderBy}`,
    params: ids,
  };
}

/**
 * Lectures pour attribuer les badges (lots de `record`, `award`, migration),
 * dans l'ordre de `lireFaits`. Un badge obtenu n'est plus évalué : les textes
 * ne sont lus que s'il reste un badge à venir qui en dépend, de même pour les
 * événements.
 */
export const REQUETES_BADGES: readonly Query[] = [
  siUnBadgeAVenir(
    SELECT_TEXTES,
    "1",
    "created_at, id",
    BADGES.filter((b) => !MESURES_EVENEMENTS.has(b.mesure)),
  ),
  siUnBadgeAVenir(
    SELECT_EVENEMENTS,
    SQL_TYPES_FAITS,
    "id",
    BADGES.filter((b) => MESURES_EVENEMENTS.has(b.mesure)),
  ),
  REQUETE_OBTENUS,
  REQUETE_DERNIER_FAIT,
];

export function lireFaits(lignes: unknown[][]): InstantaneBadges {
  const [textes, evenements, obtenus, [dernier]] = lignes as [
    LigneTexte[],
    FaitEvenement[],
    { id: string; at: number }[],
    { at: number }[],
  ];
  return {
    faits: { textes, evenements },
    obtenus: new Map(obtenus.map((r) => [r.id, r.at])),
    dernierFait: dernier?.at ?? 0,
  };
}

/**
 * Faits du journal augmentés des changements en attente d'un texte : le texte
 * (rangé comme `ORDER BY created_at, id`, son id étant le plus grand) et les
 * événements en attente, dans l'ordre d'écriture.
 */
export function avecEnAttente(
  faits: FaitsBadges,
  texte: LigneTexte | null,
  evenements: readonly { ruleKey: string; at: number; type: string }[],
): FaitsBadges {
  const textes = [...faits.textes];
  if (texte) {
    let i = textes.length;
    while (i > 0 && textes[i - 1].at > texte.at) i--;
    textes.splice(i, 0, texte);
  }
  const types = new Set<string>(TYPES_FAITS);
  const nouveaux = evenements
    .filter((e) => types.has(e.type))
    .map((e) => ({ ruleKey: e.ruleKey, at: e.at, type: e.type }) as FaitEvenement);
  return { textes, evenements: [...faits.evenements, ...nouveaux] };
}

/**
 * Badges dont le critère est rempli à `now` et qui ne sont pas encore
 * obtenus : calcul pur. Renvoie leur annonce, dans l'ordre du catalogue, et
 * les instructions qui les enregistrent à la date où le critère a été rempli.
 * Seuls les badges à venir sont évalués : l'état d'un badge ne dépend que des
 * faits, et un badge obtenu n'est jamais retiré.
 */
export function nouveauxBadges(
  faits: FaitsBadges,
  obtenus: ReadonlyMap<string, number>,
  now: number,
): { annonces: BadgeAnnonce[]; statements: Statement[] } {
  const annonces: BadgeAnnonce[] = [];
  const statements: Statement[] = [];
  const aVenir = BADGES.filter((b) => !obtenus.has(b.id));
  for (const etat of evaluerBadges(faits, now, aVenir)) {
    if (etat.rempliLe === null) continue;
    statements.push({
      sql: "INSERT OR IGNORE INTO badges (badge_id, obtained_at) VALUES (?, ?)",
      params: [etat.id, etat.rempliLe],
    });
    const def = definitionBadge(etat.id);
    if (def) annonces.push(annonce(def));
  }
  return { annonces, statements };
}

const RANG = new Map(BADGES.map((b, i) => [b.id, i]));

/**
 * Badges obtenus, dans la base du journal : une ligne par badge avec sa date
 * d'obtention (table `badges`). Toute la logique est dans
 * `src/analysis/badges/` ; cette classe lit les faits par le pilote et
 * conserve les badges obtenus. Un badge obtenu n'est jamais retiré par un
 * recalcul : seul l'effacement du journal le supprime.
 *
 * `Journal.record` évalue et enregistre lui-même, dans son lot, les badges
 * obtenus avec le texte : ils sont retenus ici et annoncés par l'appel
 * suivant à `award`.
 */
export class BadgeStore {
  private enAttente: BadgeAnnonce[] = [];
  /**
   * Dernière évaluation complète par ce journal, quand aucun fait n'était
   * daté après elle et que rien n'a été écrit depuis : une évaluation à une
   * heure postérieure donnerait exactement les mêmes badges.
   */
  private evalueA: number | null = null;

  /** `serie` exécute les écritures du journal l'une après l'autre. */
  constructor(
    private driver: JournalDriver,
    private serie: <T>(operation: () => Promise<T>) => Promise<T>,
  ) {}

  /** Faits du journal utiles aux badges. */
  async facts(): Promise<FaitsBadges> {
    const lignes = await this.driver.readMany([REQUETE_TEXTES, REQUETE_EVENEMENTS]);
    return { textes: lignes[0] as LigneTexte[], evenements: lignes[1] as FaitEvenement[] };
  }

  /** Badges obtenus, par identifiant, avec leur date d'obtention. */
  async obtained(): Promise<Map<string, number>> {
    const rows = await this.driver.read<{ id: string; at: number }>(REQUETE_OBTENUS.sql);
    return new Map(rows.map((r) => [r.id, r.at]));
  }

  /**
   * Après un lot de `Journal.record` évalué à `now` : retient les badges
   * qu'il a enregistrés, à annoncer au prochain `award`. `dernierFait` est la
   * date du fait le plus récent, texte du lot compris.
   */
  retenir(annonces: readonly BadgeAnnonce[], now: number, dernierFait: number): void {
    this.enAttente.push(...annonces);
    this.evalueA = dernierFait <= now ? now : null;
  }

  /** Une écriture a changé les faits : la prochaine évaluation relit la base. */
  invalider(): void {
    this.evalueA = null;
  }

  /** Oublie les annonces retenues (effacement du journal). */
  oublier(): void {
    this.enAttente = [];
    this.evalueA = null;
  }

  /**
   * Réévalue les badges et enregistre ceux dont le critère est désormais
   * rempli. Renvoie les badges nouvellement obtenus (y compris ceux que
   * `Journal.record` vient d'enregistrer), dans l'ordre du catalogue.
   */
  award(now: number = Date.now()): Promise<BadgeAnnonce[]> {
    return this.serie(async () => {
      let annonces: BadgeAnnonce[] = [];
      // Rien n'a changé depuis la dernière évaluation et aucun fait n'est daté
      // après elle : réévaluer plus tard ne donnerait aucun badge de plus.
      if (this.evalueA === null || now < this.evalueA) {
        const { faits, obtenus, dernierFait } = lireFaits(
          await this.driver.readMany(REQUETES_BADGES),
        );
        const nouveaux = nouveauxBadges(faits, obtenus, now);
        if (nouveaux.statements.length) await this.driver.batch(nouveaux.statements);
        annonces = nouveaux.annonces;
        this.evalueA = dernierFait <= now ? now : null;
      }
      const vus = new Set<string>();
      const toutes = [...this.enAttente, ...annonces].filter(
        (a) => !vus.has(a.id) && vus.add(a.id),
      );
      this.enAttente = [];
      return toutes.sort((a, b) => (RANG.get(a.id) ?? 0) - (RANG.get(b.id) ?? 0));
    });
  }

  /** Catalogue complet : obtenus ou non, date d'obtention et progression. */
  async catalogue(now: number = Date.now()): Promise<CatalogueBadges> {
    const { faits, obtenus } = lireFaits(await this.driver.readMany(REQUETES_CATALOGUE));
    return vueCatalogue(evaluerBadges(faits, now), obtenus);
  }
}

/**
 * Réévalue les badges après une analyse ou une réponse au choix. Une erreur
 * du calcul des badges ne doit jamais faire échouer la requête : elle est
 * journalisée et aucun badge n'est annoncé.
 */
export async function awardBadgesSafely(
  store: { award(now?: number): BadgeAnnonce[] | Promise<BadgeAnnonce[]> },
  now?: number,
): Promise<BadgeAnnonce[]> {
  try {
    return await store.award(now);
  } catch (error) {
    console.error("[Badges] Évaluation impossible :", error);
    return [];
  }
}
