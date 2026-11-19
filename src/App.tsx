import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BadgeGallery } from "./components/BadgeGallery";
import { BadgeNotice } from "./components/BadgeNotice";
import { Editor } from "./components/Editor";
import { Header } from "./components/Header";
import { Icon, WARNING_PATH } from "./components/Icon";
import { Output } from "./components/Output";
import { ProgressionScreen } from "./components/progression/ProgressionScreen";
import { SettingsDialog } from "./components/SettingsDialog";
import { Sidebar } from "./components/Sidebar";
import { Toast } from "./components/Toast";
import { UpdateBanner } from "./components/UpdateBanner";
import { useAppUpdate } from "./hooks/useAppUpdate";
import { useBadgeNotices } from "./hooks/useBadgeNotices";
import { useCorrector } from "./hooks/useCorrector";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { useServerSettings } from "./hooks/useServerSettings";
import { answerChoice } from "./services/journal";
import type { ServerSettings } from "./services/settings";
import { initModel, setCurrentModel } from "./utils/models";

type Pane = "editor" | "output";

/**
 * Attribut `inert` : ce qui est caché sous un autre écran n'est atteignable ni
 * au clavier ni par un lecteur d'écran. (Absent des types de React 18.)
 */
const inertSi = (condition: boolean): object => (condition ? { inert: "" } : {});

function App() {
  const {
    textContent,
    setTextContent,
    outputText,
    corrections,
    analysis,
    analysisNotice,
    settings,
    setSettings,
    isLoading,
    isLoadingCorrections,
    error,
    stats,
    handleCorrect,
    handleReset,
  } = useCorrector();

  // Badges obtenus après une correction ou une réponse au choix à deux formes.
  const badgeNotices = useBadgeNotices();
  const { annoncer: annoncerBadges } = badgeNotices;
  useEffect(() => {
    annoncerBadges(analysis?.nouveauxBadges);
  }, [analysis, annoncerBadges]);
  // Quand le journal change (texte corrigé, réponse au choix, effacement),
  // l'écran « Progression » et la galerie des badges, s'ils sont ouverts, se
  // rechargent : cette valeur change alors d'identité.
  const [journalVersion, setJournalVersion] = useState(0);
  const journalChanged = useCallback(() => setJournalVersion((v) => v + 1), []);
  const journalKey = useMemo(() => ({ analysis, journalVersion }), [analysis, journalVersion]);
  /** La copie a déjà eu lieu : un échec d'enregistrement de la réponse est sans conséquence. */
  const recordChoiceAnswer = useCallback(
    (choiceId: number, correct: boolean) => {
      answerChoice(choiceId, correct)
        .then((badges) => {
          annoncerBadges(badges);
          journalChanged();
        })
        .catch(() => {});
    },
    [annoncerBadges, journalChanged],
  );

  // À partir de la tablette (md), les actions passent dans l'en-tête de chaque
  // panneau, au-dessus des zones de texte ; sur mobile elles restent en bas.
  const actionsInHeader = useMediaQuery("(min-width: 768px)");

  useEffect(() => {
    void initModel();
  }, []);

  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [toast, setToast] = useState<Toast | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activePane, setActivePane] = useState<Pane>("editor");
  // Écran « Progression » : affiché par-dessus la correction, qui garde son état.
  const [progressOpen, setProgressOpen] = useState(false);
  const closeProgress = useCallback(() => setProgressOpen(false), []);
  // L'écran « Progression » commence sous l'en-tête et, dans l'application de
  // bureau, sous le bandeau de mise à jour, qui reste donc visible.
  const topRef = useRef<HTMLDivElement>(null);
  const [topHeight, setTopHeight] = useState(64);
  useEffect(() => {
    const top = topRef.current;
    if (!top || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setTopHeight(top.offsetHeight));
    observer.observe(top);
    return () => observer.disconnect();
  }, []);

  // Application de bureau : tant qu'aucun modèle n'est configuré, ouvrir les
  // réglages pour que l'utilisateur sache par où commencer.
  const { serverSettings, setServerSettings } = useServerSettings();
  const [modelsReloadKey, setModelsReloadKey] = useState(0);
  // Application de bureau : recherche d'une mise à jour au démarrage.
  const appUpdate = useAppUpdate();
  const needsLlmSetup = serverSettings?.editable === true && !serverSettings.configured;
  // Menu Paramètres → IA : ouvert d'office tant qu'aucun modèle n'est configuré.
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [setupDismissed, setSetupDismissed] = useState(false);
  const showPreferences = preferencesOpen || (needsLlmSetup && !setupDismissed);
  const closePreferences = useCallback(() => {
    setPreferencesOpen(false);
    setSetupDismissed(true);
  }, []);

  const handleServerSettingsSaved = useCallback(
    (saved: ServerSettings) => {
      setServerSettings(saved);
      // Le menu ouvert d'office au premier lancement reste ouvert après
      // l'enregistrement : le choix du modèle est dans la même rubrique.
      setPreferencesOpen(true);
      // Nouveau serveur : son modèle par défaut remplace l'ancien choix.
      setCurrentModel("auto");
      void initModel();
      setModelsReloadKey((k) => k + 1);
    },
    [setServerSettings],
  );

  // Sur mobile, un seul panneau est visible : afficher le résultat dès le
  // lancement, pour que le texte et le bouton Copier apparaissent sans
  // toucher l'onglet « Résultat ».
  const startCorrection = useCallback(() => {
    if (textContent.trim()) setActivePane("output");
    void handleCorrect();
  }, [textContent, handleCorrect]);

  useEffect(() => {
    window.document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const onChange = () => {
      if (mq.matches) setSidebarOpen(false);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Barre des réglages ouverte en tiroir (mobile, tablette) : Échap la ferme,
  // elle seule, même par-dessus l'écran « Progression ».
  useEffect(() => {
    if (!sidebarOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      setSidebarOpen(false);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [sidebarOpen]);

  const handleCopySuccess = (text: string) => {
    void navigator.clipboard.writeText(text);
    setToast({ message: "Texte copié dans le presse-papier", type: "success" });
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#f7f9fc] dark:bg-gray-950 text-gray-900 dark:text-gray-100 transition-colors duration-200">
      <div className="fixed inset-0 -z-10 pointer-events-none bg-[radial-gradient(70%_45%_at_50%_0%,rgba(59,130,246,0.07),transparent_70%)] dark:bg-[radial-gradient(70%_45%_at_50%_0%,rgba(37,99,235,0.14),transparent_70%)]" />

      <div ref={topRef} className="sticky top-0 z-40">
        <Header
          theme={theme}
          onToggleTheme={() => setTheme(theme === "light" ? "dark" : "light")}
          onOpenSettings={() => setSidebarOpen(true)}
          onOpenPreferences={() => setPreferencesOpen(true)}
          onOpenProgress={() => setProgressOpen(true)}
          progressOpen={progressOpen}
        />
        <UpdateBanner update={appUpdate} />
      </div>

      {progressOpen && (
        <ProgressionScreen
          onClose={closeProgress}
          top={topHeight}
          reloadKey={journalKey}
          badges={<BadgeGallery reloadKey={journalKey} />}
        />
      )}

      <SettingsDialog
        open={showPreferences}
        onClose={closePreferences}
        serverSettings={serverSettings}
        onServerSettingsSaved={handleServerSettingsSaved}
        modelsReloadKey={modelsReloadKey}
        appUpdate={appUpdate}
      />

      <div className="md:hidden px-4 pt-3" {...inertSi(progressOpen)}>
        <div className="flex gap-1 p-1 rounded-xl bg-gray-100/80 dark:bg-gray-800/60 border border-gray-200/70 dark:border-gray-700/60 max-w-md mx-auto">
          {(
            [
              { id: "editor" as const, label: "Texte" },
              { id: "output" as const, label: "Résultat" },
            ] satisfies { id: Pane; label: string }[]
          ).map((tab) => {
            const isActive = activePane === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActivePane(tab.id)}
                aria-pressed={isActive}
                className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all duration-200
                  ${
                    isActive
                      ? "bg-white dark:bg-gray-700 text-brand-700 dark:text-brand-300 shadow-sm"
                      : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                  }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          settings={settings}
          setSettings={setSettings}
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          onPurged={journalChanged}
          hidden={progressOpen && !sidebarOpen}
        />

        <main className="flex flex-1 min-w-0 overflow-hidden" {...inertSi(progressOpen)}>
          <div className={`${activePane === "editor" ? "flex" : "hidden"} md:flex flex-1 min-w-0`}>
            <Editor
              text={textContent}
              onChange={setTextContent}
              onCorrect={startCorrection}
              isLoading={isLoading}
              actionsInHeader={actionsInHeader}
            />
          </div>
          <div className={`${activePane === "output" ? "flex" : "hidden"} md:flex flex-1 min-w-0`}>
            <Output
              outputText={outputText}
              corrections={corrections}
              stats={stats}
              onCopy={handleCopySuccess}
              onReset={handleReset}
              isLoading={isLoading}
              isLoadingCorrections={isLoadingCorrections}
              score={analysis?.score}
              week={analysis?.week}
              intervention={analysis?.intervention}
              reussites={analysis?.reussites}
              onChoiceAnswer={recordChoiceAnswer}
              analysisNotice={analysisNotice}
              actionsInHeader={actionsInHeader}
            />
          </div>
        </main>
      </div>

      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}
      <BadgeNotice
        badges={badgeNotices.annonces}
        onClose={badgeNotices.fermer}
        suspendue={showPreferences || sidebarOpen}
      />

      {error && (
        <div
          {...inertSi(progressOpen)}
          className="bg-red-50/90 dark:bg-red-950/40 border-t border-red-200/70 dark:border-red-800/40 backdrop-blur-sm"
        >
          <div className="flex items-center justify-between gap-4 max-w-5xl mx-auto px-5 py-3.5">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-7 h-7 rounded-lg bg-red-100 dark:bg-red-900/40 flex items-center justify-center shrink-0">
                <Icon className="w-3.5 h-3.5 text-red-500">
                  <path d={WARNING_PATH} />
                </Icon>
              </div>
              <p className="text-sm text-red-700 dark:text-red-300 break-words">{error}</p>
            </div>
            <button
              type="button"
              onClick={handleCorrect}
              className="shrink-0 px-4 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white text-sm font-medium transition-all duration-200 active:scale-[0.98]"
            >
              Réessayer
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
