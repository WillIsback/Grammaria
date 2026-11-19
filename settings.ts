import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.ts";

/**
 * Réglages du LLM modifiables depuis l'interface, en mode bureau uniquement.
 *
 * Sur un serveur, la configuration vient des variables d'environnement et
 * n'est jamais modifiable par un visiteur. Dans l'application de bureau,
 * l'utilisateur n'a pas de terminal : il saisit l'adresse du modèle dans les
 * réglages, enregistrés dans son dossier de données (GRAMMARIA_SETTINGS_PATH).
 */

export interface LlmSettings {
  llmTarget: string;
  llmApiKey: string;
  llmModelName: string;
  llmDisableThinking: boolean;
}

/** Vue publique : la clé API n'est jamais renvoyée au navigateur. */
export interface PublicSettings {
  editable: boolean;
  configured: boolean;
  llmTarget: string;
  llmModelName: string;
  llmDisableThinking: boolean;
  hasApiKey: boolean;
}

export type SettingsUpdate = Partial<LlmSettings>;

const MAX_FIELD_LENGTH = 2_000;

/**
 * Version du fichier de réglages. Avant la 2, l'application de bureau
 * démarrait avec le raisonnement du modèle actif et recopiait cette valeur
 * dans le fichier sans que l'utilisateur l'ait choisie : le champ
 * `llmDisableThinking` d'un fichier plus ancien est donc ignoré.
 */
const SETTINGS_VERSION = 2;

export class SettingsStore {
  constructor(private readonly path: string | null) {
    if (path) Object.assign(config, this.readFile());
  }

  get editable(): boolean {
    return this.path !== null;
  }

  /** Vrai quand une adresse de modèle a été saisie (ou fournie par l'environnement). */
  get configured(): boolean {
    return this.path ? existsSync(this.path) && config.llmTarget !== "" : config.llmTarget !== "";
  }

  publicView(): PublicSettings {
    return {
      editable: this.editable,
      configured: this.configured,
      llmTarget: config.llmTarget,
      llmModelName: config.llmModelName,
      llmDisableThinking: config.llmDisableThinking,
      hasApiKey: config.llmApiKey !== "",
    };
  }

  /** Valide puis applique et enregistre les réglages. Lève une erreur lisible si invalides. */
  update(input: unknown): PublicSettings {
    if (!this.path) throw new Error("Les réglages ne sont pas modifiables sur ce serveur.");
    const update = parseUpdate(input);
    const next: LlmSettings = { ...currentSettings(), ...update };
    this.writeFile(next);
    Object.assign(config, next);
    return this.publicView();
  }

  private readFile(): Partial<LlmSettings> {
    if (!this.path || !existsSync(this.path)) return {};
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf-8"));
      if (raw && typeof raw === "object" && (raw.settingsVersion ?? 1) < SETTINGS_VERSION) {
        delete raw.llmDisableThinking;
      }
      delete raw?.settingsVersion;
      return parseUpdate(raw);
    } catch (error) {
      console.error("[Settings] Fichier de réglages illisible, valeurs par défaut :", error);
      return {};
    }
  }

  private writeFile(settings: LlmSettings): void {
    const path = this.path as string;
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    // La clé API est en clair : fichier lisible par son seul propriétaire.
    const content = { settingsVersion: SETTINGS_VERSION, ...settings };
    writeFileSync(tmp, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
    try {
      chmodSync(path, 0o600);
    } catch {
      /* Windows : les droits suivent le dossier de données de l'utilisateur */
    }
  }
}

function currentSettings(): LlmSettings {
  return {
    llmTarget: config.llmTarget,
    llmApiKey: config.llmApiKey,
    llmModelName: config.llmModelName,
    llmDisableThinking: config.llmDisableThinking,
  };
}

function parseUpdate(input: unknown): SettingsUpdate {
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

/** Adresse racine du serveur du modèle : http(s), sans « /v1 » final ni barre oblique. */
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
  return url.href.replace(/\/+$/, "").replace(/\/v1$/, "");
}
