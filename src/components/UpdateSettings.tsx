import type { AppUpdate } from "../hooks/useAppUpdate";
import { isBusy, messagePhase } from "../services/appUpdate";
import { sectionTitle } from "./Sidebar";

interface Props {
  update: AppUpdate;
}

const primaryButton =
  "px-3 py-2 rounded-xl text-sm font-semibold bg-brand-600 hover:bg-brand-700 text-white " +
  "disabled:opacity-60 transition-colors";
const secondaryButton =
  "px-3 py-2 rounded-xl text-sm font-medium border border-gray-200/80 dark:border-gray-700/80 " +
  "text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800/60 " +
  "disabled:opacity-60 transition-colors";
const note = "text-xs leading-relaxed text-gray-500 dark:text-gray-400";

/**
 * Rubrique « Mises à jour » du menu Paramètres (application de bureau) :
 * version installée, recherche à la demande, installation sur accord.
 */
export function UpdateSettings({ update }: Props) {
  const { status, check, install, openReleasePage } = update;
  const { mode, phase } = status;
  const working = isBusy(phase);

  return (
    <section aria-label="Mises à jour">
      <h2 className={sectionTitle}>Mises à jour</h2>

      <p className="text-sm text-gray-900 dark:text-white">
        Version installée : <span className="font-semibold">{status.currentVersion}</span>
      </p>

      {mode === "inactive" ? (
        <>
          <p className={`mt-3 ${note}`} role="status">
            Les mises à jour automatiques ne sont pas encore actives dans cette version. Pour
            changer de version, téléchargez la nouvelle sur la page de Grammaria et installez-la
            par-dessus : vos réglages et votre journal sont conservés.
          </p>
          <button type="button" onClick={openReleasePage} className={`mt-3 ${secondaryButton}`}>
            Ouvrir la page de téléchargement
          </button>
        </>
      ) : (
        <>
          <p className="mt-3 text-sm text-gray-700 dark:text-gray-200" role="status">
            {phase === "idle" && "Aucune recherche pour l’instant."}
            {phase === "checking" && "Recherche en cours…"}
            {phase === "upToDate" && "Grammaria est à jour."}
            {phase === "noRelease" && "Aucune mise à jour disponible pour le moment."}
            {phase === "available" && `La version ${status.version} est disponible.`}
            {messagePhase(status)}
            {phase === "error" && (
              <span className="text-red-600 dark:text-red-400">{status.error}</span>
            )}
          </p>

          {phase === "error" && status.errorDetail && (
            <p className="mt-1 text-[11px] leading-snug text-gray-400 dark:text-gray-500 break-words">
              Détail technique : {status.errorDetail}
            </p>
          )}

          {phase === "available" && status.notes && (
            <p className={`mt-2 whitespace-pre-line ${note}`}>{status.notes}</p>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            {status.version && mode === "auto" && (phase === "available" || phase === "error") && (
              <button type="button" onClick={install} className={primaryButton}>
                Installer la version {status.version} et redémarrer
              </button>
            )}
            {status.version && mode === "manual" && phase === "available" && (
              <button type="button" onClick={openReleasePage} className={primaryButton}>
                Ouvrir la page de téléchargement
              </button>
            )}
            <button type="button" onClick={check} disabled={working} className={secondaryButton}>
              Rechercher une mise à jour
            </button>
          </div>

          <p className={`mt-4 ${note}`}>
            {mode === "auto"
              ? "Grammaria cherche une nouvelle version à chaque démarrage. Rien n’est installé sans votre accord ; la mise à jour est vérifiée avant d’être installée, et vos réglages et votre journal sont conservés."
              : "Ce type d’installation ne se met pas à jour tout seul : Grammaria vous prévient, puis vous téléchargez la nouvelle version et l’installez par-dessus. Vos réglages et votre journal sont conservés."}
          </p>
        </>
      )}
    </section>
  );
}
