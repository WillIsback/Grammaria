import type { ReactNode } from "react";
import type { MesureBadge } from "../analysis/badges/catalogue";

/**
 * Pictogrammes des badges, dessinés à la main sur une grille de 24 × 24 avec
 * le même trait (1,75, extrémités arrondies) : un pictogramme par mesure.
 */
const TRACES: Record<MesureBadge, ReactNode> = {
  // Une page de texte.
  textes: (
    <>
      <path d="M7 3h7l4 4v14H7z" />
      <path d="M14 3v4h4" />
      <path d="M10 12h5M10 16h5" />
    </>
  ),
  // Un calendrier, une journée cochée.
  jours: (
    <>
      <rect x="4" y="5" width="16" height="15" rx="2" />
      <path d="M8 3v4M16 3v4M4 10h16" />
      <path d="M9.5 15l1.75 1.75L14.5 13.5" />
    </>
  ),
  // Un calendrier, une semaine soulignée.
  semaines: (
    <>
      <rect x="4" y="5" width="16" height="15" rx="2" />
      <path d="M8 3v4M16 3v4M4 10h16" />
      <path d="M7.5 15h9" />
    </>
  ),
  // Une page validée.
  textesSansFaute: (
    <>
      <path d="M7 3h7l4 4v14H7z" />
      <path d="M14 3v4h4" />
      <path d="M9.75 14.25l2 2 3.5-4" />
    </>
  ),
  // Une jauge.
  noteMoyenne: (
    <>
      <path d="M4 17a8 8 0 1 1 16 0" />
      <path d="M12 17l3.5-4.5" />
      <path d="M6.5 17h.01M17.5 17h.01" />
    </>
  ),
  // Une rosette.
  reglesAcquises: (
    <>
      <circle cx="12" cy="9" r="5.5" />
      <path d="M9 13.8 8 21l4-2 4 2-1-7.2" />
      <path d="M9.75 9l1.5 1.5 3-3" />
    </>
  ),
  // Deux formes qui se ressemblent.
  homophonesAcquis: (
    <>
      <circle cx="9" cy="12" r="5.5" />
      <circle cx="15" cy="12" r="5.5" />
    </>
  ),
  // Une courbe qui repart à la hausse.
  rechutesSurmontees: (
    <>
      <path d="M3.5 16.5l5-5 3.5 3 7.5-7.5" />
      <path d="M14.5 7h5v5" />
    </>
  ),
  // Deux boutons, le bon choisi.
  reponsesJustes: (
    <>
      <rect x="3" y="6.5" width="8" height="11" rx="2" />
      <rect x="13" y="6.5" width="8" height="11" rx="2" />
      <path d="M15 12.25l1.5 1.5 2.75-3" />
    </>
  ),
};

interface Props {
  mesure: MesureBadge;
  className?: string;
}

/** Pictogramme décoratif : le sens est toujours donné par le texte voisin. */
export function BadgeIcon({ mesure, className = "w-6 h-6" }: Props) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {TRACES[mesure]}
    </svg>
  );
}
