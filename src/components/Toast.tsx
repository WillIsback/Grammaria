import { useEffect } from "react";
import { CHECK_PATH, CLOSE_PATH, Icon, WARNING_PATH } from "./Icon";

export type ToastType = "success" | "error" | "warning";

export interface Toast {
  message: string;
  type: ToastType;
}

interface Props {
  /** Un nouvel objet relance le délai de fermeture. */
  toast: Toast;
  onClose: () => void;
}

/** Couleurs et tracé de l'icône selon le type de message. */
const APPARENCE: Record<ToastType, { style: string; trace: string }> = {
  success: {
    style: "bg-gray-900/90 dark:bg-white/90 text-white dark:text-gray-900",
    trace: CHECK_PATH,
  },
  error: { style: "bg-red-600/90 text-white", trace: CLOSE_PATH },
  warning: { style: "bg-amber-500/90 text-white", trace: WARNING_PATH },
};

export function Toast({ toast, onClose }: Props) {
  useEffect(() => {
    const timer = setTimeout(onClose, 3000);
    return () => clearTimeout(timer);
  }, [toast, onClose]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const { style, trace } = APPARENCE[toast.type];

  return (
    <div
      role="alert"
      aria-live="polite"
      className={`fixed top-5 right-5 px-4 py-3 rounded-2xl shadow-elevated backdrop-blur-lg
        flex items-center gap-2.5 z-50 animate-fade-in-out text-sm font-medium ${style}`}
    >
      <Icon className="w-4 h-4 shrink-0" strokeWidth={2.5}>
        <path d={trace} />
      </Icon>
      <span>{toast.message}</span>
      <button
        type="button"
        onClick={onClose}
        aria-label="Fermer"
        className="ml-1 opacity-50 hover:opacity-100 transition-opacity"
      >
        <Icon className="w-3.5 h-3.5" strokeWidth={2.5}>
          <path d={CLOSE_PATH} />
        </Icon>
      </button>
    </div>
  );
}
