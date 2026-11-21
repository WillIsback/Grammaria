/**
 * Section « Ce que changent les astuces » de l'écran Progression (issue #33),
 * et le bouton d'export anonyme de la bêta (issue #34).
 *
 * Des phrases simples et un tableau : pour chaque faute qui a reçu une
 * astuce, son taux avant la première astuce et depuis, pour 1 000 mots, puis
 * la même chose pour les fautes de frappe, qui ne reçoivent jamais d'astuce.
 * Aucune information n'est portée par la seule couleur.
 */
import { useState } from "react";
import type {
  Mesure,
  MesureRegle,
  Periode,
  SyntheseGroupe,
} from "../../analysis/progression/mesure";
import { nombre } from "../../utils/format";
import { ExportDialog } from "./ExportDialog";
import { boutonSecondaire, card, cardHint, cardTitle, discret } from "./styles";

const pluriel = (n: number, un: string, plusieurs = `${un}s`) =>
  `${nombre(n, 0)} ${n > 1 ? plusieurs : un}`;

/** « 3,5 » fautes pour 1 000 mots ; « – » sans mot. */
const tauxTexte = (taux: number | null) => (taux === null ? "–" : nombre(taux));

/** Évolution relative en mots : « 65 % de moins », « 20 % de plus », « inchangé ». */
export function evolutionTexte(evolution: number | null): string {
  if (evolution === null) return "–";
  if (evolution === 0) return "inchangé";
  return evolution < 0
    ? `${nombre(-evolution, 0)} % de moins`
    : `${nombre(evolution, 0)} % de plus`;
}

/** Symbole de l'évolution, en plus des mots (jamais seul porteur d'information). */
const symbole = (evolution: number | null) =>
  evolution === null || evolution === 0 ? "" : evolution < 0 ? "↓ " : "↑ ";

function Volume({ periode }: { periode: Periode }) {
  return (
    <span className="block text-xs text-gray-600 dark:text-gray-400">
      {pluriel(periode.fautes, "faute")} sur {pluriel(periode.mots, "mot")} (
      {pluriel(periode.textes, "texte")})
    </span>
  );
}

function Ligne({ regle, mesure }: { regle: MesureRegle; mesure: Mesure }) {
  const unite = `pour ${nombre(mesure.motsParTaux, 0)} mots`;
  return (
    <tr className="align-top">
      <th
        scope="row"
        className="py-2.5 pr-3 text-left font-medium text-gray-900 dark:text-gray-100"
      >
        {regle.label}
        {regle.groupe === "comparaison" && (
          <span className="block text-xs font-normal text-gray-600 dark:text-gray-400">
            jamais d'astuce
          </span>
        )}
      </th>
      <td className="py-2.5 pr-3">
        {regle.avantTropCourt ? (
          <span className={discret}>
            trop peu de textes avant {regle.groupe === "suivie" ? "l'astuce" : "le seuil"} pour
            comparer
          </span>
        ) : (
          <>
            <span className="tabular-nums text-gray-900 dark:text-gray-100">
              {tauxTexte(regle.avant.taux)} {unite}
            </span>
            <Volume periode={regle.avant} />
          </>
        )}
      </td>
      <td className="py-2.5 pr-3">
        {regle.textesManquants > 0 ? (
          <span className={discret}>
            pas encore assez de textes depuis {regle.groupe === "suivie" ? "l'astuce" : "le seuil"}{" "}
            (il en manque {nombre(regle.textesManquants, 0)})
          </span>
        ) : (
          <>
            <span className="tabular-nums text-gray-900 dark:text-gray-100">
              {tauxTexte(regle.depuis.taux)} {unite}
            </span>
            <Volume periode={regle.depuis} />
          </>
        )}
      </td>
      <td className="py-2.5 tabular-nums text-gray-900 dark:text-gray-100">
        <span aria-hidden="true">{symbole(regle.evolution)}</span>
        {evolutionTexte(regle.evolution)}
      </td>
    </tr>
  );
}

/** Phrase de synthèse d'un groupe ; null s'il n'y a pas assez de textes. */
function phraseSynthese(s: SyntheseGroupe, motsParTaux: number, avant: string): string | null {
  if (s.reglesSuffisantes === 0 || s.avant.taux === null || s.depuis.taux === null) return null;
  const evolution = s.evolution === null ? "" : ` (${evolutionTexte(s.evolution)})`;
  return `${nombre(s.avant.taux)} fautes pour ${nombre(motsParTaux, 0)} mots ${avant}, ${nombre(s.depuis.taux)} depuis${evolution}`;
}

export function MesureAstuces({ mesure }: { mesure: Mesure }) {
  const [exportOuvert, setExportOuvert] = useState(false);
  const { suivies, comparaison, synthese } = mesure;
  const unite = `pour ${nombre(mesure.motsParTaux, 0)} mots`;
  const phraseSuivies = phraseSynthese(
    synthese.suivies,
    mesure.motsParTaux,
    "avant la première astuce",
  );
  const phraseComparaison = phraseSynthese(
    synthese.comparaison,
    mesure.motsParTaux,
    "avant d'avoir atteint le même seuil",
  );
  const choix = mesure.choix.justes + mesure.choix.fausses;

  return (
    <section aria-labelledby="progression-mesure" className={card}>
      <h3 id="progression-mesure" className={cardTitle}>
        Ce que changent les astuces
      </h3>
      <p className={cardHint}>
        Pour chaque faute qui a reçu une astuce : combien de fois elle revenait avant la première
        astuce, et combien depuis, {unite} écrits.
      </p>

      {suivies.length === 0 ? (
        <p className={`mt-3 ${discret}`}>
          Aucune astuce n'a encore été affichée. La mesure commencera après la première : une faute
          qui revient 3 fois en 7 jours reçoit une astuce près du bouton Copier.
        </p>
      ) : (
        <>
          <div className="mt-3 rounded-xl bg-brand-50 dark:bg-brand-500/10 px-4 py-3 space-y-1.5">
            <p className="text-sm font-medium text-gray-900 dark:text-white">
              {phraseSuivies
                ? `Fautes qui ont reçu une astuce (${pluriel(synthese.suivies.reglesSuffisantes, "règle mesurée", "règles mesurées")}) : ${phraseSuivies}.`
                : "Pas encore assez de textes depuis les premières astuces pour une synthèse."}
            </p>
            <p className="text-sm text-gray-700 dark:text-gray-300">
              {phraseComparaison
                ? `Pour comparer, les fautes de frappe, qui ne reçoivent jamais d'astuce : ${phraseComparaison}.`
                : comparaison.length === 0
                  ? "Pour comparer : les fautes de frappe, qui ne reçoivent jamais d'astuce, ne sont pas encore revenues assez souvent (3 fois en 7 jours)."
                  : "Pour comparer : pas encore assez de textes autour du moment où les fautes de frappe ont atteint le même seuil."}
            </p>
          </div>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">
                Fautes {unite}, avant la première astuce et depuis, faute par faute
              </caption>
              <thead>
                <tr className="text-left text-xs text-gray-600 dark:text-gray-400 border-b border-gray-100 dark:border-gray-800">
                  <th scope="col" className="py-2 pr-3 font-semibold">
                    Faute
                  </th>
                  <th scope="col" className="py-2 pr-3 font-semibold">
                    Avant la première astuce
                  </th>
                  <th scope="col" className="py-2 pr-3 font-semibold">
                    Depuis
                  </th>
                  <th scope="col" className="py-2 font-semibold">
                    Évolution
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {suivies.map((r) => (
                  <Ligne key={r.ruleKey} regle={r} mesure={mesure} />
                ))}
              </tbody>
              {comparaison.length > 0 && (
                <tbody className="border-t-2 border-gray-200 dark:border-gray-700">
                  <tr>
                    <th
                      scope="colgroup"
                      colSpan={4}
                      className="pt-3 pb-1 text-left text-xs font-semibold text-gray-600 dark:text-gray-400"
                    >
                      Pour comparer (avant et depuis le jour où elles ont atteint le même seuil)
                    </th>
                  </tr>
                  {comparaison.map((r) => (
                    <Ligne key={r.ruleKey} regle={r} mesure={mesure} />
                  ))}
                </tbody>
              )}
            </table>
          </div>
        </>
      )}

      <dl className="mt-4 grid gap-3 sm:grid-cols-2 text-sm">
        <div className="rounded-xl border border-gray-100 dark:border-gray-800 px-3 py-2.5">
          <dt className="text-xs text-gray-600 dark:text-gray-400">Choix du bouton Copier</dt>
          <dd className="mt-0.5 text-gray-900 dark:text-gray-100">
            {choix === 0
              ? "aucune réponse pour l'instant"
              : `${nombre(mesure.choix.justes, 0)} bonne${mesure.choix.justes > 1 ? "s" : ""} réponse${mesure.choix.justes > 1 ? "s" : ""} sur ${nombre(choix, 0)} (${mesure.choix.taux} %)`}
          </dd>
        </div>
        <div className="rounded-xl border border-gray-100 dark:border-gray-800 px-3 py-2.5">
          <dt className="text-xs text-gray-600 dark:text-gray-400">Règles acquises</dt>
          <dd className="mt-0.5 text-gray-900 dark:text-gray-100">
            {mesure.acquises.total === 0
              ? "aucune pour l'instant"
              : `${nombre(mesure.acquises.total, 0)}, dont ${nombre(mesure.acquises.restees, 0)} sans aucune rechute depuis`}
          </dd>
        </div>
      </dl>

      <aside
        aria-label="Limites de la mesure"
        className="mt-4 rounded-xl border-l-4 border-amber-400 bg-amber-50 dark:bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-100"
      >
        <p className="font-semibold">Ce n'est pas une preuve</p>
        <p className="mt-1">
          Peu de textes, pas de tirage au sort, et une faute qui vient de revenir plusieurs fois
          revient souvent moins ensuite, astuce ou pas. La comparaison avec les fautes de frappe,
          prises au même moment, en tient compte en partie seulement.
        </p>
      </aside>

      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <button
          type="button"
          onClick={() => setExportOuvert(true)}
          className={`px-4 py-2 ${boutonSecondaire}`}
        >
          Exporter mes résultats
        </button>
        <p className="text-xs text-gray-600 dark:text-gray-400">
          Pour les tests de Grammaria : un fichier de chiffres, sans aucun texte.
        </p>
      </div>
      {exportOuvert && <ExportDialog onClose={() => setExportOuvert(false)} />}
    </section>
  );
}
