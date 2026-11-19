import type { ReactNode } from "react";
import type { FormeChoix, Intervention, Reussite } from "../analysis/regles/intervention";
import { SEUILS } from "../analysis/regles/seuils";

interface Props {
  intervention: Intervention | null;
  reussites: Reussite[];
  /** Forme cliquée lors du choix à deux formes ; null tant qu'aucune ne l'est. */
  formeChoisie: FormeChoix | null;
}

const BOX = "mb-3 px-3.5 py-2.5 rounded-xl border text-[13px] leading-relaxed";
const NEUTRAL = `${BOX} bg-brand-50/70 border-brand-100 text-gray-700
  dark:bg-brand-500/10 dark:border-brand-500/20 dark:text-gray-200`;
const SUCCESS = `${BOX} bg-emerald-50/80 border-emerald-100 text-emerald-900
  dark:bg-emerald-500/10 dark:border-emerald-500/20 dark:text-emerald-100`;
const LABEL = "font-semibold text-gray-900 dark:text-white";

/**
 * Message discret affiché près du bouton Copier : question du choix à deux
 * formes, explication après une mauvaise réponse, astuce d'une règle
 * signalée, réussite d'une règle acquise. Jamais de fenêtre : la copie n'est
 * pas retardée. La zone `role="status"` reste dans la page même vide, pour
 * que son contenu soit annoncé quand il apparaît.
 */
export function InterventionMessage({ intervention, reussites, formeChoisie }: Props) {
  const blocs: ReactNode[] = [];

  if (intervention?.type === "choix") {
    const bonne = intervention.formes.find((f) => f.correcte)?.texte ?? "";
    if (!formeChoisie) {
      blocs.push(
        <p key="choix" className={NEUTRAL} data-testid="intervention-choix">
          <span className={LABEL}>Quelle forme est la bonne ?</span> « {intervention.avant}
          <span
            className="inline-block w-8 mx-0.5 border-b-2 border-brand-500 align-baseline"
            aria-hidden="true"
          />
          <span className="sr-only"> … </span>
          {intervention.apres} »{" "}
          <span className="text-gray-500 dark:text-gray-400">
            Les deux boutons copient le texte corrigé.
          </span>
        </p>,
      );
    } else if (formeChoisie.correcte) {
      blocs.push(
        <p key="juste" className={SUCCESS} data-testid="intervention-juste">
          <span className="font-semibold">Bonne réponse : « {bonne} ».</span> Le texte corrigé est
          copié.
        </p>,
      );
    } else {
      blocs.push(
        <p key="faux" className={NEUTRAL} data-testid="intervention-explication">
          <span className={LABEL}>
            Il fallait écrire « {bonne} », et non « {formeChoisie.texte} ».
          </span>{" "}
          {intervention.explication} Le texte corrigé est copié.
        </p>,
      );
    }
  } else if (intervention?.type === "astuce") {
    blocs.push(
      <p key="astuce" className={NEUTRAL} data-testid="intervention-astuce">
        <span className={LABEL}>Astuce · {intervention.titre}</span> — {intervention.texte}
      </p>,
    );
  }

  if (reussites.length > 0) {
    const titres = reussites.map((r) => `« ${r.titre} »`).join(", ");
    blocs.push(
      <p key="reussite" className={SUCCESS} data-testid="intervention-reussite">
        <span className="font-semibold">
          {reussites.length > 1 ? "Règles acquises" : "Règle acquise"} : {titres}.
        </span>{" "}
        Plus aucune faute depuis {SEUILS.acquisitionJoursSansFaute} jours, bravo !
      </p>,
    );
  }

  return (
    <div role="status" aria-live="polite">
      {blocs}
    </div>
  );
}
