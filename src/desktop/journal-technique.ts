/**
 * Journal technique de l'application de bureau, côté page : les erreurs de la page et la ligne
 * de fin de correction partent dans `grammaria.log` (src-tauri/src/logs.rs) par l'unique commande
 * `log_page`, dont Rust limite le débit et borne la taille.
 *
 * N'y écrire QUE des messages techniques : jamais le texte de l'utilisateur ni le contenu d'une
 * correction (Rust masque en plus la clé API et tout ce qui ressemble à un secret).
 */
import type { MesureCorrection } from "../../api/deps.ts";
import { type Invoke, messageErreur } from "./tauri.ts";

export type NiveauJournal = "info" | "avertissement" | "erreur";

export interface JournalTechnique {
  /** N'échoue jamais : un journal indisponible ne gêne pas l'interface. */
  ecrire(niveau: NiveauJournal, message: string): void;
}

/** Taille maximale d'un message envoyé (Rust coupe aussi à cette longueur). */
const MESSAGE_MAX = 2_000;
/** Lignes de pile conservées pour une erreur JavaScript. */
const PILE_MAX = 6;

export function creerJournalTechnique(invoke: Invoke): JournalTechnique {
  return {
    ecrire(niveau, message) {
      try {
        invoke("log_page", { niveau, message: message.slice(0, MESSAGE_MAX) }).catch(() => {});
      } catch {
        /* commande absente : rien à faire */
      }
    },
  };
}

/** Message et début de pile d'une erreur, sur une ligne. */
function decrire(erreur: unknown): string {
  const message = messageErreur(erreur);
  const pile = erreur instanceof Error && typeof erreur.stack === "string" ? erreur.stack : "";
  const lignes = pile
    .split("\n")
    .map((ligne) => ligne.trim())
    .filter((ligne) => ligne && !ligne.includes(message))
    .slice(0, PILE_MAX);
  return lignes.length > 0 ? `${message} | ${lignes.join(" | ")}` : message;
}

/**
 * Note dans le journal technique les erreurs JavaScript non interceptées et les rejets de
 * promesse sans traitement. Renvoie la fonction qui retire les écouteurs.
 */
export function installerCaptureErreurs(journal: JournalTechnique, cible: Window = window) {
  const surErreur = (evenement: ErrorEvent) => {
    // Échec de chargement d'une ressource (image…) : pas d'ErrorEvent avec message.
    if (!evenement.message && !evenement.error) return;
    const lieu = evenement.filename
      ? ` (${evenement.filename}:${evenement.lineno}:${evenement.colno})`
      : "";
    journal.ecrire(
      "erreur",
      `Erreur JavaScript non interceptée${lieu} : ${decrire(evenement.error ?? evenement.message)}`,
    );
  };
  const surRejet = (evenement: PromiseRejectionEvent) => {
    journal.ecrire("erreur", `Promesse rejetée sans traitement : ${decrire(evenement.reason)}`);
  };
  cible.addEventListener("error", surErreur);
  cible.addEventListener("unhandledrejection", surRejet);
  return () => {
    cible.removeEventListener("error", surErreur);
    cible.removeEventListener("unhandledrejection", surRejet);
  };
}

/** Ligne de fin de correction, équivalente à celle de l'ancien `server.log`. */
export function ligneFinCorrection(mesure: MesureCorrection): string {
  return (
    `Correction terminée en ${mesure.dureeMs} ms (premier mot après ` +
    `${mesure.premierMotMs ?? "—"} ms, fragments de raisonnement : ${mesure.fragmentsRaisonnement}, ` +
    `raisonnement coupé : ${mesure.raisonnementCoupe ? "oui" : "non"})`
  );
}
