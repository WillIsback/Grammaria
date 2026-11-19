/**
 * Relais vers le serveur LLM amont.
 *
 * Module sans dépendance à Bun pour rester testable sous vitest.
 */

/**
 * En-têtes propres à la connexion entre le navigateur et Grammaria, qui ne
 * doivent pas être retransmis à l'amont. `host` en particulier : le relayer
 * envoie `Host: localhost:25000` à un fournisseur en ligne, dont le reverse
 * proxy route sur cet en-tête et rejette ou égare la requête.
 */
const HOP_BY_HOP_HEADERS = [
  "host",
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "content-length",
];

/** En-têtes à envoyer à l'amont pour une requête relayée. */
export function upstreamHeaders(incoming: Headers, apiKey?: string): Headers {
  const headers = new Headers(incoming);
  for (const name of HOP_BY_HOP_HEADERS) headers.delete(name);
  if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
  return headers;
}

/**
 * En-têtes de la réponse amont à renvoyer au navigateur. `fetch` décompresse
 * déjà le corps : renvoyer `Content-Encoding: gzip` (et la longueur compressée)
 * ferait échouer le navigateur avec ERR_CONTENT_DECODING_FAILED.
 */
export function downstreamHeaders(upstream: Headers): Headers {
  const headers = new Headers(upstream);
  for (const name of [...HOP_BY_HOP_HEADERS, "content-encoding"]) headers.delete(name);
  return headers;
}

/** Valeur envoyée par l'interface quand elle n'a pas pu choisir de modèle. */
export const AUTO_MODEL = "auto";

export interface UpstreamModel {
  id: string;
  /** Champ non standard renvoyé par certains fournisseurs (Albert…). */
  type?: string;
}

const CHAT_MODEL_TYPES = new Set(["text-generation", "chat", "chat-completion", "llm"]);

/**
 * Premier modèle de génération de texte de la liste. Quand le fournisseur
 * indique un type, les modèles d'embedding, de reranking, de transcription ou
 * d'OCR sont écartés ; sinon le premier modèle est retenu.
 */
export function pickChatModel(models: UpstreamModel[]): string | null {
  const withId = models.filter((m) => typeof m?.id === "string" && m.id.length > 0);
  const typed = withId.filter((m) => typeof m.type === "string");
  if (typed.length > 0) {
    const chat = typed.find((m) => CHAT_MODEL_TYPES.has((m.type ?? "").toLowerCase()));
    if (chat) return chat.id;
  }
  return withId[0]?.id ?? null;
}

/**
 * Modèle à utiliser pour une correction : celui de la configuration, sinon
 * celui demandé par l'interface, sinon le premier modèle du serveur amont.
 */
export async function resolveModel(
  configured: string,
  requested: unknown,
  detect: () => Promise<string | null>,
): Promise<string> {
  if (configured) return configured;
  if (typeof requested === "string" && requested && requested !== AUTO_MODEL) return requested;
  const detected = await detect();
  if (detected) return detected;
  throw new Error(
    "Le serveur du modèle ne liste aucun modèle de génération. Renseignez LLM_MODEL_NAME.",
  );
}

/**
 * Détecte le modèle par défaut du serveur amont via GET /v1/models. Le
 * résultat est mis en cache ; un échec ne l'est pas, pour réessayer ensuite.
 * Renvoie null si la liste ne contient aucun modèle ; lève une erreur
 * explicite si le serveur est injoignable ou refuse la requête.
 */
export function createModelDetector(
  llmTarget: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): () => Promise<string | null> {
  let cached: string | null = null;
  return async () => {
    if (cached) return cached;
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
    let body: { data?: UpstreamModel[] } | null = null;
    try {
      body = (await res.json()) as { data?: UpstreamModel[] };
    } catch {
      /* réponse non JSON : traitée comme une liste vide */
    }
    cached = pickChatModel(Array.isArray(body?.data) ? body.data : []);
    return cached;
  };
}

/**
 * Vrai si l'erreur d'une API compatible OpenAI signale le refus du paramètre
 * `chat_template_kwargs` (propre à vLLM / SGLang, qui coupe le raisonnement).
 * Le serveur relance alors la requête sans ce paramètre.
 */
export function isThinkingParamRejection(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const { status, message } = err as { status?: number; message?: string };
  if (status !== 400 && status !== 422) return false;
  return /chat_template_kwargs|enable_thinking|unrecognized|unknown (field|parameter|argument)|extra (fields|inputs)/i.test(
    String(message ?? ""),
  );
}
