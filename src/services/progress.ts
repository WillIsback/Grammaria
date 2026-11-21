import type { Progression as ProgressionBase } from "../analysis/progression/calcul";
import {
  type ExportBeta,
  nomFichierExport,
  texteExport,
  validerExport,
} from "../analysis/progression/export";
import type { Mesure } from "../analysis/progression/mesure";
import { apiTauri, messageErreur } from "../desktop/tauri";

/** Réponse de `GET /api/progress` : l'écran, et la mesure « avant / depuis » (issue #33). */
export type Progression = ProgressionBase & { mesure: Mesure };

/** Tout l'écran « Progression » en une seule requête. */
export async function fetchProgress(signal?: AbortSignal): Promise<Progression> {
  const response = await fetch("/api/progress", { signal });
  if (!response.ok) throw new Error(`Progression indisponible: ${response.status}`);
  return response.json();
}

/**
 * Export anonyme de la bêta (`GET /api/progress/export`), revalidé ici : la
 * fenêtre d'export montre exactement ce qui sera écrit, rien d'autre.
 */
export async function fetchExportBeta(signal?: AbortSignal): Promise<ExportBeta> {
  const response = await fetch("/api/progress/export", { signal });
  if (!response.ok) throw new Error(`Export indisponible: ${response.status}`);
  const resultat = validerExport(await response.json());
  if (!resultat.ok) throw new Error(`Export invalide : ${resultat.erreur}`);
  return resultat.export;
}

/** Où le fichier est allé : téléchargé par le navigateur, ou écrit par l'application de bureau. */
export type FichierEnregistre =
  | { type: "telechargement"; nom: string }
  | { type: "bureau"; chemin: string };

/**
 * Enregistre le fichier de l'export. Grammaria n'envoie rien : le fichier
 * reste sur l'ordinateur, l'utilisateur le transmet lui-même.
 *
 * - Navigateur (serveur web) : téléchargement ordinaire (Blob).
 * - Bureau : la commande Rust `export_beta_enregistrer` écrit le fichier dans
 *   le dossier Téléchargements, sous un nom qu'elle fixe elle-même, et
 *   renvoie son chemin. La page n'a aucun autre accès aux fichiers.
 */
export async function enregistrerExport(exp: ExportBeta): Promise<FichierEnregistre> {
  const contenu = texteExport(exp);
  const nom = nomFichierExport(exp.participant);
  const api = apiTauri();
  if (api) {
    try {
      const chemin = await api.invoke<string>("export_beta_enregistrer", { contenu });
      return { type: "bureau", chemin };
    } catch (error) {
      throw new Error(messageErreur(error));
    }
  }
  const url = URL.createObjectURL(new Blob([contenu], { type: "application/json" }));
  try {
    const lien = document.createElement("a");
    lien.href = url;
    lien.download = nom;
    document.body.append(lien);
    lien.click();
    lien.remove();
  } finally {
    // Laisse au navigateur le temps de lancer le téléchargement.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
  return { type: "telechargement", nom };
}
