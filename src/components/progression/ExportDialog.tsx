/**
 * Fenêtre « Exporter mes résultats » (issue #34) : ce que contient le fichier,
 * ce qu'il ne contient pas, que Grammaria n'envoie rien, et le contenu exact
 * du fichier avant de l'enregistrer.
 *
 * Accessible : rôle `dialog` titré et décrit, focus sur la fenêtre à
 * l'ouverture, Tab reste dans la fenêtre, Échap ferme, le focus revient
 * ensuite au bouton qui l'a ouverte.
 */
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type ExportBeta, nomFichierExport, texteExport } from "../../analysis/progression/export";
import { useChargement } from "../../hooks/useChargement";
import {
  enregistrerExport,
  type FichierEnregistre,
  fetchExportBeta,
} from "../../services/progress";
import { boutonPrincipal, boutonSecondaire } from "./styles";

const FOCUSABLES = 'button:not([disabled]), textarea, [href], [tabindex]:not([tabindex="-1"])';

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const id = useId();
  const { data, erreur } = useChargement(fetchExportBeta);
  const [enCours, setEnCours] = useState(false);
  const [resultat, setResultat] = useState<FichierEnregistre | null>(null);
  const [echec, setEchec] = useState<string | null>(null);
  const boite = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const precedent = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    boite.current?.focus();
    // Capture : avant l'Échap de l'écran Progression, qui ne doit pas se fermer en même temps.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
      } else if (e.key === "Tab" && boite.current) {
        const elements = [...boite.current.querySelectorAll<HTMLElement>(FOCUSABLES)];
        if (elements.length === 0) return;
        const premier = elements[0];
        const dernier = elements[elements.length - 1];
        const actif = document.activeElement;
        if (e.shiftKey && (actif === premier || actif === boite.current)) {
          e.preventDefault();
          dernier.focus();
        } else if (!e.shiftKey && actif === dernier) {
          e.preventDefault();
          premier.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      if (precedent?.isConnected) precedent.focus();
    };
  }, []);

  const enregistrer = async (exp: ExportBeta) => {
    setEnCours(true);
    setEchec(null);
    try {
      setResultat(await enregistrerExport(exp));
    } catch (error) {
      setEchec(error instanceof Error ? error.message : String(error));
    } finally {
      setEnCours(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-3 sm:p-4">
      <div
        className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={boite}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-titre`}
        aria-describedby={`${id}-explication`}
        tabIndex={-1}
        className="relative w-full max-w-2xl max-h-[calc(100vh-1.5rem)] flex flex-col rounded-2xl p-5
          bg-white dark:bg-gray-900 border border-gray-200/70 dark:border-gray-800/70
          shadow-2xl shadow-gray-900/20 focus:outline-none"
      >
        <h2 id={`${id}-titre`} className="text-base font-semibold text-gray-900 dark:text-white">
          Exporter mes résultats
        </h2>
        <ul
          id={`${id}-explication`}
          className="mt-3 space-y-1.5 text-sm text-gray-700 dark:text-gray-300 list-disc pl-5"
        >
          <li>
            Le fichier contient des chiffres : textes, mots et fautes de chaque semaine, et pour
            chaque faute suivie, combien de fois elle revenait avant et depuis la première astuce.
          </li>
          <li>
            Il ne contient aucun de vos textes, aucun mot, aucune date ni aucun nom : seulement un
            numéro tiré au hasard, qui permet de reconnaître vos exports successifs.
          </li>
          <li>
            Grammaria n'envoie rien : le fichier est enregistré sur cet ordinateur, et c'est vous
            qui le transmettez si vous le souhaitez.
          </li>
        </ul>

        {erreur ? (
          <p role="alert" className="mt-4 text-sm text-red-700 dark:text-red-300">
            L'export n'a pas pu être préparé. Fermez cette fenêtre et réessayez.
          </p>
        ) : !data ? (
          <p role="status" className="mt-4 text-sm text-gray-600 dark:text-gray-400">
            Préparation du fichier…
          </p>
        ) : (
          <>
            <label
              htmlFor={`${id}-contenu`}
              className="mt-4 block text-xs font-semibold text-gray-600 dark:text-gray-400"
            >
              Contenu exact du fichier {nomFichierExport(data.participant)}
            </label>
            {/* Zone en lecture seule : défilable et lisible au clavier, le texte se sélectionne. */}
            <textarea
              id={`${id}-contenu`}
              readOnly
              spellCheck={false}
              value={texteExport(data)}
              rows={14}
              className="mt-1.5 min-h-24 flex-1 resize-none rounded-xl bg-gray-50 dark:bg-gray-950
                border border-gray-200 dark:border-gray-800 p-3 font-mono text-xs leading-relaxed
                text-gray-800 dark:text-gray-200 focus:outline-none focus-visible:ring-2
                focus-visible:ring-brand-500/40"
            />
          </>
        )}

        {resultat && (
          <p
            role="status"
            className="mt-3 text-sm text-emerald-800 dark:text-emerald-200 break-all"
          >
            <span aria-hidden="true">✓ </span>
            {resultat.type === "bureau"
              ? `Fichier enregistré : ${resultat.chemin}`
              : `Téléchargement lancé : ${resultat.nom} (dans le dossier des téléchargements de votre navigateur).`}
          </p>
        )}
        {echec && (
          <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300">
            Le fichier n'a pas pu être enregistré : {echec}
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className={`px-3 py-2 ${boutonSecondaire}`}>
            {resultat ? "Fermer" : "Annuler"}
          </button>
          <button
            type="button"
            disabled={!data || enCours}
            onClick={() => data && void enregistrer(data)}
            className={`px-3 py-2 ${boutonPrincipal} disabled:opacity-50 disabled:cursor-not-allowed
              focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40`}
          >
            {enCours ? "Enregistrement…" : "Enregistrer le fichier"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
