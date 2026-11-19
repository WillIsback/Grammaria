import type { Database } from "bun:sqlite";
import { BADGES, definitionBadge } from "./src/analysis/badges/catalogue.ts";
import {
  evaluerBadges,
  type FaitEvenement,
  type FaitsBadges,
  type FaitTexte,
} from "./src/analysis/badges/evaluation.ts";
import {
  annonce,
  type BadgeAnnonce,
  type CatalogueBadges,
  vueCatalogue,
} from "./src/analysis/badges/vue.ts";
import { SCHEMA_VERSION } from "./journal.rules.ts";

/**
 * Version du schéma qui ajoute les badges, dans `PRAGMA user_version`
 * (1 : cycle de vie des règles, voir `journal.rules.ts`).
 */
export const BADGES_SCHEMA_VERSION = SCHEMA_VERSION;

/**
 * Badges obtenus, dans la base du journal : une ligne par badge avec sa date
 * d'obtention (table `badges`). Toute la logique est dans
 * `src/analysis/badges/` ; cette classe lit les faits du journal et conserve
 * les badges obtenus. Un badge obtenu n'est jamais retiré par un recalcul :
 * seul l'effacement du journal le supprime.
 */
export class BadgeStore {
  constructor(private db: Database) {}

  /**
   * Crée la table `badges` et passe le schéma en version 2. Idempotent. Sur
   * une base existante, les badges déjà mérités sont attribués à leur date
   * réelle, sans notification. Les autres tables ne sont pas modifiées.
   */
  migrate(now: number = Date.now()): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS badges (
        user_id TEXT NOT NULL DEFAULT 'local',
        badge_id TEXT NOT NULL,
        obtained_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, badge_id)
      );
    `);
    const { user_version: version } = this.db.query("PRAGMA user_version").get() as {
      user_version: number;
    };
    if (version >= BADGES_SCHEMA_VERSION) return;
    this.db.transaction(() => {
      // Attribution rétroactive : le résultat (badges nouveaux) n'est pas annoncé.
      this.award(now);
      this.db.exec(`PRAGMA user_version = ${BADGES_SCHEMA_VERSION}`);
    })();
  }

  /** Faits du journal utiles aux badges. */
  facts(): FaitsBadges {
    const textes = this.db
      .query(
        `SELECT created_at AS at, word_count AS mots, fault_count AS fautes
         FROM texts ORDER BY created_at, id`,
      )
      .all() as FaitTexte[];
    const evenements = this.db
      .query(
        `SELECT rule_key AS ruleKey, created_at AS at, type FROM rule_events
         WHERE type IN ('acquise', 'rechute', 'reponse_juste') ORDER BY id`,
      )
      .all() as FaitEvenement[];
    return { textes, evenements };
  }

  /** Badges obtenus, par identifiant, avec leur date d'obtention. */
  obtained(): Map<string, number> {
    const rows = this.db.query("SELECT badge_id AS id, obtained_at AS at FROM badges").all() as {
      id: string;
      at: number;
    }[];
    return new Map(rows.map((r) => [r.id, r.at]));
  }

  /**
   * Réévalue les badges et enregistre ceux dont le critère est désormais
   * rempli. Renvoie les badges nouvellement obtenus, dans l'ordre du catalogue.
   */
  award(now: number = Date.now()): BadgeAnnonce[] {
    return this.db.transaction(() => {
      const deja = this.obtained();
      const insert = this.db.prepare(
        "INSERT OR IGNORE INTO badges (badge_id, obtained_at) VALUES (?, ?)",
      );
      const nouveaux: BadgeAnnonce[] = [];
      for (const etat of evaluerBadges(this.facts(), now)) {
        if (etat.rempliLe === null || deja.has(etat.id)) continue;
        insert.run(etat.id, etat.rempliLe);
        const def = definitionBadge(etat.id);
        if (def) nouveaux.push(annonce(def));
      }
      return nouveaux;
    })();
  }

  /** Catalogue complet : obtenus ou non, date d'obtention et progression. */
  catalogue(now: number = Date.now()): CatalogueBadges {
    return vueCatalogue(evaluerBadges(this.facts(), now), this.obtained(), BADGES);
  }

  purge(): void {
    this.db.exec("DELETE FROM badges;");
  }
}

/**
 * Réévalue les badges après une analyse ou une réponse au choix. Une erreur
 * du calcul des badges ne doit jamais faire échouer la requête : elle est
 * journalisée et aucun badge n'est annoncé.
 */
export function awardBadgesSafely(store: { award(now?: number): BadgeAnnonce[] }, now?: number) {
  try {
    return store.award(now);
  } catch (error) {
    console.error("[Badges] Évaluation impossible :", error);
    return [];
  }
}
