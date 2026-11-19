import type { Database } from "bun:sqlite";
import { definitionBadge } from "./src/analysis/badges/catalogue.ts";
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

/**
 * Badges obtenus, dans la base du journal : une ligne par badge avec sa date
 * d'obtention (table `badges`). Toute la logique est dans
 * `src/analysis/badges/` ; cette classe lit les faits du journal et conserve
 * les badges obtenus. Un badge obtenu n'est jamais retiré par un recalcul :
 * seul l'effacement du journal le supprime.
 */
export class BadgeStore {
  /** `textes` lit la table `texts`, partagée avec l'écran « Progression ». */
  constructor(
    private db: Database,
    private textes: () => LigneTexte[],
  ) {}

  /** Crée la table `badges`. Idempotent. */
  createTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS badges (
        badge_id TEXT NOT NULL PRIMARY KEY,
        obtained_at INTEGER NOT NULL
      );
    `);
  }

  /** Faits du journal utiles aux badges. */
  facts(): FaitsBadges {
    const evenements = this.db
      .query(
        `SELECT rule_key AS ruleKey, created_at AS at, type FROM rule_events
         WHERE type IN ('acquise', 'rechute', 'reponse_juste') ORDER BY id`,
      )
      .all() as FaitEvenement[];
    return { textes: this.textes(), evenements };
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
    return vueCatalogue(evaluerBadges(this.facts(), now), this.obtained());
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
