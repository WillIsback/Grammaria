import { useState } from "react";
import type { FormeChoix } from "../analysis/regles/intervention";
import type { QuestionRevision } from "../analysis/regles/revision";

interface Props {
  question: QuestionRevision;
  /** Forme cliquée : vraie si c'est la bonne. Appelé une seule fois. */
  onAnswer: (correct: boolean) => void;
}

const BOX = "mb-3 px-3.5 py-2.5 rounded-xl border text-[13px] leading-relaxed";
const NEUTRAL = `${BOX} bg-brand-50/70 border-brand-100 text-gray-700
  dark:bg-brand-500/10 dark:border-brand-500/20 dark:text-gray-200`;
const SUCCESS = `${BOX} bg-emerald-50/80 border-emerald-100 text-emerald-900
  dark:bg-emerald-500/10 dark:border-emerald-500/20 dark:text-emerald-100`;
const LABEL = "font-semibold text-gray-900 dark:text-white";

/**
 * Question de révision posée pendant que le modèle écrit (issue #62) : une
 * phrase d'exemple à trou et deux formes. Elle ne bloque rien et ne touche pas
 * au bouton Copier ; l'appelant la retire quand le texte corrigé est prêt.
 */
export function RevisionQuestion({ question, onAnswer }: Props) {
  const [reponse, setReponse] = useState<FormeChoix | null>(null);
  const bonne = question.formes.find((f) => f.correcte)?.texte ?? "";

  if (reponse) {
    return (
      <p
        className={reponse.correcte ? SUCCESS : NEUTRAL}
        data-testid="revision-retour"
        role="status"
      >
        {reponse.correcte ? (
          <span className="font-semibold">Bonne réponse : « {bonne} ».</span>
        ) : (
          <>
            <span className={LABEL}>Ici, on écrit « {bonne} ».</span> {question.explication}
          </>
        )}
      </p>
    );
  }

  return (
    <div role="group" aria-label="Question de révision" className={NEUTRAL}>
      <p>
        <span className={LABEL}>En attendant · {question.titre}</span> — « {question.avant}
        <span
          className="inline-block w-8 mx-0.5 border-b-2 border-brand-500 align-baseline"
          aria-hidden="true"
        />
        <span className="sr-only"> … </span>
        {question.apres} »
      </p>
      <div className="mt-2 flex gap-2">
        {question.formes.map((forme) => (
          <button
            key={forme.texte}
            type="button"
            onClick={() => {
              setReponse(forme);
              onAnswer(forme.correcte);
            }}
            className="flex-1 px-3 py-1.5 rounded-lg text-sm font-semibold
              bg-white dark:bg-gray-800 text-brand-700 dark:text-brand-300
              border border-brand-200 dark:border-brand-500/30
              hover:border-brand-500 hover:bg-brand-50 dark:hover:bg-brand-500/15
              transition-colors focus-visible:outline focus-visible:outline-2
              focus-visible:outline-offset-2 focus-visible:outline-brand-500"
          >
            {forme.texte}
          </button>
        ))}
      </div>
    </div>
  );
}
