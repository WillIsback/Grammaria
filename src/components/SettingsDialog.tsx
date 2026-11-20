import { useEffect, useRef, useState } from "react";
import type { AppUpdate } from "../hooks/useAppUpdate";
import type { ServerSettings } from "../services/settings";
import { getCurrentModel, subscribeToModelChange } from "../utils/models";
import { CloseButton } from "./Icon";
import { LlmSettings } from "./LlmSettings";
import { ModelSelector } from "./ModelSelector";
import { UpdateSettings } from "./UpdateSettings";

/** Rubriques du menu Paramètres. « Mises à jour » n'existe que dans l'application de bureau. */
type Section = "ia" | "mises-a-jour";

const SECTIONS: { id: Section; label: string }[] = [
  { id: "ia", label: "IA" },
  { id: "mises-a-jour", label: "Mises à jour" },
];

interface Props {
  open: boolean;
  onClose: () => void;
  /** Réglages du serveur : « Serveur du modèle » n'apparaît que s'ils sont modifiables (bureau). */
  serverSettings: ServerSettings | null;
  onServerSettingsSaved: (settings: ServerSettings) => void;
  /** Incrémenté quand le serveur du modèle change, pour recharger la liste des modèles. */
  modelsReloadKey: number;
  /** Mise à jour de l'application de bureau ; absent ou null dans un navigateur. */
  appUpdate?: AppUpdate | null;
}

/**
 * Menu Paramètres, ouvert depuis l'en-tête. La rubrique IA regroupe le
 * serveur du modèle (application de bureau) et le choix du modèle ; la barre
 * latérale ne garde que les réglages de correction.
 */
export function SettingsDialog({
  open,
  onClose,
  serverSettings,
  onServerSettingsSaved,
  modelsReloadKey,
  appUpdate = null,
}: Props) {
  const [section, setSection] = useState<Section>("ia");
  const sections = SECTIONS.filter(({ id }) => id !== "mises-a-jour" || appUpdate !== null);
  const [currentModel, setCurrentModelState] = useState(getCurrentModel);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => subscribeToModelChange(setCurrentModelState), []);

  // Échap ferme le menu ; le focus va au panneau à l'ouverture.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    panelRef.current?.focus();
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center sm:items-center p-0 sm:p-6">
      <div
        className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
        className="relative w-full sm:max-w-2xl max-h-full sm:max-h-[85vh] overflow-hidden flex flex-col
          bg-white dark:bg-gray-900 sm:rounded-2xl shadow-2xl shadow-gray-900/20
          border border-gray-200/70 dark:border-gray-800/70 focus:outline-none"
      >
        <div className="flex items-center justify-between px-5 h-14 border-b border-gray-200/70 dark:border-gray-800/70 shrink-0">
          <h2 id="settings-title" className="text-sm font-semibold text-gray-900 dark:text-white">
            Paramètres
          </h2>
          <CloseButton label="Fermer les paramètres" onClick={onClose} />
        </div>

        <div className="flex flex-col sm:flex-row min-h-0 flex-1">
          <nav
            aria-label="Rubriques des paramètres"
            className="flex sm:flex-col gap-1 p-3 sm:w-40 shrink-0 border-b sm:border-b-0 sm:border-r
              border-gray-200/70 dark:border-gray-800/70"
          >
            {sections.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                onClick={() => setSection(id)}
                aria-current={section === id ? "page" : undefined}
                className={`px-3 py-2 rounded-xl text-sm font-medium text-left transition-colors
                  ${
                    section === id
                      ? "bg-brand-50 dark:bg-brand-500/10 text-brand-700 dark:text-brand-300"
                      : "text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800/50"
                  }`}
              >
                {label}
              </button>
            ))}
          </nav>

          <div className="flex-1 overflow-y-auto p-5">
            {section === "ia" && (
              <section aria-label="IA">
                {serverSettings?.editable && (
                  <LlmSettings settings={serverSettings} onSaved={onServerSettingsSaved} />
                )}
                <ModelSelector
                  currentModel={currentModel}
                  onModelSelect={setCurrentModelState}
                  reloadKey={modelsReloadKey}
                  awaitingTarget={serverSettings?.editable === true && !serverSettings.configured}
                />
              </section>
            )}
            {section === "mises-a-jour" && appUpdate && <UpdateSettings update={appUpdate} />}
          </div>
        </div>
      </div>
    </div>
  );
}
