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
 * Dès le début, les erreurs de la page vont au journal technique `grammaria.log`
 * (journal-technique.ts), avec le chargement du correcteur et la fin de chaque correction.
 *
 * Journal impossible à ouvrir : message lisible à la place de l'interface. Correcteur
 * impossible à charger : bandeau, l'interface reste utilisable (analyse des fautes partielle).
 *
 * Autotest (variable GRAMMARIA_AUTOTEST_OUT, voir src-tauri/src/autotest.rs) : la page
 * d'autotest (autotest.ts, chunk à part) est chargée et exécutée après le rendu.
 */
import { creerGestionnaire } from "../../api/handler.ts";
import { Journal, JournalFuturError } from "../../journal.ts";
import { CorrecteurBureau } from "./correcteur.ts";
import { dependancesBureau } from "./dependances.ts";
import { afficherBandeau, afficherErreur } from "./ecran-erreur.ts";
import {
  creerJournalTechnique,
  installerCaptureErreurs,
  ligneFinCorrection,
} from "./journal-technique.ts";
import { creerPiloteTauri } from "./journal.driver.tauri.ts";
import { installerPont } from "./pont.ts";
import { apiTauri, messageErreur } from "./tauri.ts";

declare global {
  interface Window {
    /** Posé par l'application (script d'initialisation) seulement en mode autotest. */
    __GRAMMARIA_AUTOTEST__?: boolean;
  }
}

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

  // Journal technique (grammaria.log) : erreurs de la page, correcteur, fin des corrections.
  const journalTechnique = creerJournalTechnique(api.invoke);
  installerCaptureErreurs(journalTechnique);

  let journal: Journal;
  try {
    journal = await Journal.ouvrir(creerPiloteTauri(api.invoke));
  } catch (error) {
    console.error("[Bureau] Journal impossible à ouvrir :", error);
    journalTechnique.ecrire(
      "erreur",
      `Journal des fautes impossible à ouvrir : ${messageErreur(error)}`,
    );
    if (error instanceof JournalFuturError) {
      // Relancer n'y changerait rien : seule une version plus récente peut l'ouvrir. Le détail
      // (numéros de schéma) est déjà dans le journal technique.
      afficherErreur(
        "Ce journal a été créé par une version plus récente de Grammaria.",
        "Installez la dernière version de Grammaria pour l'ouvrir. Votre journal n'a pas été modifié.",
        document,
        {
          aide: null,
          libelle: "Ouvrir la page de téléchargement",
          surClic: () => api.invoke("update_open_release_page"),
          siEchec:
            "La page n'a pas pu s'ouvrir. Rendez-vous sur github.com/WillIsback/Grammaria/releases pour télécharger la dernière version.",
        },
      );
      return;
    }
    afficherErreur(
      "Le journal de Grammaria n'a pas pu être ouvert.",
      `Cause : ${messageErreur(error)}`,
    );
    return;
  }

  const correcteur = new CorrecteurBureau();
  const pont = installerPont(
    creerGestionnaire(
      dependancesBureau({
        api,
        journal,
        correcteur: {
          // Un contrôle en échec est noté (message technique seulement, jamais le texte).
          check: (texte) =>
            correcteur.check(texte).catch((error: unknown) => {
              journalTechnique.ecrire(
                "erreur",
                `Contrôle de grammaire impossible : ${messageErreur(error)}`,
              );
              throw error;
            }),
        },
        surFinCorrection: (mesure) => journalTechnique.ecrire("info", ligneFinCorrection(mesure)),
      }),
    ),
  );
  const debut = performance.now();
  const prechauffage = correcteur.prechauffer().then(
    () => {
      const duree = Math.round(performance.now() - debut);
      journalTechnique.ecrire("info", `Correcteur prêt (règles chargées en ${duree} ms).`);
    },
    (error: unknown) => {
      console.error("[Bureau] Correcteur indisponible :", error);
      journalTechnique.ecrire(
        "erreur",
        `Correcteur impossible à charger : ${messageErreur(error)}`,
      );
      afficherBandeau(
        `${messageErreur(error)}. Les corrections restent possibles, mais l'analyse des fautes sera partielle.`,
      );
    },
  );

  rendre();

  if (window.__GRAMMARIA_AUTOTEST__ === true) {
    const { lancerAutotest } = await import("./autotest.ts");
    await lancerAutotest({ api, correcteur, pont, prechauffage });
  }
}
