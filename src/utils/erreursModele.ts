/**
 * Erreurs du modèle traduites en messages simples pour l'utilisateur.
 *
 * Le détail technique (statut HTTP, « tcp connect error »…) n'est plus le
 * message principal : il reste disponible sous « Détails » et dans le journal
 * technique. Module sans dépendance à Bun ni à Node : le gestionnaire d'API
 * (`api/handler.ts`) l'utilise sur le serveur web comme dans la WebView du
 * bureau, pour que les deux affichent les mêmes messages.
 */

/** Cause d'un échec du modèle, du point de vue de l'utilisateur. */
export type CauseErreurModele =
  | "non-configure"
  | "injoignable"
  | "cle"
  | "introuvable"
  | "delai"
  | "autre";

/** Statut HTTP de l'erreur : champ `status`, sinon « HTTP 401 » dans son message. */
function statutDe(err: unknown, message: string): number | null {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === "number" && Number.isFinite(status)) return status;
  const trouve = /\bHTTP\s+(\d{3})\b/.exec(message);
  return trouve ? Number(trouve[1]) : null;
}

function messageDe(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) return String(err.message);
  return typeof err === "string" ? err : "";
}

const DELAI = /délai dépassé|timed? ?out|timeout|ETIMEDOUT/i;
const RESEAU =
  /injoignable|connect|connexion|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|getaddrinfo|dns|fetch failed|Failed to fetch|network|unreachable|refused|certificat|certificate|tls|ssl/i;

/** Classe une erreur levée par le modèle (SDK OpenAI, relais Rust, liste des modèles). */
export function classerErreurModele(err: unknown): CauseErreurModele {
  const message = messageDe(err);
  if (/Aucun modèle n'est configuré/i.test(message)) return "non-configure";
  const statut = statutDe(err, message);
  if (statut === 401 || statut === 403) return "cle";
  if (statut === 404) return "introuvable";
  if (statut === 408 || statut === 504) return "delai";
  if (statut === 502 || statut === 503) return "injoignable";
  if (/aucun modèle de génération/i.test(message)) return "introuvable";
  if (statut === null) {
    if (DELAI.test(message)) return "delai";
    if (RESEAU.test(message)) return "injoignable";
  }
  return "autre";
}

/**
 * Message affiché pour une cause. `modifiable` : les réglages du modèle se
 * changent dans Paramètres → IA (application de bureau) ; sur le serveur web,
 * ils sont fixés par la personne qui gère Grammaria.
 */
export function messageErreurModele(cause: CauseErreurModele, modifiable: boolean): string {
  switch (cause) {
    case "non-configure":
      return modifiable
        ? "Aucun modèle n'est configuré. Indiquez son adresse dans Paramètres → IA."
        : "Aucun modèle n'est configuré. Prévenez la personne qui gère Grammaria.";
    case "injoignable":
      return modifiable
        ? "Le modèle ne répond pas. Vérifiez son adresse dans Paramètres → IA, et qu'il est bien démarré."
        : "Le modèle ne répond pas pour le moment. Réessayez dans un instant.";
    case "cle":
      return modifiable
        ? "Le modèle a refusé la clé API. Vérifiez-la dans Paramètres → IA."
        : "Le modèle a refusé l'accès. Prévenez la personne qui gère Grammaria.";
    case "introuvable":
      return modifiable
        ? "Le modèle demandé est introuvable. Vérifiez son adresse dans Paramètres → IA, puis choisissez un modèle dans la liste."
        : "Le modèle demandé est introuvable. Choisissez-en un autre dans Paramètres → IA.";
    case "delai":
      return "Le modèle a mis trop de temps à répondre. Réessayez, ou corrigez un texte plus court.";
    default:
      return "La correction a échoué. Réessayez dans un instant.";
  }
}

/** Message générique d'une correction en échec, quand la cause est inconnue. */
export const MESSAGE_ECHEC_CORRECTION = messageErreurModele("autre", false);

/**
 * Erreur de correction affichée à l'utilisateur : `message` simple, `details`
 * technique (affiché replié sous « Détails »).
 */
export class ErreurCorrection extends Error {
  readonly details: string;

  constructor(message: string, details = "") {
    super(message);
    this.name = "ErreurCorrection";
    this.details = details;
  }
}

/** Clés qui peuvent porter la requête, donc le texte de l'utilisateur (voir `messageSansEntree`). */
const CLES_ENTREE =
  /["'\\]+(?:input|inputs|messages|content|prompt|text)["'\\]+\s*[:=]|\b(?:input|inputs|messages|content|prompt|text)\s*=/i;

/**
 * Message d'une erreur amont (modèle, correcteur) bon à écrire dans les
 * journaux du serveur, que Docker conserve : une erreur de validation
 * (FastAPI, vLLM…) cite la valeur refusée (`"input": …`), un relais comme
 * LiteLLM recopie parfois toute la requête (`'messages': […]`) ; le texte de
 * l'utilisateur ne doit pas y entrer (issue #32). Le message est coupé à la
 * première clé qui peut le porter, puis borné à 300 caractères. Même règle
 * que `message_sans_entree` du bureau (src-tauri/src/llm.rs).
 */
export function messageSansEntree(erreur: unknown): string {
  const message = messageDe(erreur);
  const trouve = CLES_ENTREE.exec(message);
  const coupe = trouve ? message.slice(0, trouve.index) : message;
  const caracteres = Array.from(coupe);
  const texte = caracteres.slice(0, 300).join("");
  return texte.length < message.length ? `${texte}…` : texte;
}
