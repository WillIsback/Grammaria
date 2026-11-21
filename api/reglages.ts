import type { ApiKeyStorage, ServerSettings } from "../src/services/settings.ts";

/**
 * Réglages du LLM : validation pure, sans lecture ni écriture de fichier.
 *
 * Partagée entre le serveur Bun (`settings.ts`, qui lit et écrit
 * `settings.json`) et le gestionnaire d'API (`api/handler.ts`), qui tourne
 * aussi dans la WebView du bureau : ce module n'importe rien de Bun ni de Node.
 */

export interface LlmSettings {
  llmTarget: string;
  llmApiKey: string;
  llmModelName: string;
  llmDisableThinking: boolean;
}

export type SettingsUpdate = Partial<LlmSettings>;

/**
 * Application de bureau : `apiKeyStorage` (où est rangée la clé : trousseau du
 * système ou, sans trousseau, fichier réservé au compte) vient de Rust
 * (`settings_get`, src-tauri/src/store.rs). Le serveur web ne le renvoie pas :
 * sa clé vient de l'environnement.
 */
export type { ApiKeyStorage, ServerSettings };

const MAX_FIELD_LENGTH = 2_000;

/**
 * Version du fichier de réglages. Avant la 2, l'application de bureau
 * démarrait avec le raisonnement du modèle actif et recopiait cette valeur
 * dans le fichier sans que l'utilisateur l'ait choisie : le champ
 * `llmDisableThinking` d'un fichier plus ancien est donc ignoré.
 */
export const SETTINGS_VERSION = 2;

/** Valide une modification des réglages. Lève une erreur lisible si elle est invalide. */
export function parseUpdate(input: unknown): SettingsUpdate {
  if (!input || typeof input !== "object") throw new Error("Réglages invalides.");
  const raw = input as Record<string, unknown>;
  const update: SettingsUpdate = {};

  const text = (key: keyof LlmSettings): string | undefined => {
    const value = raw[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.length > MAX_FIELD_LENGTH) {
      throw new Error(`Réglage invalide : ${key}.`);
    }
    return value.trim();
  };

  const target = text("llmTarget");
  if (target !== undefined) update.llmTarget = normalizeTarget(target);
  const apiKey = text("llmApiKey");
  if (apiKey !== undefined) update.llmApiKey = apiKey;
  const model = text("llmModelName");
  if (model !== undefined) update.llmModelName = model;
  if (raw.llmDisableThinking !== undefined) {
    if (typeof raw.llmDisableThinking !== "boolean") {
      throw new Error("Réglage invalide : llmDisableThinking.");
    }
    update.llmDisableThinking = raw.llmDisableThinking;
  }
  return update;
}

/** Origine (schéma, hôte, port) d'une adresse enregistrée ; `null` si elle n'en est pas une. */
function origin(target: string): string | null {
  try {
    return new URL(target).origin;
  } catch {
    return null;
  }
}

/**
 * Réglages après une modification venue de l'interface. Décision du PO : si
 * l'adresse du modèle change de serveur (origine : schéma, hôte, port) sans
 * qu'une nouvelle clé soit fournie, la clé enregistrée est effacée : elle ne
 * doit jamais partir vers un autre serveur. Même règle que `apply_update`
 * (`src-tauri/src/store.rs`).
 */
export function applySettingsUpdate(current: LlmSettings, update: SettingsUpdate): LlmSettings {
  const next: LlmSettings = { ...current, ...update };
  if (update.llmApiKey === undefined && origin(next.llmTarget) !== origin(current.llmTarget)) {
    next.llmApiKey = "";
  }
  return next;
}

/**
 * Contenu d'un fichier de réglages déjà décodé (JSON) → réglages valides.
 * Un fichier antérieur à la version 2 perd son `llmDisableThinking`.
 * Lève une erreur si le contenu est invalide.
 */
export function parseSettingsFile(raw: unknown): SettingsUpdate {
  if (raw && typeof raw === "object") {
    const copy = { ...(raw as Record<string, unknown>) };
    if (((copy.settingsVersion as number | undefined) ?? 1) < SETTINGS_VERSION) {
      delete copy.llmDisableThinking;
    }
    delete copy.settingsVersion;
    return parseUpdate(copy);
  }
  return parseUpdate(raw);
}

/** Contenu à enregistrer dans le fichier de réglages (avec sa version). */
export function settingsFileContent(settings: LlmSettings): LlmSettings & {
  settingsVersion: number;
} {
  return { settingsVersion: SETTINGS_VERSION, ...settings };
}

/** Vue publique des réglages : la clé API n'est jamais renvoyée au navigateur. */
export function publicSettingsView(
  settings: LlmSettings,
  state: { editable: boolean; configured: boolean },
): ServerSettings {
  return {
    editable: state.editable,
    configured: state.configured,
    llmTarget: settings.llmTarget,
    llmModelName: settings.llmModelName,
    llmDisableThinking: settings.llmDisableThinking,
    hasApiKey: settings.llmApiKey !== "",
  };
}

/** Refus d'une adresse avec paramètres (`?…`, `#…`) ou identifiants (`utilisateur:mot-de-passe@`). */
export const TARGET_EXTRAS_ERROR =
  "L'adresse du modèle ne doit contenir ni paramètres ni identifiants.";

/**
 * Adresse racine du serveur du modèle : http(s), sans « /v1 » final ni barre
 * oblique. Les chemins de l'API (`/v1/…`) y sont ajoutés à la suite : une
 * requête (`?…`) ou un fragment (`#…`) les casserait, et des identifiants dans
 * l'adresse partiraient en clair avec chaque requête (la clé API a son champ).
 * Mêmes règles et mêmes messages que `normalize_target` (`src-tauri/src/store.rs`).
 */
export function normalizeTarget(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("L'adresse du modèle doit être une URL complète (http://… ou https://…).");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("L'adresse du modèle doit commencer par http:// ou https://.");
  }
  // `url.search` et `url.hash` sont vides pour un « ? » ou un « # » seul : on
  // regarde l'adresse entière, où ils ne peuvent marquer que la requête ou le fragment.
  if (/[?#]/.test(url.href) || url.username !== "" || url.password !== "") {
    throw new Error(TARGET_EXTRAS_ERROR);
  }
  return url.href.replace(/\/+$/, "").replace(/\/v1$/, "");
}
