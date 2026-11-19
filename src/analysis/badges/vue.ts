/**
 * Forme des badges échangée entre le serveur et l'interface
 * (`GET /api/badges`, `nouveauxBadges` de `POST /api/analyze`).
 */
import {
  BADGES,
  type DefinitionBadge,
  FAMILLES_BADGES,
  type FamilleBadge,
  type MesureBadge,
  type UniteBadge,
} from "./catalogue";
import type { EtatBadge } from "./evaluation";

/** Badge tout juste obtenu, à annoncer dans la notification. */
export interface BadgeAnnonce {
  id: string;
  titre: string;
  description: string;
}

/** Un badge du catalogue, obtenu ou non, avec sa progression. */
export interface BadgeVue {
  id: string;
  famille: FamilleBadge;
  titre: string;
  description: string;
  critere: string;
  mesure: MesureBadge;
  unite: UniteBadge;
  obtenu: boolean;
  /** Date d'obtention conservée dans le journal ; null si le badge est à venir. */
  obtenuLe: number | null;
  progression: {
    /** Valeur actuelle de la mesure. */
    valeur: number;
    seuil: number;
    detail?: string;
    /** Part du chemin parcouru (0 à 1) pour un badge à plusieurs conditions. */
    ratio?: number;
  };
}

export interface CatalogueBadges {
  familles: { id: FamilleBadge; titre: string }[];
  badges: BadgeVue[];
  obtenus: number;
  total: number;
}

export function annonce(def: DefinitionBadge): BadgeAnnonce {
  return { id: def.id, titre: def.titre, description: def.description };
}

/**
 * Assemble le catalogue complet : définitions, dates d'obtention conservées
 * (`obtenus`, par identifiant) et progression calculée (`etats`).
 */
export function vueCatalogue(
  etats: EtatBadge[],
  obtenus: ReadonlyMap<string, number>,
  catalogue: readonly DefinitionBadge[] = BADGES,
): CatalogueBadges {
  const parId = new Map(etats.map((e) => [e.id, e]));
  const badges = catalogue.map((def): BadgeVue => {
    const etat = parId.get(def.id);
    const obtenuLe = obtenus.get(def.id) ?? null;
    return {
      id: def.id,
      famille: def.famille,
      titre: def.titre,
      description: def.description,
      critere: def.critere,
      mesure: def.mesure,
      unite: def.unite,
      obtenu: obtenuLe !== null,
      obtenuLe,
      progression: {
        valeur: etat?.valeur ?? 0,
        seuil: def.seuil,
        ...(etat?.detail ? { detail: etat.detail } : {}),
        ...(etat?.ratio !== undefined ? { ratio: etat.ratio } : {}),
      },
    };
  });
  return {
    familles: FAMILLES_BADGES.map((f) => ({ id: f.id, titre: f.titre })),
    badges,
    obtenus: badges.filter((b) => b.obtenu).length,
    total: badges.length,
  };
}
