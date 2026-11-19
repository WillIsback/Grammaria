import { useCallback, useEffect, useId, useState } from "react";
import { type BadgeVue, type CatalogueBadges, fetchBadges } from "../services/badges";
import { BadgeIcon } from "./BadgeIcon";

const nombre = (n: number) => n.toLocaleString("fr-FR", { maximumFractionDigits: 1 });

/** « 12 mars 2026 ». */
export function formatDateBadge(at: number): string {
  return new Date(at).toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** Progression en clair : « 7 textes sur 10 », « 16,4 sur 20, objectif 18 ». */
export function progressionEnClair(badge: BadgeVue): string {
  const { valeur, seuil } = badge.progression;
  if (badge.mesure === "noteMoyenne") {
    return valeur > 0
      ? `Note moyenne actuelle : ${nombre(valeur)} sur 20, objectif ${nombre(seuil)}`
      : `Pas encore de note moyenne, objectif ${nombre(seuil)} sur 20`;
  }
  const unite = seuil > 1 ? badge.unite.pluriel : badge.unite.singulier;
  return `${nombre(Math.min(valeur, seuil))} sur ${nombre(seuil)} ${unite}`;
}

function Medaille({ badge }: { badge: BadgeVue }) {
  return (
    <div className="relative shrink-0 self-start">
      <div
        className={`w-12 h-12 rounded-full flex items-center justify-center ${
          badge.obtenu
            ? "bg-brand-600 dark:bg-brand-500 text-white shadow-sm shadow-brand-500/30"
            : "bg-gray-50 dark:bg-gray-800/70 text-gray-400 dark:text-gray-500 border border-dashed border-gray-300 dark:border-gray-600"
        }`}
      >
        <BadgeIcon mesure={badge.mesure} />
      </div>
      {badge.obtenu && (
        // Coche : l'état « obtenu » ne repose pas sur la seule couleur.
        <span className="absolute -bottom-0.5 -right-0.5 w-5 h-5 rounded-full bg-white dark:bg-gray-900 flex items-center justify-center">
          <svg
            aria-hidden="true"
            focusable="false"
            className="w-4 h-4 text-emerald-600 dark:text-emerald-400"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={3}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5 12.5l4.5 4.5L19 7.5" />
          </svg>
        </span>
      )}
    </div>
  );
}

function CarteBadge({ badge }: { badge: BadgeVue }) {
  const titreId = useId();
  const { valeur, seuil, detail } = badge.progression;
  const ratio = Math.max(
    0,
    Math.min(1, badge.progression.ratio ?? (seuil > 0 ? valeur / seuil : 0)),
  );
  const enClair = progressionEnClair(badge);

  return (
    <li
      aria-labelledby={titreId}
      className={`flex gap-3.5 p-4 rounded-2xl border transition-colors ${
        badge.obtenu
          ? "bg-white dark:bg-gray-900 border-brand-200/80 dark:border-brand-500/30 shadow-card"
          : "bg-white/60 dark:bg-gray-900/40 border-gray-200/80 dark:border-gray-800"
      }`}
    >
      <Medaille badge={badge} />
      <div className="min-w-0 flex-1">
        <h5
          id={titreId}
          className={`text-sm font-semibold leading-snug ${
            badge.obtenu ? "text-gray-900 dark:text-white" : "text-gray-700 dark:text-gray-200"
          }`}
        >
          {badge.titre}
        </h5>
        {badge.obtenu && badge.obtenuLe !== null ? (
          <>
            <p className="mt-1 text-[13px] leading-relaxed text-gray-600 dark:text-gray-300">
              {badge.description}
            </p>
            <p className="mt-2 text-xs font-medium text-emerald-700 dark:text-emerald-400">
              Obtenu le {formatDateBadge(badge.obtenuLe)}
            </p>
          </>
        ) : (
          <>
            <p className="mt-1 text-[13px] leading-relaxed text-gray-500 dark:text-gray-400">
              <span className="sr-only">À venir. </span>
              {badge.critere}
            </p>
            <div className="mt-3">
              <div
                role="progressbar"
                aria-labelledby={titreId}
                aria-valuemin={0}
                aria-valuemax={seuil}
                aria-valuenow={Math.round(ratio * seuil * 10) / 10}
                aria-valuetext={detail ? `${enClair}. ${detail}` : enClair}
                className="h-1.5 rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden"
              >
                <div
                  className="h-full rounded-full bg-brand-500 dark:bg-brand-400"
                  style={{ width: `${Math.round(ratio * 100)}%` }}
                />
              </div>
              <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400 tabular-nums">
                {enClair}
              </p>
              {detail && (
                <p className="mt-0.5 text-xs text-gray-400 dark:text-gray-500">{detail}</p>
              )}
            </div>
          </>
        )}
      </div>
    </li>
  );
}

/**
 * Galerie des badges de progression, regroupés par famille : badges obtenus
 * avec leur date, badges à venir avec leur critère et leur progression.
 * Charge elle-même le catalogue (`GET /api/badges`).
 */
export function BadgeGallery() {
  const [catalogue, setCatalogue] = useState<CatalogueBadges | null>(null);
  const [erreur, setErreur] = useState(false);
  const titreId = useId();

  // Incrémenté par « Réessayer » pour relancer le chargement.
  const [essai, setEssai] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    fetchBadges(controller.signal)
      .then(setCatalogue)
      .catch((e: unknown) => {
        if (e instanceof Error && e.name === "AbortError") return;
        setErreur(true);
      });
    return () => controller.abort();
  }, [essai]);

  const reessayer = useCallback(() => {
    setErreur(false);
    setEssai((n) => n + 1);
  }, []);

  return (
    <section aria-labelledby={titreId} className="w-full">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 mb-4">
        <h3 id={titreId} className="text-base font-semibold text-gray-900 dark:text-white">
          Badges
        </h3>
        {catalogue && (
          <p className="text-sm text-gray-500 dark:text-gray-400 tabular-nums">
            {catalogue.obtenus} obtenu{catalogue.obtenus > 1 ? "s" : ""} sur {catalogue.total}
          </p>
        )}
      </div>

      {!catalogue && !erreur && (
        <p role="status" className="text-sm text-gray-500 dark:text-gray-400">
          Chargement des badges…
        </p>
      )}

      {erreur && (
        <div className="flex flex-wrap items-center gap-3 text-sm text-gray-600 dark:text-gray-300">
          <p role="status">Les badges n'ont pas pu être chargés.</p>
          <button
            type="button"
            onClick={reessayer}
            className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-sm font-medium
              hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
          >
            Réessayer
          </button>
        </div>
      )}

      {catalogue && (
        <div className="space-y-6">
          {catalogue.familles.map((famille) => {
            const badges = catalogue.badges.filter((b) => b.famille === famille.id);
            if (badges.length === 0) return null;
            const obtenus = badges.filter((b) => b.obtenu).length;
            const familleId = `${titreId}-${famille.id}`;
            return (
              <section key={famille.id} aria-labelledby={familleId}>
                <div className="flex items-baseline justify-between gap-3 mb-2.5">
                  <h4
                    id={familleId}
                    className="text-[11px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                  >
                    {famille.titre}
                  </h4>
                  <span className="text-xs text-gray-400 dark:text-gray-500 tabular-nums">
                    {obtenus} sur {badges.length}
                    <span className="sr-only"> obtenus</span>
                  </span>
                </div>
                <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {badges.map((badge) => (
                    <CarteBadge key={badge.id} badge={badge} />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </section>
  );
}
