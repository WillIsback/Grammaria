/**
 * Amorce de l'application de bureau, chargée par src/main.tsx AVANT le rendu de l'interface,
 * seulement dans le build du bureau (`vp build --mode bureau-interface`) : le build web ne
 * l'embarque pas.
 *
 * 1. ouvre le journal (SQLite par les commandes Rust ; schéma créé ou migré) ;
 * 2. installe le pont : les `fetch("/api/…")` et `fetch("/v1/…")` de l'interface sont traités
 *    dans la page par le même gestionnaire que le serveur ;
 * 3. préchauffe le correcteur (Worker) pendant que l'utilisateur tape ;
 * 4. affiche l'interface.
 *
 * Journal impossible à ouvrir : message lisible à la place de l'interface. Correcteur
 * impossible à charger : bandeau, l'interface reste utilisable (analyse des fautes partielle).
 */
import { creerGestionnaire } from "../../api/handler.ts";
import { Journal } from "../../journal.ts";
import { CorrecteurBureau } from "./correcteur.ts";
import { dependancesBureau } from "./dependances.ts";
import { afficherBandeau, afficherErreur } from "./ecran-erreur.ts";
import { creerPiloteTauri } from "./journal.driver.tauri.ts";
import { installerPont } from "./pont.ts";
import { apiTauri, messageErreur } from "./tauri.ts";

export async function amorcer(rendre: () => void): Promise<void> {
  const api = apiTauri();
  if (!api) {
    // Build du bureau ouvert hors de l'application (aperçu dans un navigateur) : sans les
    // commandes Rust, il n'y a ni journal ni modèle.
    afficherErreur(
      "Grammaria doit être lancée depuis l'application de bureau.",
      "Les commandes de l'application (journal, réglages, modèle) sont introuvables dans cette page.",
    );
    return;
  }

  let journal: Journal;
  try {
    journal = await Journal.ouvrir(creerPiloteTauri(api.invoke));
  } catch (error) {
    console.error("[Bureau] Journal impossible à ouvrir :", error);
    afficherErreur(
      "Le journal de Grammaria n'a pas pu être ouvert.",
      `Cause : ${messageErreur(error)}`,
    );
    return;
  }

  const correcteur = new CorrecteurBureau();
  installerPont(creerGestionnaire(dependancesBureau({ api, journal, correcteur })));
  void correcteur.prechauffer().catch((error: unknown) => {
    console.error("[Bureau] Correcteur indisponible :", error);
    afficherBandeau(
      `${messageErreur(error)}. Les corrections restent possibles, mais l'analyse des fautes sera partielle.`,
    );
  });

  rendre();
}
