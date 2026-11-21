/** Réglages du LLM exposés par le serveur (modifiables dans l'application de bureau). */
export interface ServerSettings {
  editable: boolean;
  configured: boolean;
  llmTarget: string;
  llmModelName: string;
  llmDisableThinking: boolean;
  hasApiKey: boolean;
  /**
   * Application de bureau : `settings.json` existe mais n'a pas pu être lu.
   * Ses réglages et la clé sont ignorés ; l'utilisateur en est prévenu dans
   * Paramètres → IA. Absent (ou faux) sur le serveur web et après un
   * enregistrement réussi.
   */
  settingsUnreadable?: boolean;
  /**
   * Application de bureau : où est rangée la clé API. `trousseau` : trousseau
   * du système (Gestionnaire d'identification de Windows, service de secrets
   * sous Linux) ; `fichier` : aucun trousseau disponible, la clé reste dans
   * le fichier de réglages, lisible par le seul compte de l'utilisateur ;
   * `aucune` : pas de clé. Absent sur le serveur web (clé dans l'environnement).
   */
  apiKeyStorage?: ApiKeyStorage;
}

export type ApiKeyStorage = "trousseau" | "fichier" | "aucune";

export interface SettingsInput {
  llmTarget?: string;
  /** Absent : la clé enregistrée est conservée. */
  llmApiKey?: string;
  /** Coupe le raisonnement du modèle (plus rapide). */
  llmDisableThinking?: boolean;
}

export async function fetchServerSettings(): Promise<ServerSettings> {
  const response = await fetch("/api/settings");
  if (!response.ok) throw new Error(`Réglages indisponibles (HTTP ${response.status})`);
  return response.json();
}

export async function saveServerSettings(input: SettingsInput): Promise<ServerSettings> {
  const response = await fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      typeof body?.error === "string"
        ? body.error
        : `Enregistrement impossible (HTTP ${response.status})`,
    );
  }
  return body as ServerSettings;
}
