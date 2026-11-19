/**
 * Messages échangés entre la page (correcteur.ts) et le Worker du correcteur (lt.worker.ts).
 * Types seulement, plus les chemins des fichiers du correcteur dans le build du bureau.
 */

/** Dossier du correcteur dans le build du bureau (`dist/bureau/lt/`). */
export const DOSSIER_LT = "lt/";
/** Script du Worker, relatif à la page. */
export const CHEMIN_WORKER = `${DOSSIER_LT}worker.js`;
/** Archive des ressources, relative au Worker (même dossier). */
export const CHEMIN_ARCHIVE = "./fr.pack";

/** Mesures du chargement, en millisecondes depuis le démarrage du Worker. */
export interface MesuresChargement {
  archiveOctets: number;
  fichiers: number;
  /** Téléchargement de l'archive. */
  archiveMs: number;
  /** Lecture de l'archive et remplissage du magasin de ressources. */
  lectureMs: number;
  /** Chargement des règles (première analyse). */
  reglesMs: number;
  totalMs: number;
}

export type MessageVersWorker =
  | { type: "controle"; id: number; texte: string }
  | { type: "diagnostic" };

export type MessageDuWorker =
  | { type: "pret"; mesures: MesuresChargement }
  | { type: "erreur"; message: string }
  /** `json` : le tableau `matches`, sérialisé comme dans la réponse de POST /api/check. */
  | { type: "resultat"; id: number; json: string }
  | { type: "echec"; id: number; message: string }
  | { type: "diagnostic"; absentes: string[] };
