import { useState } from "react";
import type { AppUpdate } from "../hooks/useAppUpdate";
import { messagePhase } from "../services/appUpdate";

interface Props {
  /** null dans un navigateur : rien n'est affiché. */
  update: AppUpdate | null;
}

const primaryButton =
  "px-3 py-1.5 rounded-lg text-sm font-semibold bg-brand-600 hover:bg-brand-700 text-white transition-colors";
const quietButton =
  "px-3 py-1.5 rounded-lg text-sm font-medium text-brand-700 dark:text-brand-300 " +
  "hover:bg-brand-100/70 dark:hover:bg-brand-500/20 transition-colors";

/**
 * Bandeau sous l'en-tête : propose la nouvelle version trouvée au démarrage,
 * puis suit le téléchargement. L'utilisateur décide : « Plus tard » le ferme
 * jusqu'au prochain lancement.
 */
export function UpdateBanner({ update }: Props) {
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  if (!update) return null;

  const { status, userInitiated, check, install, openReleasePage } = update;
  const { phase, mode, version } = status;
  // Téléchargement ou installation en cours : l'application avance seule, sans bouton.
  const enCours = messagePhase(status, "Téléchargement de la mise à jour…");
  const busy = enCours !== null;
  const dismissed = version === null || version === dismissedVersion;
  const offered = phase === "available" && !dismissed;
  // Échec d'une étape demandée par l'utilisateur ; une recherche automatique
  // qui échoue (hors ligne) ne dérange personne. « Réessayer » relance l'étape
  // en échec : une recherche ratée ne lance jamais une installation.
  const failed =
    phase === "error" &&
    userInitiated &&
    !dismissed &&
    (status.failedStep === "check" || mode === "auto");
  const retry = status.failedStep === "check" ? check : install;
  if (!busy && !offered && !failed) return null;

  return (
    <div
      role="status"
      className="bg-brand-50/90 dark:bg-brand-500/10 border-b border-brand-200/70 dark:border-brand-500/20"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 max-w-5xl mx-auto px-5 py-2.5">
        <p className="text-sm text-brand-900 dark:text-brand-100 min-w-0">
          {offered && `Grammaria ${version} est disponible.`}
          {enCours}
          {failed && status.error}
        </p>
        {!busy && (
          <div className="flex items-center gap-1 shrink-0">
            {failed ? (
              <button type="button" onClick={retry} className={primaryButton}>
                Réessayer
              </button>
            ) : mode === "auto" ? (
              <button type="button" onClick={install} className={primaryButton}>
                Installer et redémarrer
              </button>
            ) : (
              <button type="button" onClick={openReleasePage} className={primaryButton}>
                Ouvrir la page de téléchargement
              </button>
            )}
            <button
              type="button"
              onClick={() => setDismissedVersion(version)}
              className={quietButton}
            >
              Plus tard
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
