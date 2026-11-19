/**
 * Graphiques de l'écran « Progression », en SVG écrit à la main.
 *
 * Chaque graphique porte un titre et une description (lus par les lecteurs
 * d'écran), et ses valeurs restent lisibles en texte dans un tableau
 * dépliable : la couleur n'est jamais seule porteuse d'information.
 */
import { useEffect, useId, useRef, useState } from "react";

/** Une valeur hebdomadaire ; null : aucun texte corrigé cette semaine-là. */
export interface Point {
  start: number;
  value: number | null;
}

const formatSemaine = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" });
const formatSemaineCourt = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit" });

/** « 16 nov. » : lundi de la semaine. */
export function libelleSemaine(start: number): string {
  return formatSemaine.format(new Date(start));
}

/** Nombre au format français, avec au plus `chiffres` décimales. */
export function nombre(n: number, chiffres = 1): string {
  return n.toLocaleString("fr-FR", { maximumFractionDigits: chiffres });
}

/** Largeur réelle du conteneur, pour garder un texte lisible à toutes les tailles. */
function useLargeur(defaut = 640) {
  const ref = useRef<HTMLDivElement>(null);
  const [largeur, setLargeur] = useState(defaut);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width);
      if (w > 0) setLargeur(w);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, largeur };
}

interface ChartProps {
  title: string;
  description: string;
  points: Point[];
  /** Valeur maximale de l'axe ; calculée sur les données si absente. */
  max?: number;
  /** Graduations de l'axe vertical. */
  ticks?: number[];
  /** Mise en forme d'une valeur (axe, infobulle, tableau). */
  format: (value: number) => string;
  /** Intitulé de la colonne des valeurs dans le tableau. */
  valueLabel: string;
  kind: "bars" | "line";
}

const HAUTEUR = 200;
const MARGE = { haut: 16, droite: 12, bas: 28, gauche: 34 };

/** Graduation « ronde » au-dessus du maximum (1, 2, 5 × 10ⁿ). */
export function niceMax(value: number): number {
  if (value <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(value));
  for (const m of [1, 2, 2.5, 5, 10]) if (value <= m * p) return m * p;
  return 10 * p;
}

export function WeeklyChart({
  title,
  description,
  points,
  max,
  ticks,
  format,
  valueLabel,
  kind,
}: ChartProps) {
  const id = useId();
  const { ref, largeur } = useLargeur();
  const values = points.map((p) => p.value).filter((v): v is number => v !== null);
  const haut = max ?? niceMax(Math.max(0, ...values));
  const graduations = ticks ?? [0, haut / 2, haut];

  const w = Math.max(largeur, 240);
  const innerW = w - MARGE.gauche - MARGE.droite;
  const innerH = HAUTEUR - MARGE.haut - MARGE.bas;
  const pas = innerW / points.length;
  const x = (i: number) => MARGE.gauche + pas * (i + 0.5);
  const y = (v: number) => MARGE.haut + innerH * (1 - Math.min(v, haut) / haut);
  // Sur un écran étroit, une étiquette de semaine sur deux (en partant de la plus récente).
  const etiquetteTous = pas >= 44 ? 1 : pas >= 24 ? 2 : 3;
  const largeurBarre = Math.min(28, pas * 0.6);

  // Segments de la courbe : interrompus par les semaines sans texte.
  const segments: string[] = [];
  let courant: string[] = [];
  points.forEach((p, i) => {
    if (p.value === null) {
      if (courant.length) segments.push(courant.join(" "));
      courant = [];
    } else courant.push(`${courant.length ? "L" : "M"}${x(i)},${y(p.value)}`);
  });
  if (courant.length) segments.push(courant.join(" "));

  const dernier = [...points].reverse().find((p) => p.value !== null);

  return (
    <figure className="m-0">
      <div ref={ref} className="w-full">
        <svg
          role="img"
          aria-labelledby={`${id}-t ${id}-d`}
          width={w}
          height={HAUTEUR}
          viewBox={`0 0 ${w} ${HAUTEUR}`}
          className="block max-w-full h-auto overflow-visible"
        >
          <title id={`${id}-t`}>{title}</title>
          <desc id={`${id}-d`}>{description}</desc>

          {graduations.map((t) => (
            <g key={t}>
              <line
                x1={MARGE.gauche}
                x2={w - MARGE.droite}
                y1={y(t)}
                y2={y(t)}
                className={
                  t === 0
                    ? "stroke-gray-300 dark:stroke-gray-600"
                    : "stroke-gray-200 dark:stroke-gray-800"
                }
                strokeDasharray={t === 0 ? undefined : "3 4"}
              />
              <text
                x={MARGE.gauche - 8}
                y={y(t)}
                dy="0.32em"
                textAnchor="end"
                className="fill-gray-500 dark:fill-gray-400 text-[11px] tabular-nums"
              >
                {format(t)}
              </text>
            </g>
          ))}

          {points.map((p, i) => {
            const montrer = (points.length - 1 - i) % etiquetteTous === 0;
            return (
              <g key={p.start}>
                {montrer && (
                  <text
                    x={x(i)}
                    y={HAUTEUR - 8}
                    textAnchor="middle"
                    className="fill-gray-500 dark:fill-gray-400 text-[11px]"
                  >
                    {formatSemaineCourt.format(new Date(p.start))}
                  </text>
                )}
                {p.value === null && (
                  <text
                    x={x(i)}
                    y={y(0) - 6}
                    textAnchor="middle"
                    className="fill-gray-400 dark:fill-gray-500 text-[11px]"
                    aria-hidden="true"
                  >
                    –
                  </text>
                )}
                {kind === "bars" && p.value !== null && (
                  <path
                    d={barre(x(i) - largeurBarre / 2, y(p.value), largeurBarre, y(0) - y(p.value))}
                    className="fill-brand-500 dark:fill-brand-400"
                  >
                    <title>{`Semaine du ${libelleSemaine(p.start)} : ${format(p.value)}`}</title>
                  </path>
                )}
              </g>
            );
          })}

          {kind === "line" &&
            segments.map((d) => (
              <path
                key={d}
                d={d}
                fill="none"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                className="stroke-brand-500 dark:stroke-brand-400"
              />
            ))}
          {kind === "line" &&
            points.map((p, i) =>
              p.value === null ? null : (
                <circle
                  key={p.start}
                  cx={x(i)}
                  cy={y(p.value)}
                  r={4}
                  strokeWidth={2}
                  className="fill-brand-500 dark:fill-brand-400 stroke-white dark:stroke-gray-900"
                >
                  <title>{`Semaine du ${libelleSemaine(p.start)} : ${format(p.value)}`}</title>
                </circle>
              ),
            )}

          {dernier?.value != null && (
            <text
              x={x(points.indexOf(dernier))}
              y={y(dernier.value) - 10}
              textAnchor="middle"
              className="fill-gray-900 dark:fill-gray-100 text-[12px] font-semibold tabular-nums"
            >
              {format(dernier.value)}
            </text>
          )}
        </svg>
      </div>

      <details className="mt-2 group">
        <summary className="cursor-pointer select-none text-xs font-medium text-brand-700 dark:text-brand-300 hover:underline w-fit">
          Voir les valeurs semaine par semaine
        </summary>
        <div className="mt-2 max-h-64 overflow-y-auto rounded-xl border border-gray-200/70 dark:border-gray-700/60">
          <table className="w-full text-sm">
            <caption className="sr-only">{title}</caption>
            <thead className="bg-gray-50 dark:bg-gray-800/60 text-gray-600 dark:text-gray-300">
              <tr>
                <th scope="col" className="text-left font-medium px-3 py-1.5">
                  Semaine du
                </th>
                <th scope="col" className="text-right font-medium px-3 py-1.5">
                  {valueLabel}
                </th>
              </tr>
            </thead>
            <tbody>
              {[...points].reverse().map((p) => (
                <tr key={p.start} className="border-t border-gray-100 dark:border-gray-800">
                  <th
                    scope="row"
                    className="text-left font-normal px-3 py-1.5 text-gray-700 dark:text-gray-300"
                  >
                    {libelleSemaine(p.start)}
                  </th>
                  <td className="text-right px-3 py-1.5 tabular-nums text-gray-900 dark:text-gray-100">
                    {p.value === null ? "aucun texte" : format(p.value)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

/** Barre aux coins supérieurs arrondis (4 px), posée sur la ligne de base. */
function barre(x: number, y: number, w: number, h: number): string {
  if (h <= 0) return "";
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

/** Anneau du score de maîtrise ; le chiffre et le palier sont écrits au centre et à côté. */
export function MasteryRing({ score }: { score: number }) {
  const r = 52;
  const circonference = 2 * Math.PI * r;
  const plein = (Math.max(0, Math.min(100, score)) / 100) * circonference;
  return (
    <svg viewBox="0 0 128 128" className="w-32 h-32 shrink-0" aria-hidden="true">
      <circle
        cx="64"
        cy="64"
        r={r}
        fill="none"
        strokeWidth="12"
        className="stroke-gray-200 dark:stroke-gray-800"
      />
      <circle
        cx="64"
        cy="64"
        r={r}
        fill="none"
        strokeWidth="12"
        strokeLinecap="round"
        strokeDasharray={`${plein} ${circonference}`}
        transform="rotate(-90 64 64)"
        className="stroke-brand-500 dark:stroke-brand-400"
      />
      <text
        x="64"
        y="62"
        textAnchor="middle"
        className="fill-gray-900 dark:fill-white text-[34px] font-semibold tabular-nums"
      >
        {score}
      </text>
      <text
        x="64"
        y="84"
        textAnchor="middle"
        className="fill-gray-500 dark:fill-gray-400 text-[12px]"
      >
        sur 100
      </text>
    </svg>
  );
}
