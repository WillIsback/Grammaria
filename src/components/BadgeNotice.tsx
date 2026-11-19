import { useCallback, useEffect, useState } from "react";
import type { BadgeAnnonce } from "../analysis/badges/vue";
import { BadgeIcon } from "./BadgeIcon";

/** Durée d'affichage de la notification, prolongée tant qu'elle est survolée ou focalisée. */
export const DUREE_NOTIFICATION_MS = 8000;

interface Props {
  badges: BadgeAnnonce[];
  onClose: () => void;
  /**
   * Vrai tant qu'une fenêtre (menu Paramètres, barre des réglages en tiroir)
   * recouvre la page : la notification attend sa fermeture pour s'afficher,
   * avec son délai complet.
   */
  suspendue?: boolean;
}

/**
 * Notification discrète des badges obtenus : jamais modale, une seule à la
 * fois (plusieurs badges sont regroupés), placée loin du bouton Copier (sous
 * l'en-tête sur mobile, où Copier est en bas et où le message « Texte copié »
 * occupe le haut de l'écran ; en bas à gauche sur grand écran, où Copier est
 * dans l'en-tête du résultat). La zone `role="status"` reste
 * toujours présente pour que les lecteurs d'écran annoncent son contenu.
 */
export function BadgeNotice({ badges, onClose, suspendue = false }: Props) {
  const [enPause, setEnPause] = useState(false);
  const visible = badges.length > 0 && !suspendue;
  const fermer = useCallback(() => {
    setEnPause(false);
    onClose();
  }, [onClose]);

  // Le délai repart à chaque nouveau badge regroupé dans la notification.
  useEffect(() => {
    if (!visible || enPause) return;
    const timer = setTimeout(onClose, DUREE_NOTIFICATION_MS);
    return () => clearTimeout(timer);
  }, [visible, enPause, badges, onClose]);

  useEffect(() => {
    if (!visible) return;
    // Échap ne ferme qu'un élément à la fois : la notification d'abord, l'écran
    // « Progression » éventuellement ouvert derrière elle ensuite.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      fermer();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [visible, fermer]);

  const plusieurs = badges.length > 1;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="fixed z-40 inset-x-4 top-[4.5rem] md:inset-x-auto md:top-auto md:left-6 md:bottom-6 md:w-[22rem] pointer-events-none"
    >
      {visible && (
        <div
          onMouseEnter={() => setEnPause(true)}
          onMouseLeave={() => setEnPause(false)}
          onFocus={() => setEnPause(true)}
          onBlur={() => setEnPause(false)}
          className="pointer-events-auto flex items-start gap-3 p-3.5 rounded-2xl animate-slide-up motion-reduce:animate-none
            bg-white/95 dark:bg-gray-900/95 backdrop-blur-lg shadow-elevated
            border border-brand-200/80 dark:border-brand-500/30"
        >
          <div className="w-9 h-9 shrink-0 rounded-full bg-brand-600 dark:bg-brand-500 text-white flex items-center justify-center">
            <BadgeIcon mesure="reglesAcquises" className="w-5 h-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-gray-900 dark:text-white">
              {plusieurs ? `${badges.length} badges obtenus` : `Badge obtenu : ${badges[0].titre}`}
            </p>
            {plusieurs ? (
              <ul className="mt-1 space-y-0.5 text-[13px] text-gray-600 dark:text-gray-300">
                {badges.map((b) => (
                  <li key={b.id}>{b.titre}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-0.5 text-[13px] leading-relaxed text-gray-600 dark:text-gray-300">
                {badges[0].description}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={fermer}
            aria-label="Fermer la notification"
            className="shrink-0 -mr-1 -mt-1 w-7 h-7 rounded-lg flex items-center justify-center
              text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800
              transition-colors"
          >
            <svg
              aria-hidden="true"
              focusable="false"
              className="w-3.5 h-3.5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth={2.5}
              strokeLinecap="round"
            >
              <path d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}
