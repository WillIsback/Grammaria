import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

interface Props {
  open: boolean;
  title: string;
  message: string;
  /** Libellé du bouton qui confirme (action destructrice). */
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirmation dans l'interface, à la place de `window.confirm` : dans la WebView de
 * l'application de bureau, celle-ci affiche une boîte système titrée « JavaScript -
 * tauri://localhost » avec des boutons en anglais.
 *
 * Accessible : rôle `alertdialog` (titre et message annoncés), focus sur « Annuler » à
 * l'ouverture, Tab reste dans la boîte, Échap annule, le focus revient ensuite à l'élément
 * qui l'avait (le bouton qui a ouvert la confirmation).
 */
export function ConfirmDialog({ open, title, message, confirmLabel, onConfirm, onCancel }: Props) {
  const id = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  // Dernier `onCancel` reçu : un nouveau rendu du parent ne relance pas l'effet (qui
  // remettrait le focus sur « Annuler »).
  const onCancelRef = useRef(onCancel);
  useEffect(() => {
    onCancelRef.current = onCancel;
  });

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    // Phase de capture sur window : avant les écouteurs d'Échap de l'application (tiroir des
    // réglages, écran « Progression »), qui ne doivent pas se fermer en même temps.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancelRef.current();
      } else if (e.key === "Tab") {
        const buttons = [cancelRef.current, confirmRef.current];
        const next = e.shiftKey
          ? document.activeElement === buttons[0]
            ? buttons[1]
            : buttons[0]
          : document.activeElement === buttons[1]
            ? buttons[0]
            : buttons[1];
        e.preventDefault();
        next?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      if (previous?.isConnected) previous.focus();
    };
  }, [open]);

  if (!open) return null;

  // Portail : la barre latérale est déplacée par `transform`, qui servirait sinon de cadre
  // à la position fixe de la boîte.
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm"
        onClick={onCancel}
        aria-hidden="true"
      />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-titre`}
        aria-describedby={`${id}-message`}
        className="relative w-full max-w-sm rounded-2xl p-5 bg-white dark:bg-gray-900
          border border-gray-200/70 dark:border-gray-800/70 shadow-2xl shadow-gray-900/20"
      >
        <h2 id={`${id}-titre`} className="text-sm font-semibold text-gray-900 dark:text-white">
          {title}
        </h2>
        <p id={`${id}-message`} className="mt-2 text-sm text-gray-600 dark:text-gray-300">
          {message}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="px-3 py-2 rounded-xl text-sm font-medium text-gray-700 dark:text-gray-200
              border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800
              focus:outline-none focus:ring-2 focus:ring-brand-500/40 transition-colors"
          >
            Annuler
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className="px-3 py-2 rounded-xl text-sm font-medium text-white bg-red-600 hover:bg-red-700
              focus:outline-none focus:ring-2 focus:ring-red-500/40 transition-colors"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
