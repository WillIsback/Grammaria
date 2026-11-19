import type { ReactNode } from "react";

/** Tracés partagés par plusieurs icônes (grille 24 × 24). */
export const CLOSE_PATH = "M6 18L18 6M6 6l12 12";
export const CHECK_PATH = "M5 13l4 4L19 7";
/** Point d'exclamation dans un cercle. */
export const WARNING_PATH = "M12 9v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z";

interface IconProps {
  className?: string;
  strokeWidth?: number;
  /** Tracés de l'icône (`<path>`, `<circle>`…). */
  children: ReactNode;
}

/**
 * Icône au trait sur une grille 24 × 24, en couleur du texte. Toujours
 * décorative : le libellé est porté par le bouton ou le texte voisin.
 */
export function Icon({ className, strokeWidth = 2, children }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

/** Indicateur de chargement : cercle pâle et quart plein qui tourne. */
export function Spinner({ className }: { className: string }) {
  return (
    <svg aria-hidden="true" className={`${className} animate-spin`} fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
    </svg>
  );
}

/** Bouton « × » d'en-tête de panneau (barre des réglages, menu Paramètres). */
export function CloseButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400
        hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-600 dark:hover:text-gray-200
        transition-colors"
    >
      <Icon className="w-4 h-4" strokeWidth={2.5}>
        <path d={CLOSE_PATH} />
      </Icon>
    </button>
  );
}
