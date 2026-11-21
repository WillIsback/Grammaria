import type React from "react";
import { useEffect, useRef } from "react";
import type { Progression, RegleResumee, Tendance } from "../../analysis/progression/calcul";
import type { EtatCycle } from "../../analysis/regles/cycle";
import { SEUILS } from "../../analysis/regles/seuils";
import { useChargement } from "../../hooks/useChargement";
import { fetchProgress } from "../../services/progress";
import { dateLongue, nombre } from "../../utils/format";
import { MasteryRing, WeeklyChart } from "./charts";

interface Props {
  /** Retour à l'écran de correction. */
  onClose: () => void;
  /**
   * Emplacement réservé à la galerie de badges (issue #16) : la section
   * « Badges » n'apparaît que si ce contenu est fourni.
   */
  badges?: React.ReactNode;
  /** Hauteur de l'en-tête (et du bandeau éventuel) sous lequel l'écran commence, en pixels. */
  top?: number;
  /** Le journal a changé quand cette valeur change (comparée par identité) : les données sont rechargées. */
  reloadKey?: unknown;
}

const card =
  "bg-white dark:bg-gray-900/70 rounded-2xl border border-gray-200/70 dark:border-gray-800 shadow-card p-4 sm:p-5 min-w-0";
const cardTitle = "text-sm font-semibold text-gray-900 dark:text-white";
const cardHint = "text-xs text-gray-600 dark:text-gray-400 mt-0.5";
/** Texte d'accompagnement : explications, listes vides. */
const discret = "text-sm text-gray-600 dark:text-gray-400";
const boutonPrincipal =
  "rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium transition-colors";
/** Partie remplie d'une barre de progression. */
const remplissage = "h-full rounded-full bg-brand-500 dark:bg-brand-400";

/** Libellés et sens des états du cycle de vie, avec un symbole qui ne dépend pas de la couleur. */
const ETATS: Record<
  EtatCycle,
  { libelle: string; singulier: string; sens: string; symbole: string; ton: string }
> = {
  observee: {
    libelle: "Observées",
    singulier: "observée",
    sens: "faute vue, sans intervention",
    symbole: "○",
    ton: "bg-gray-50 dark:bg-gray-800/60 text-gray-700 dark:text-gray-300",
  },
  signalee: {
    libelle: "Signalées",
    singulier: "signalée",
    sens: "faute qui revient : astuce proposée",
    symbole: "!",
    ton: "bg-amber-50 dark:bg-amber-500/10 text-amber-800 dark:text-amber-200",
  },
  travaillee: {
    libelle: "Travaillées",
    singulier: "travaillée",
    sens: "faute qui persiste : choix sur le bouton Copier",
    symbole: "●",
    ton: "bg-brand-50 dark:bg-brand-500/10 text-brand-800 dark:text-brand-200",
  },
  acquise: {
    libelle: "Acquises",
    singulier: "acquise",
    sens: `plus de faute depuis ${SEUILS.acquisitionJoursSansFaute} jours d'usage`,
    symbole: "✓",
    ton: "bg-emerald-50 dark:bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
  },
};

const TENDANCES: Record<Tendance, { symbole: string; texte: string; ton: string }> = {
  baisse: {
    symbole: "↓",
    texte: "en baisse : vous progressez",
    ton: "text-emerald-700 dark:text-emerald-300",
  },
  hausse: { symbole: "↑", texte: "en hausse", ton: "text-amber-700 dark:text-amber-300" },
  stable: { symbole: "→", texte: "stable", ton: "text-gray-600 dark:text-gray-300" },
};

const pluriel = (n: number, un: string, plusieurs = `${un}s`) =>
  `${nombre(n, 0)} ${n > 1 ? plusieurs : un}`;

/** Sous-titre d'un total : tout est dans les semaines affichées, ou une partie seulement. */
const depuis = (total: number, periode: number, semaines: number) =>
  total === periode
    ? "depuis votre premier texte"
    : `dont ${nombre(periode, 0)} sur les ${semaines} dernières semaines`;

const note = (score: number | null) => (score === null ? "–" : `${nombre(score)}/20`);

export function ProgressionScreen({ onClose, badges, top = 64, reloadKey }: Props) {
  // `reloadKey` : rechargement demandé par l'appelant, l'affichage reste en place.
  const { data, erreur, reessayer } = useChargement(fetchProgress, reloadKey);
  const titleRef = useRef<HTMLHeadingElement>(null);

  // Le focus va au titre de l'écran, puis revient au bouton d'ouverture à la fermeture.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    titleRef.current?.focus();
    return () => opener?.focus();
  }, []);

  // Échap ramène à la correction (sauf si une fenêtre de dialogue est ouverte).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector("[role=dialog]")) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      style={{ top }}
      className="fixed inset-x-0 bottom-0 z-30 overflow-y-auto overscroll-contain bg-[#f7f9fc] dark:bg-gray-950"
    >
      <section
        aria-labelledby="progression-titre"
        className="max-w-5xl mx-auto px-4 sm:px-6 py-5 sm:py-8"
      >
        <button
          type="button"
          onClick={onClose}
          className="inline-flex items-center gap-1.5 -ml-2 px-2 py-1.5 rounded-lg text-sm font-medium
            text-brand-700 dark:text-brand-300 hover:bg-brand-50 dark:hover:bg-brand-500/10
            focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 transition-colors"
        >
          <svg
            aria-hidden="true"
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            strokeWidth={2.2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M15 18l-6-6 6-6" />
          </svg>
          Retour à la correction
        </button>

        <div className="mt-3 mb-5 sm:mb-6">
          <h2
            id="progression-titre"
            ref={titleRef}
            tabIndex={-1}
            className="text-xl sm:text-2xl font-semibold tracking-tight text-gray-900 dark:text-white focus:outline-none"
          >
            Ma progression
          </h2>
          <p className={`${discret} mt-1`}>
            Calculée à partir de votre journal des fautes, sur les {data ? data.weeks : 12}{" "}
            dernières semaines.
          </p>
        </div>

        {erreur ? (
          <div className={`${card} text-center py-10`} role="alert">
            <p className="text-sm text-gray-700 dark:text-gray-300">
              La progression n'a pas pu être chargée.
            </p>
            <button
              type="button"
              onClick={reessayer}
              className={`mt-4 px-4 py-2 ${boutonPrincipal}`}
            >
              Réessayer
            </button>
          </div>
        ) : !data ? (
          <p role="status" className={`${discret} py-10 text-center`}>
            Chargement de votre progression…
          </p>
        ) : data.empty ? (
          <EmptyState onClose={onClose} />
        ) : (
          <Contenu data={data} badges={badges} />
        )}
      </section>
    </div>
  );
}

function EmptyState({ onClose }: { onClose: () => void }) {
  return (
    <div className={`${card} text-center py-12 px-6`}>
      <div className="w-16 h-16 mx-auto rounded-2xl bg-brand-50 dark:bg-brand-500/10 flex items-center justify-center mb-4">
        <svg
          aria-hidden="true"
          className="w-7 h-7 text-brand-600 dark:text-brand-400"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 3v18h18" />
          <path d="M7 15l4-4 3 3 5-6" />
        </svg>
      </div>
      <h3 className="text-base font-semibold text-gray-900 dark:text-white">
        Aucun texte corrigé pour l'instant
      </h3>
      <p className={`mt-2 ${discret} max-w-md mx-auto`}>
        Chaque texte que vous corrigez est noté dans votre journal. Après quelques textes, vous
        verrez ici votre note semaine après semaine, vos fautes les plus fréquentes et les règles
        que vous maîtrisez.
      </p>
      <button
        type="button"
        onClick={onClose}
        className={`mt-6 px-5 py-2.5 ${boutonPrincipal} shadow-sm shadow-brand-500/20`}
      >
        Corriger un premier texte
      </button>
    </div>
  );
}

function Contenu({ data, badges }: { data: Progression; badges?: React.ReactNode }) {
  const { mastery, recent, previous, trend, totals, period } = data;
  return (
    <div className="space-y-4 sm:space-y-5">
      <div className="grid gap-4 sm:gap-5 md:grid-cols-5">
        <Maitrise data={data} />

        <div className="md:col-span-3 grid grid-cols-2 gap-3 sm:gap-4">
          <Tuile
            titre="Note moyenne"
            valeur={note(period.score)}
            detail={
              <>
                sur {data.weeks} semaines
                <span className="block">
                  {mastery.recentWeeks} dernières semaines : {note(recent.score)}
                </span>
              </>
            }
          />
          <Tuile
            titre="Fautes pour 100 mots"
            valeur={recent.faultsPer100 === null ? "–" : nombre(recent.faultsPer100)}
            detail={
              <>
                {mastery.recentWeeks} dernières semaines
                {trend && (
                  <span className={`block font-medium ${TENDANCES[trend].ton}`}>
                    <span aria-hidden="true">{TENDANCES[trend].symbole} </span>
                    {TENDANCES[trend].texte}
                    {previous.faultsPer100 !== null && (
                      <span className="font-normal text-gray-600 dark:text-gray-400">
                        {" "}
                        (avant : {nombre(previous.faultsPer100)})
                      </span>
                    )}
                  </span>
                )}
              </>
            }
          />
          <Tuile
            titre="Textes corrigés"
            valeur={nombre(totals.texts, 0)}
            detail={depuis(totals.texts, period.texts, data.weeks)}
          />
          <Tuile
            titre="Mots corrigés"
            valeur={nombre(totals.words, 0)}
            detail={depuis(totals.words, period.words, data.weeks)}
          />
        </div>
      </div>

      <div className="grid gap-4 sm:gap-5 lg:grid-cols-2">
        <div className={card}>
          <h3 className={cardTitle}>Note moyenne par semaine</h3>
          <p className={cardHint}>Sur 20 ; une barre plus haute, c'est mieux.</p>
          <div className="mt-3">
            <WeeklyChart
              kind="bars"
              title="Note moyenne sur 20, par semaine"
              description={descriptionSerie(
                data,
                data.series.map((s) => s.score),
                (v) => `${nombre(v)} sur 20`,
              )}
              points={data.series.map((s) => ({ start: s.start, value: s.score }))}
              max={20}
              ticks={[0, 10, 20]}
              format={nombre}
              valueLabel="Note sur 20"
            />
          </div>
        </div>
        <div className={card}>
          <h3 className={cardTitle}>Fautes pour 100 mots, par semaine</h3>
          <p className={cardHint}>Une courbe qui descend, c'est mieux.</p>
          <div className="mt-3">
            <WeeklyChart
              kind="line"
              title="Fautes pour 100 mots, par semaine"
              description={descriptionSerie(
                data,
                data.series.map((s) => s.faultsPer100),
                (v) => `${nombre(v)} fautes pour 100 mots`,
              )}
              points={data.series.map((s) => ({ start: s.start, value: s.faultsPer100 }))}
              format={nombre}
              valueLabel="Fautes pour 100 mots"
            />
          </div>
        </div>
      </div>

      <Regles data={data} />

      <ReglesFrequentes data={data} />

      {/* Pas de cadre autour de la galerie : chaque badge est déjà une carte. */}
      {badges && (
        <div data-testid="progression-badges" className="pt-3 sm:pt-4">
          {badges}
        </div>
      )}
    </div>
  );
}

/** Résumé en phrase d'une série, pour la description du graphique. */
function descriptionSerie(
  data: Progression,
  values: (number | null)[],
  format: (v: number) => string,
): string {
  const remplies = values.filter((v): v is number => v !== null);
  if (remplies.length === 0) return "Aucun texte corrigé sur la période.";
  const premiere = remplies[0];
  const derniere = remplies[remplies.length - 1];
  return `${remplies.length} semaines avec des textes sur ${data.weeks}. Première valeur : ${format(premiere)} ; dernière : ${format(derniere)}. Le détail est dans le tableau qui suit.`;
}

function Tuile({
  titre,
  valeur,
  detail,
}: {
  titre: string;
  valeur: string;
  detail: React.ReactNode;
}) {
  return (
    <div className={`${card} !p-3.5 sm:!p-4`}>
      <p className="text-[11px] font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wider">
        {titre}
      </p>
      <p className="mt-1 text-2xl font-semibold text-gray-900 dark:text-white tabular-nums break-words">
        {valeur}
      </p>
      <div className="mt-1 text-xs text-gray-600 dark:text-gray-400">{detail}</div>
    </div>
  );
}

function Maitrise({ data }: { data: Progression }) {
  const m = data.mastery;
  const poidsQualite = Math.round(m.weights.quality * 100);
  const poidsRegles = Math.round(m.weights.rules * 100);
  return (
    <section aria-labelledby="progression-maitrise" className={`${card} md:col-span-2`}>
      <h3 id="progression-maitrise" className={cardTitle}>
        Score de maîtrise
      </h3>
      {m.score === null ? (
        <div className="mt-3">
          <p className="text-lg font-semibold text-gray-900 dark:text-white">
            Pas encore assez de textes
          </p>
          <p className={`mt-1 ${discret}`}>
            Le score apparaît dès que vous avez corrigé au moins {m.minimum.texts} textes et{" "}
            {nombre(m.minimum.words, 0)} mots sur les {m.recentWeeks} dernières semaines. Pour
            l'instant : {pluriel(m.recent.texts, "texte")} et {pluriel(m.recent.words, "mot")}.
          </p>
          <Jauge label="Textes" valeur={m.recent.texts} objectif={m.minimum.texts} unite="textes" />
          <Jauge label="Mots" valeur={m.recent.words} objectif={m.minimum.words} unite="mots" />
        </div>
      ) : (
        <>
          <div className="mt-3 flex items-center gap-4">
            <MasteryRing score={m.score} />
            <div className="min-w-0">
              <p className="sr-only">
                Score de maîtrise : {m.score} sur 100, {m.level}.
              </p>
              <p
                className="text-lg font-semibold text-gray-900 dark:text-white leading-snug"
                aria-hidden="true"
              >
                {m.level}
              </p>
              <dl className="mt-2 space-y-1 text-sm">
                <div className="flex flex-wrap gap-x-1.5">
                  <dt className="text-gray-600 dark:text-gray-400">Qualité récente :</dt>
                  <dd className="font-medium text-gray-900 dark:text-gray-100 tabular-nums">
                    {m.quality}/100
                  </dd>
                </div>
                <div className="flex flex-wrap gap-x-1.5">
                  <dt className="text-gray-600 dark:text-gray-400">Règles acquises :</dt>
                  <dd className="font-medium text-gray-900 dark:text-gray-100 tabular-nums">
                    {m.inCycle === 0 ? "aucune à travailler" : `${m.acquired} sur ${m.inCycle}`}
                  </dd>
                </div>
              </dl>
            </div>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-gray-600 dark:text-gray-400">
            {m.inCycle === 0
              ? `Ce score reflète la qualité de vos textes des ${m.recentWeeks} dernières semaines (votre note moyenne ramenée sur 100). Dès qu'une faute reviendra souvent, la part des règles acquises comptera aussi.`
              : `Ce score combine la qualité de vos textes des ${m.recentWeeks} dernières semaines (${poidsQualite} %) et la part des règles acquises parmi celles qui vous ont posé problème (${poidsRegles} %).`}{" "}
            Écrire plus ne le fait jamais baisser : seule la proportion de fautes compte.
          </p>
        </>
      )}
    </section>
  );
}

function Jauge({
  label,
  valeur,
  objectif,
  unite,
}: {
  label: string;
  valeur: number;
  objectif: number;
  unite: string;
}) {
  const part = Math.min(1, valeur / objectif);
  return (
    <div className="mt-3">
      <div className="flex justify-between text-xs text-gray-600 dark:text-gray-400">
        <span>{label}</span>
        <span className="tabular-nums">
          {nombre(Math.min(valeur, objectif), 0)} / {nombre(objectif, 0)} {unite}
        </span>
      </div>
      <div
        className="mt-1 h-2 rounded-full bg-gray-200 dark:bg-gray-800 overflow-hidden"
        role="progressbar"
        aria-label={`${label} corrigés sur les dernières semaines`}
        aria-valuemin={0}
        aria-valuemax={objectif}
        aria-valuenow={Math.min(valeur, objectif)}
      >
        <div className={remplissage} style={{ width: `${part * 100}%` }} />
      </div>
    </div>
  );
}

function Regles({ data }: { data: Progression }) {
  const { counts, active, acquired } = data.rules;
  return (
    <section aria-labelledby="progression-regles" className={card}>
      <h3 id="progression-regles" className={cardTitle}>
        Vos règles
      </h3>
      <p className={cardHint}>
        Chaque règle sur laquelle vous avez fait une faute passe par ces états. L'état « acquise »
        est mis à jour à chaque correction.
      </p>
      <ul className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
        {(Object.keys(ETATS) as EtatCycle[]).map((etat) => (
          <li key={etat} className={`rounded-xl px-3 py-2.5 ${ETATS[etat].ton}`}>
            <div className="flex items-baseline gap-1.5">
              <span aria-hidden="true" className="text-sm">
                {ETATS[etat].symbole}
              </span>
              <span className="text-xl font-semibold tabular-nums">{counts[etat]}</span>
              <span className="text-sm font-medium">{ETATS[etat].libelle}</span>
            </div>
            <p className="text-[11px] leading-snug opacity-90 mt-0.5">{ETATS[etat].sens}</p>
          </li>
        ))}
      </ul>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <ListeRegles
          titre="À travailler"
          vide="Aucune faute ne revient souvent en ce moment."
          regles={active}
          detail={(r) =>
            `${ETATS[r.state].singulier} · ${pluriel(r.occurrences, "faute")} · dernière le ${dateLongue(r.lastFaultAt, false)}`
          }
        />
        <ListeRegles
          titre="Acquises"
          vide={`Pas encore de règle acquise : elles apparaîtront ici après ${SEUILS.acquisitionJoursSansFaute} jours d'usage sans faute.`}
          regles={acquired}
          detail={(r) =>
            `acquise le ${dateLongue(r.acquiredAt ?? r.stateSince, false)} · ${pluriel(r.occurrences, "faute")} avant`
          }
        />
      </div>
    </section>
  );
}

function ListeRegles({
  titre,
  vide,
  regles,
  detail,
}: {
  titre: string;
  vide: string;
  regles: RegleResumee[];
  detail: (r: RegleResumee) => string;
}) {
  return (
    <div className="min-w-0">
      <h4 className="text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wider">
        {titre} ({regles.length})
      </h4>
      {regles.length === 0 ? (
        <p className={`mt-2 ${discret}`}>{vide}</p>
      ) : (
        <ul className="mt-2 divide-y divide-gray-100 dark:divide-gray-800">
          {regles.map((r) => (
            <li key={r.ruleKey} className="py-2 flex items-start gap-2.5">
              <span
                aria-hidden="true"
                className={`mt-0.5 w-6 h-6 shrink-0 rounded-lg flex items-center justify-center text-xs ${ETATS[r.state].ton}`}
              >
                {ETATS[r.state].symbole}
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 break-words">
                  {r.label}
                </p>
                <p className="text-xs text-gray-600 dark:text-gray-400">{detail(r)}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ReglesFrequentes({ data }: { data: Progression }) {
  const max = Math.max(1, ...data.frequentRules.map((r) => r.count));
  return (
    <section aria-labelledby="progression-frequentes" className={card}>
      <h3 id="progression-frequentes" className={cardTitle}>
        Règles les plus fréquentes
      </h3>
      <p className={cardHint}>
        Fautes comptées dans la note, sur {data.weeks} semaines. Les fautes de frappe y figurent
        aussi, mais ne reçoivent jamais d'astuce.
      </p>
      {data.frequentRules.length === 0 ? (
        <p className={`mt-3 ${discret}`}>Aucune faute sur la période. Bravo !</p>
      ) : (
        <ol className="mt-3 space-y-2.5">
          {data.frequentRules.map((r) => (
            <li key={r.ruleKey} className="min-w-0">
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 break-words text-gray-900 dark:text-gray-100">
                  {r.label}
                  {r.state && (
                    <span className="ml-1.5 text-xs text-gray-600 dark:text-gray-400">
                      ({ETATS[r.state].singulier})
                    </span>
                  )}
                </span>
                <span className="shrink-0 tabular-nums font-medium text-gray-900 dark:text-gray-100">
                  {pluriel(r.count, "fois", "fois")}
                </span>
              </div>
              <div
                className="mt-1 h-1.5 rounded-full bg-gray-100 dark:bg-gray-800"
                aria-hidden="true"
              >
                <div className={remplissage} style={{ width: `${(r.count / max) * 100}%` }} />
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
