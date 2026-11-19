/**
 * Accès aux commandes de l'application de bureau (Tauri 2).
 *
 * L'API de Tauri est lue sur `window.__TAURI__` (`app.withGlobalTauri` dans tauri.conf.json) :
 * aucune dépendance npm de plus, et c'est déjà ainsi que `src/services/appUpdate.ts` appelle les
 * commandes de mise à jour. Seules les commandes autorisées par la capability de la fenêtre
 * (src-tauri/capabilities/default.json) répondent ; les autres sont refusées par Tauri.
 */

export type Invoke = <T>(commande: string, args?: Record<string, unknown>) => Promise<T>;

/** Canal Tauri (`Channel`) : messages poussés par Rust, dans l'ordre d'envoi. */
export interface CanalTauri<T> {
  onmessage: (message: T) => void;
}

export interface ApiTauri {
  invoke: Invoke;
  Channel: new <T>() => CanalTauri<T>;
}

/** API de Tauri dans l'application de bureau ; null dans un navigateur. */
export function apiTauri(): ApiTauri | null {
  const core = (window as { __TAURI__?: { core?: Partial<ApiTauri> } }).__TAURI__?.core;
  if (typeof core?.invoke !== "function" || typeof core.Channel !== "function") return null;
  return { invoke: core.invoke, Channel: core.Channel };
}

/**
 * Message d'une erreur renvoyée par une commande, tel quel : Rust rejette `invoke` avec une
 * chaîne (`Result<_, String>`) ou un objet sérialisé (`{ message, status?, … }`).
 */
export function messageErreur(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return String(error);
}

/**
 * Erreur JavaScript d'une commande en échec. Le message est conservé à l'identique (le journal
 * reconnaît un conflit à son préfixe `Conflit :`) et les champs d'un objet d'erreur (`status`,
 * `cancelled` du relais du modèle) sont recopiés sur l'erreur.
 */
export function erreurCommande(error: unknown): Error {
  if (error instanceof Error) return error;
  const erreur = new Error(messageErreur(error));
  if (error && typeof error === "object") {
    const { message: _message, ...champs } = error as Record<string, unknown>;
    Object.assign(erreur, champs);
  }
  return erreur;
}

/** `invoke` dont les rejets sont des `Error` (voir `erreurCommande`). */
export function invokeSur(invoke: Invoke): Invoke {
  return async <T>(commande: string, args?: Record<string, unknown>) => {
    try {
      return await invoke<T>(commande, args);
    } catch (error) {
      throw erreurCommande(error);
    }
  };
}
