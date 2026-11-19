import type React from "react";
import { useState } from "react";
import { purgeJournal } from "../services/journal";
import type { CorrectionMode, CorrectionSettings } from "../types";
import { ConfirmDialog } from "./ConfirmDialog";
import { CHECK_PATH, CloseButton, Icon } from "./Icon";

interface Props {
  settings: CorrectionSettings;
  setSettings: (settings: CorrectionSettings) => void;
  open: boolean;
  onClose: () => void;
  /** Appelé après l'effacement du journal, pour recharger ce qui en dépend. */
  onPurged?: () => void;
  /** Vrai quand la barre est cachée sous un autre écran : elle devient inerte. */
  hidden?: boolean;
}

const modeLabels: Record<CorrectionMode, { label: string; icon: string }> = {
  formel: { label: "Formel", icon: "F" },
  "semi-formel": { label: "Semi-formel", icon: "SF" },
  informel: { label: "Informel", icon: "I" },
  technical: { label: "Technique", icon: "T" },
};

const PURGE_WARNING =
  "Effacer définitivement tout le journal des fautes ? Les badges obtenus seront aussi effacés.";

/** Titre de rubrique, partagé avec les rubriques du menu Paramètres. */
export const sectionTitle =
  "text-[11px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-3";

export function Sidebar({ settings, setSettings, open, onClose, onPurged, hidden = false }: Props) {
  const modeKeys = Object.keys(modeLabels) as CorrectionMode[];
  const [purgeStatus, setPurgeStatus] = useState<string | null>(null);

  const [confirmPurge, setConfirmPurge] = useState(false);

  const handlePurge = async () => {
    setConfirmPurge(false);
    try {
      await purgeJournal();
      setPurgeStatus("Journal et badges effacés.");
      onPurged?.();
    } catch {
      setPurgeStatus("Le journal n'a pas pu être effacé.");
    }
  };

  const handleModeChange = (newMode: CorrectionMode) => {
    setSettings({ ...settings, mode: newMode });
  };

  const handleSettingChange = (setting: keyof CorrectionSettings, value: boolean) => {
    setSettings({ ...settings, [setting]: value });
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown": {
        e.preventDefault();
        handleModeChange(modeKeys[(index + 1) % modeKeys.length]);
        break;
      }
      case "ArrowLeft":
      case "ArrowUp": {
        e.preventDefault();
        handleModeChange(modeKeys[(index - 1 + modeKeys.length) % modeKeys.length]);
        break;
      }
      case "Enter":
      case " ": {
        e.preventDefault();
        handleModeChange(modeKeys[index]);
        break;
      }
    }
  };

  const checkbox = (checked: boolean) => (
    <div className="relative shrink-0">
      <div
        className={`w-[18px] h-[18px] rounded-md border-2 flex items-center justify-center transition-all duration-150
          ${
            checked
              ? "border-brand-500 bg-brand-500"
              : "border-gray-300 dark:border-gray-600 bg-transparent"
          }`}
      >
        <Icon
          className={`w-3 h-3 text-white transition-opacity ${checked ? "opacity-100" : "opacity-0"}`}
          strokeWidth={3}
        >
          <path d={CHECK_PATH} />
        </Icon>
      </div>
    </div>
  );

  return (
    <>
      <div
        className={`fixed inset-0 z-40 bg-gray-900/40 backdrop-blur-sm lg:hidden transition-opacity duration-300
          ${open ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        onClick={onClose}
        aria-hidden="true"
      />

      <aside
        aria-label="Réglages de correction"
        {...(hidden ? { inert: "" } : {})}
        className={`fixed inset-y-0 left-0 z-50 w-[280px] max-w-[85vw] shrink-0 overflow-y-auto
          bg-white dark:bg-gray-900 border-r border-gray-200/70 dark:border-gray-800/70
          p-5 shadow-2xl shadow-gray-900/10 transition-transform duration-300 ease-out
          lg:static lg:z-auto lg:w-[272px] lg:translate-x-0 lg:bg-white/70 lg:dark:bg-gray-900/60
          lg:backdrop-blur-sm lg:shadow-none
          ${open ? "translate-x-0" : "-translate-x-full"}`}
      >
        <div className="lg:hidden flex items-center justify-between mb-5">
          <span className="text-sm font-semibold text-gray-900 dark:text-white">Réglages</span>
          <CloseButton label="Fermer les réglages" onClick={onClose} />
        </div>

        <div className="mb-6">
          <h2 className={sectionTitle}>Mode de correction</h2>

          <div role="radiogroup" aria-label="Mode de correction" className="space-y-1">
            {modeKeys.map((key, index) => {
              const isSelected = settings.mode === key;
              return (
                <div key={key}>
                  <input
                    type="radio"
                    id={`mode-${key}`}
                    name="mode"
                    value={key}
                    checked={isSelected}
                    onChange={() => handleModeChange(key)}
                    className="peer sr-only"
                  />
                  <label
                    htmlFor={`mode-${key}`}
                    role="radio"
                    tabIndex={0}
                    aria-checked={isSelected}
                    onKeyDown={(e) => handleKeyDown(index, e)}
                    onClick={() => handleModeChange(key)}
                    className={`flex items-center gap-2.5 cursor-pointer px-3 py-2 rounded-xl text-sm font-medium transition-all duration-200
                      ${
                        isSelected
                          ? "bg-brand-50 dark:bg-brand-500/10 text-brand-700 dark:text-brand-300 ring-1 ring-brand-100 dark:ring-brand-500/20"
                          : "text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800/50 hover:text-gray-900 dark:hover:text-gray-200"
                      }
                      focus:outline-none focus:ring-2 focus:ring-brand-500/30`}
                  >
                    <span
                      className={`w-6 h-6 rounded-lg text-[10px] font-bold flex items-center justify-center transition-colors
                      ${
                        isSelected
                          ? "bg-brand-500 text-white"
                          : "bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500"
                      }`}
                    >
                      {modeLabels[key].icon}
                    </span>
                    <span>{modeLabels[key].label}</span>
                  </label>
                </div>
              );
            })}
          </div>
        </div>

        <div className="mb-6">
          <h2 className={sectionTitle}>Corrections</h2>

          <div className="space-y-0.5">
            {[
              { key: "fixGrammar" as const, label: "Grammaire" },
              { key: "fixSpelling" as const, label: "Orthographe" },
              { key: "fixSyntax" as const, label: "Syntaxe" },
              { key: "fixStyle" as const, label: "Style" },
            ].map(({ key, label }) => (
              <label
                key={key}
                className="flex items-center gap-2.5 px-3 py-2 rounded-xl cursor-pointer
                  hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
              >
                <input
                  type="checkbox"
                  checked={settings[key]}
                  onChange={(e) => handleSettingChange(key, e.target.checked)}
                  className="peer sr-only"
                />
                {checkbox(settings[key])}
                <span className="text-sm text-gray-700 dark:text-gray-300">{label}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="mt-5 pt-5 border-t border-gray-200/70 dark:border-gray-800/70">
          <h2 className={sectionTitle}>Journal des fautes</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
            Seule la phrase contenant une faute est conservée, jamais le texte entier.
          </p>
          <button
            type="button"
            onClick={() => setConfirmPurge(true)}
            className="w-full px-3 py-2 rounded-xl text-sm font-medium text-red-600 dark:text-red-400
              border border-red-200/80 dark:border-red-900/60 hover:bg-red-50 dark:hover:bg-red-950/40
              transition-colors"
          >
            Effacer le journal
          </button>
          <ConfirmDialog
            open={confirmPurge}
            title="Effacer le journal ?"
            message={PURGE_WARNING}
            confirmLabel="Effacer"
            onConfirm={handlePurge}
            onCancel={() => setConfirmPurge(false)}
          />
          {purgeStatus && (
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400" role="status">
              {purgeStatus}
            </p>
          )}
        </div>
      </aside>
    </>
  );
}
