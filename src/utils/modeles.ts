import { pickChatModel, type UpstreamModel } from "./upstream.ts";

/**
 * Liste des modèles du serveur amont et détection du modèle par défaut.
 *
 * Module sans dépendance à Bun ni à Node : le gestionnaire d'API
 * (`api/handler.ts`) l'utilise aussi dans la WebView du bureau, où la liste
 * vient de la commande Rust `llm_models`.
 */

/**
 * GET `<llmTarget>/v1/models` → corps JSON (`{ data: [...] }`, ou null s'il
 * n'est pas du JSON). Lève une erreur explicite si le serveur est injoignable
 * ou refuse la requête.
 */
export async function listerModelesAmont(
  llmTarget: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  let res: Response;
  try {
    res = await fetchImpl(`${llmTarget}/v1/models`, { headers });
  } catch (err) {
    throw new Error(
      `Le serveur du modèle (${llmTarget}) est injoignable : ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `Le serveur du modèle (${llmTarget}) refuse GET /v1/models : HTTP ${res.status}`,
    );
  }
  try {
    return await res.json();
  } catch {
    return null; // réponse non JSON : traitée comme une liste vide
  }
}

/** Modèles d'un corps de réponse de `/v1/models`, quel qu'il soit. */
export function modelesDuCorps(body: unknown): UpstreamModel[] {
  const data = (body as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? (data as UpstreamModel[]) : [];
}

export interface DetecteurModele {
  /** Modèle de génération par défaut ; null si la liste n'en contient aucun. */
  (): Promise<string | null>;
  /** Oublie le modèle retenu (changement de réglages). */
  oublier(): void;
}

/**
 * Détecte le modèle par défaut à partir de la liste des modèles. Le résultat
 * est mis en cache ; un échec ne l'est pas, pour réessayer ensuite.
 */
export function creerDetecteurModele(lister: () => Promise<unknown>): DetecteurModele {
  let cached: string | null = null;
  const detecter = (async () => {
    if (cached) return cached;
    cached = pickChatModel(modelesDuCorps(await lister()));
    return cached;
  }) as DetecteurModele;
  detecter.oublier = () => {
    cached = null;
  };
  return detecter;
}
