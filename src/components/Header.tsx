import type { ReactNode } from "react";
import { Icon } from "./Icon";

interface Props {
  theme: "light" | "dark";
  onToggleTheme: () => void;
  /** Barre des réglages de correction (mobile et tablette). */
  onOpenSettings: () => void;
  /** Menu Paramètres (rubrique IA : serveur et choix du modèle). */
  onOpenPreferences: () => void;
  /** Écran « Progression ». */
  onOpenProgress: () => void;
  /** Vrai pendant que l'écran « Progression » est affiché. */
  progressOpen: boolean;
}

interface IconButtonProps {
  label: string;
  onClick: () => void;
  /** Infobulle reprenant le libellé. */
  withTitle?: boolean;
  /** Bouton à bascule : état enfoncé, mis en évidence. */
  pressed?: boolean;
  className?: string;
  children: ReactNode;
}

/** Bouton carré de l'en-tête, réduit à son icône. */
function IconButton({
  label,
  onClick,
  withTitle = false,
  pressed,
  className = "",
  children,
}: IconButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      aria-label={label}
      title={withTitle ? label : undefined}
      className={`w-9 h-9 rounded-xl flex items-center justify-center transition-all duration-200
        ${
          pressed
            ? "bg-brand-50 dark:bg-brand-500/15 text-brand-700 dark:text-brand-300"
            : "text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-700 dark:hover:text-gray-200"
        } ${className}`}
    >
      <Icon className="w-[18px] h-[18px]">{children}</Icon>
    </button>
  );
}

export function Header({
  theme,
  onToggleTheme,
  onOpenSettings,
  onOpenPreferences,
  onOpenProgress,
  progressOpen,
}: Props) {
  const isDark = theme === "dark";

  return (
    <header className="border-b border-gray-200/70 dark:border-gray-800/70 bg-white/80 dark:bg-gray-900/80 backdrop-blur-xl">
      <div className="flex justify-between items-center gap-3 px-4 sm:px-6 h-16">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-brand-500 to-brand-600 flex items-center justify-center shadow-sm shadow-brand-500/25 shrink-0">
            <Icon className="w-[18px] h-[18px] text-white" strokeWidth={2.5}>
              <path d="M13 21h8" />
              <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
            </Icon>
          </div>
          <div className="min-w-0">
            <h1 className="text-[15px] font-semibold text-gray-900 dark:text-white tracking-tight leading-tight truncate">
              Grammaria
            </h1>
            <p className="text-[11px] text-gray-400 dark:text-gray-500 font-medium tracking-wide truncate">
              Correcteur intelligent
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <IconButton label="Réglages de correction" onClick={onOpenSettings} className="lg:hidden">
            <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />
          </IconButton>

          <IconButton label="Progression" onClick={onOpenProgress} withTitle pressed={progressOpen}>
            <path d="M3 3v18h18" />
            <path d="M7 16v-4M12 16V8M17 16v-7" />
          </IconButton>

          <IconButton label="Paramètres" onClick={onOpenPreferences} withTitle>
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
          </IconButton>

          <IconButton
            label={isDark ? "Passer en thème clair" : "Passer en thème sombre"}
            onClick={onToggleTheme}
          >
            {isDark ? (
              <>
                <title>Thème clair</title>
                <path d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
              </>
            ) : (
              <>
                <title>Thème sombre</title>
                <path d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
              </>
            )}
          </IconButton>
        </div>
      </div>
    </header>
  );
}
