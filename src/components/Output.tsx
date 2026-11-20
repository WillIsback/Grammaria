import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import type {
  FormeChoix,
  Intervention,
  InterventionChoix,
  Reussite,
} from "../analysis/regles/intervention";
import type { CorrectionEntry, WeekSummary } from "../types";
import { nombre } from "../utils/format";
import { visibleText } from "../utils/visibleText";
import { Icon, Spinner } from "./Icon";
import { InterventionMessage } from "./InterventionMessage";

interface Props {
  outputText: string;
  corrections: CorrectionEntry[];
  stats: {
    processingTime: number;
    modificationCount: number;
  };
  onCopy: (text: string) => void;
  onReset: () => void;
  isLoading: boolean;
  isLoadingCorrections?: boolean;
  /** Note sur 20 du texte courant (null tant que l'analyse n'est pas faite). */
  score?: number | null;
  week?: WeekSummary | null;
  analysisNotice?: string | null;
  /** Boutons Copier / Réinitialiser dans l'en-tête (écrans larges) plutôt qu'en bas. */
  actionsInHeader?: boolean;
  /** Astuce ou choix à deux formes décidé par le serveur pour ce texte. */
  intervention?: Intervention | null;
  /** Règles devenues « acquises » avec ce texte. */
  reussites?: Reussite[];
  /** Forme cliquée lors du choix à deux formes (le texte est déjà copié). */
  onChoiceAnswer?: (choiceId: number, correct: boolean) => void;
}

const COPY_ICON = (
  <Icon className="w-4 h-4 shrink-0">
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
  </Icon>
);

/** Carte de statistique sous le résultat (temps, nombre de corrections). */
function StatCard({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div
      className="bg-white dark:bg-gray-800/80 p-3.5 rounded-xl border border-gray-200/60
        dark:border-gray-700/60 shadow-subtle"
    >
      <div className="flex items-center gap-2 mb-1">
        {icon}
        <span className="text-[11px] font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider">
          {label}
        </span>
      </div>
      {children}
    </div>
  );
}

export function Output({
  outputText,
  corrections,
  stats,
  onCopy,
  onReset,
  isLoading,
  isLoadingCorrections,
  score,
  week,
  analysisNotice,
  actionsInHeader = false,
  intervention = null,
  reussites = [],
  onChoiceAnswer,
}: Props) {
  const [correctionsOpen, setCorrectionsOpen] = useState(true);

  // Choix à deux formes : la réponse est liée à l'intervention du texte
  // courant, une nouvelle correction repart donc d'un choix sans réponse.
  const [reponse, setReponse] = useState<{ choix: InterventionChoix; forme: FormeChoix } | null>(
    null,
  );
  const choixRecu = intervention?.type === "choix" ? intervention : null;

  // Clic accidentel : l'analyse arrive après le texte, donc le bouton Copier
  // peut être remplacé sous le pointeur. Si le pointeur survole Copier, ou si
  // le texte de cette correction a déjà été copié, le choix n'est pas proposé
  // cette fois ; la décision est prise une fois, à l'arrivée de l'intervention.
  const [survol, setSurvol] = useState(false);
  const [copie, setCopie] = useState(false);
  if (outputText === "" && (survol || copie)) {
    // Nouvelle correction : le bouton a disparu, on repart de zéro.
    setSurvol(false);
    setCopie(false);
  }
  const [decision, setDecision] = useState<{ choix: InterventionChoix | null; proposer: boolean }>({
    choix: null,
    proposer: false,
  });
  if (decision.choix !== choixRecu) {
    setDecision({ choix: choixRecu, proposer: choixRecu !== null && !survol && !copie });
  }
  const choix = decision.choix === choixRecu && decision.proposer ? choixRecu : null;
  const formeChoisie = reponse && reponse.choix === choix ? reponse.forme : null;
  const choixEnAttente = choix !== null && formeChoisie === null;
  // Choix écarté : son explication est affichée comme une simple astuce.
  const interventionAffichee: Intervention | null =
    choixRecu && !choix
      ? {
          type: "astuce",
          ruleKey: choixRecu.ruleKey,
          titre: choixRecu.titre,
          texte: choixRecu.explication,
        }
      : intervention;

  const copy = () => {
    setCopie(true);
    onCopy(outputText);
  };

  // Focus clavier. Quand les deux formes remplacent un bouton Copier qui avait
  // le focus, il passe au groupe (pas à une forme : un appui sur Entrée ne doit
  // pas répondre par mégarde). Quand elles disparaissent au clic, il revient
  // sur Copier.
  const questionId = useId();
  const copyRef = useRef<HTMLButtonElement>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const copyHadFocus = useRef(false);
  useEffect(() => {
    if (choixEnAttente && copyHadFocus.current) groupRef.current?.focus();
    if (choixEnAttente) copyHadFocus.current = false;
  }, [choixEnAttente]);
  useEffect(() => {
    if (formeChoisie) copyRef.current?.focus();
  }, [formeChoisie]);

  const copyClass = `flex items-center justify-center gap-2 py-2.5
    bg-brand-600 hover:bg-brand-700 text-white rounded-xl text-sm font-semibold
    shadow-sm shadow-brand-500/25 hover:shadow-md hover:shadow-brand-500/30
    transition-all duration-200 active:scale-[0.98]
    focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2
    focus-visible:outline-brand-500`;

  const actions = (
    <>
      {choix && choixEnAttente ? (
        <div
          ref={groupRef}
          role="group"
          tabIndex={-1}
          aria-label="Copier le texte corrigé en choisissant la bonne forme"
          aria-describedby={questionId}
          className={`flex gap-2 min-w-0 rounded-xl focus-visible:outline focus-visible:outline-2
            focus-visible:outline-offset-2 focus-visible:outline-brand-500
            ${actionsInHeader ? "" : "flex-1"}`}
        >
          {choix.formes.map((forme) => (
            <button
              key={forme.texte}
              type="button"
              aria-label={`Copier avec « ${forme.texte} »`}
              title={`Copier avec « ${forme.texte} »`}
              onClick={() => {
                // Un seul clic : le texte corrigé est copié quelle que soit la forme.
                copy();
                setReponse({ choix, forme });
                onChoiceAnswer?.(choix.choiceId, forme.correcte);
              }}
              className={`${actionsInHeader ? "px-3.5 max-w-[11rem]" : "flex-1 px-4"} min-w-0 ${copyClass}`}
            >
              {COPY_ICON}
              <span className="truncate">{forme.texte}</span>
            </button>
          ))}
        </div>
      ) : (
        <button
          ref={copyRef}
          type="button"
          onClick={copy}
          onPointerEnter={() => setSurvol(true)}
          onPointerLeave={() => setSurvol(false)}
          onFocus={() => {
            copyHadFocus.current = true;
          }}
          onBlur={(event) => {
            // Un bouton retiré de la page (remplacé par les deux formes) ne
            // doit pas faire oublier qu'il avait le focus.
            if (event.currentTarget.isConnected) copyHadFocus.current = false;
          }}
          className={`${actionsInHeader ? "px-4" : "flex-1 px-5"} ${copyClass}`}
        >
          {COPY_ICON}
          Copier
        </button>
      )}
      {!isLoading && (
        <button
          type="button"
          onClick={onReset}
          className={`${actionsInHeader ? "px-4" : "px-5"} py-2.5 rounded-xl text-sm font-medium
                      text-gray-500 dark:text-gray-400 border border-gray-200/80 dark:border-gray-700/80
                      hover:bg-gray-50 dark:hover:bg-gray-800
                      hover:text-gray-700 dark:hover:text-gray-200
                      transition-all duration-200`}
        >
          Réinitialiser
        </button>
      )}
    </>
  );
  // Zone de message toujours présente près du bouton Copier, pour que les
  // lecteurs d'écran annoncent ce qui s'y affiche.
  const message = (
    <InterventionMessage
      intervention={interventionAffichee}
      reussites={reussites}
      formeChoisie={formeChoisie}
      questionId={questionId}
    />
  );

  return (
    <div className="flex-1 flex flex-col min-w-0 md:border-l border-gray-200/60 dark:border-gray-800/60">
      <div className="flex-1 p-4 sm:p-6 overflow-y-auto">
        <div className="max-w-2xl mx-auto h-full flex flex-col">
          {/* Avec deux formes longues, les boutons passent à la ligne plutôt que d'être tronqués. */}
          <div
            className={`flex items-center justify-between gap-x-4 gap-y-2 mb-4 md:min-h-10
              ${choixEnAttente ? "flex-wrap" : ""}`}
          >
            <div className={choixEnAttente ? "flex-1 basis-0 min-w-[7rem]" : "min-w-0"}>
              <h2 className="text-sm font-semibold text-gray-900 dark:text-white whitespace-nowrap">
                Résultat corrigé
              </h2>
              <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5 truncate">
                Texte corrigé selon vos paramètres
              </p>
            </div>
            {actionsInHeader && outputText && (
              <div
                className={`flex items-center gap-2 ${choixEnAttente ? "min-w-0 ml-auto" : "shrink-0"}`}
              >
                {actions}
              </div>
            )}
          </div>

          {actionsInHeader && outputText && message}

          <div
            className="flex-1 min-h-[320px] lg:min-h-[420px] bg-white dark:bg-gray-800/50 p-5 rounded-2xl
              border border-gray-200/60 dark:border-gray-700/60 shadow-subtle"
          >
            {outputText ? (
              <p className="text-[15px] leading-relaxed text-gray-800 dark:text-gray-200 whitespace-pre-wrap">
                {outputText}
              </p>
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-center py-12">
                <div className="w-16 h-16 rounded-2xl bg-brand-50 dark:bg-brand-500/10 flex items-center justify-center mb-4">
                  <Icon className="w-7 h-7 text-brand-400 dark:text-brand-500" strokeWidth={1.5}>
                    <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </Icon>
                </div>
                <p className="text-sm text-gray-400 dark:text-gray-500 max-w-[220px]">
                  Le texte corrigé apparaîtra ici
                </p>
              </div>
            )}
          </div>

          {isLoadingCorrections && !outputText && (
            <div className="mt-5 flex items-center gap-3 text-sm text-gray-400 dark:text-gray-500">
              <Spinner className="w-4 h-4 text-brand-500" />
              Correction en cours…
            </div>
          )}

          {outputText && (
            <div className="animate-slide-up">
              <div className="mt-5 grid grid-cols-2 gap-3">
                <StatCard
                  label="Temps"
                  icon={
                    <Icon className="w-3.5 h-3.5 text-gray-400">
                      <path d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </Icon>
                  }
                >
                  <p className="text-xl font-semibold text-gray-900 dark:text-white tabular-nums">
                    {stats.processingTime}
                    <span className="text-sm font-normal text-gray-400 ml-0.5">ms</span>
                  </p>
                </StatCard>

                <StatCard
                  label="Corrections"
                  icon={
                    <Icon className="w-3.5 h-3.5 text-brand-500">
                      <path d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
                    </Icon>
                  }
                >
                  {isLoadingCorrections ? (
                    <Spinner className="w-5 h-5 mt-0.5 text-brand-500" />
                  ) : (
                    <p className="text-xl font-semibold text-brand-600 dark:text-brand-400 tabular-nums">
                      {stats.modificationCount}
                    </p>
                  )}
                </StatCard>
              </div>

              {isLoadingCorrections && (
                <div className="mt-5 flex items-center gap-2 text-xs text-gray-400 dark:text-gray-500">
                  <Spinner className="w-3.5 h-3.5 text-brand-500" />
                  <span className="uppercase tracking-wider font-semibold">
                    Analyse des corrections…
                  </span>
                </div>
              )}

              {corrections.length > 0 && (
                <div className="mt-5">
                  <button
                    type="button"
                    onClick={() => setCorrectionsOpen((o) => !o)}
                    className="flex items-center gap-2 w-full text-left group"
                  >
                    <span className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">
                      Corrections ({corrections.length})
                    </span>
                    <Icon
                      className={`w-3.5 h-3.5 text-gray-400 transition-transform duration-200 ${correctionsOpen ? "rotate-180" : ""}`}
                    >
                      <path d="M19 9l-7 7-7-7" />
                    </Icon>
                  </button>
                  {correctionsOpen && (
                    <div
                      className="mt-2 bg-white dark:bg-gray-800/50 rounded-2xl border
                        border-gray-200/60 dark:border-gray-700/60 shadow-subtle divide-y
                        divide-gray-100 dark:divide-gray-700/60 overflow-hidden"
                    >
                      {corrections.map((c, i) => (
                        <div
                          // corrections list is static per render
                          key={i}
                          className="px-4 py-3 sm:py-2.5 min-w-0"
                        >
                          <div
                            className="flex flex-col gap-1 text-[13px] min-w-0
                              sm:grid sm:grid-cols-[1fr_auto_1fr_1fr] sm:items-center sm:gap-2"
                          >
                            <span
                              className="text-red-500 dark:text-red-400 line-through font-mono truncate"
                              title={c.avant}
                            >
                              {visibleText(c.avant)}
                            </span>
                            <span className="hidden sm:inline text-gray-400 shrink-0">→</span>
                            <span
                              className="text-emerald-700 dark:text-emerald-400 font-mono truncate"
                              title={c.apres}
                            >
                              {visibleText(c.apres)}
                            </span>
                            <span
                              className="text-[11px] text-gray-400 dark:text-gray-500 italic truncate sm:text-right"
                              title={c.regle}
                            >
                              {c.regle}
                            </span>
                          </div>
                          {c.astuce && (
                            <p className="mt-1.5 text-xs leading-relaxed text-gray-600 dark:text-gray-300">
                              {c.astuce}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {analysisNotice && (
                <p className="mt-4 text-xs text-amber-700 dark:text-amber-400">{analysisNotice}</p>
              )}

              {typeof score === "number" && (
                <p
                  className="mt-5 text-xs text-gray-500 dark:text-gray-400 tabular-nums"
                  data-testid="score-line"
                >
                  Note de ce texte :{" "}
                  <span className="font-semibold text-gray-900 dark:text-white">
                    {nombre(score)}/20
                  </span>
                  {week && typeof week.score === "number" && (
                    <>
                      {" · "}Moyenne sur 7 jours :{" "}
                      <span className="font-semibold text-gray-900 dark:text-white">
                        {nombre(week.score)}/20
                      </span>{" "}
                      ({week.texts} {week.texts > 1 ? "textes" : "texte"})
                    </>
                  )}
                </p>
              )}

              {!actionsInHeader && (
                <>
                  <div className="mt-3">{message}</div>
                  <div className="mt-3 flex gap-3">{actions}</div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
