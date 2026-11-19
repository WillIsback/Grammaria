/**
 * Mise à jour de l'application de bureau.
 *
 * Toute la logique (recherche, téléchargement, vérification de la signature,
 * installation) est dans l'application elle-même, côté Rust
 * (src-tauri/src/update.rs). L'interface ne fait qu'appeler quatre commandes,
 * les seules que l'application autorise à cette page. Dans un navigateur
 * (version web, Docker), le pont n'existe pas : rien n'est affiché.
 */

/** auto : installation possible ; manual : lien de téléchargement ; inactive : pas encore activées. */
export type UpdateMode = "auto" | "manual" | "inactive";

export type UpdatePhase =
  | "idle"
  | "checking"
  | "upToDate"
  | "available"
  | "downloading"
  | "installing"
  | "error";

export interface AppUpdateStatus {
  currentVersion: string;
  mode: UpdateMode;
  phase: UpdatePhase;
  /** Version proposée, quand il y en a une. */
  version: string | null;
  notes: string | null;
  /** Octets téléchargés, et taille totale si elle est connue. */
  downloaded: number;
  total: number | null;
  /** Message pour l'utilisateur, et détail technique pour le support. */
  error: string | null;
  errorDetail: string | null;
  releasePage: string;
}

type Invoke = <T>(command: string) => Promise<T>;

/** Pont vers l'application de bureau ; null dans un navigateur. */
function bridge(): Invoke | null {
  const tauri = (window as { __TAURI__?: { core?: { invoke?: unknown } } }).__TAURI__;
  const invoke = tauri?.core?.invoke;
  return typeof invoke === "function" ? (invoke as Invoke) : null;
}

function call<T>(command: string): Promise<T> {
  const invoke = bridge();
  if (!invoke) return Promise.reject(new Error("Application de bureau requise."));
  return invoke<T>(command);
}

/** Vrai dans l'application de bureau, faux dans un navigateur. */
export function isDesktopApp(): boolean {
  return bridge() !== null;
}

/** État courant, sans rien déclencher. */
export const fetchUpdateStatus = () => call<AppUpdateStatus>("update_status");

/** Recherche une version stable plus récente. Ne télécharge rien. */
export const checkForUpdate = () => call<AppUpdateStatus>("update_check");

/** Télécharge, vérifie, installe, puis redémarre. Uniquement sur action de l'utilisateur. */
export const installUpdate = () => call<AppUpdateStatus>("update_install");

/** Ouvre la page de téléchargement dans le navigateur. */
export const openReleasePage = () => call<void>("update_open_release_page");

/** Avancement du téléchargement : « 42 % », ou « 12,3 Mo » si la taille est inconnue. */
export function formatProgress(status: Pick<AppUpdateStatus, "downloaded" | "total">): string {
  if (status.total && status.total > 0) {
    const percent = Math.min(100, Math.floor((status.downloaded / status.total) * 100));
    return `${percent} %`;
  }
  return `${(status.downloaded / 1_000_000).toFixed(1).replace(".", ",")} Mo`;
}
