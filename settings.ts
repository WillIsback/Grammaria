import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.ts";
import {
  type LlmSettings,
  parseSettingsFile,
  parseUpdate,
  publicSettingsView,
  type ServerSettings,
  settingsFileContent,
} from "./api/reglages.ts";

export {
  normalizeTarget,
  parseUpdate,
  type LlmSettings,
  type SettingsUpdate,
} from "./api/reglages.ts";

/**
 * Réglages du LLM modifiables depuis l'interface, en mode bureau uniquement.
 *
 * Sur un serveur partagé, la configuration vient des variables d'environnement
 * et n'est jamais modifiable par un visiteur. Sur un serveur local d'un seul
 * utilisateur (GRAMMARIA_DESKTOP=1, écoute sur 127.0.0.1), l'adresse du modèle
 * se saisit dans les réglages de l'interface, enregistrés dans
 * GRAMMARIA_SETTINGS_PATH. L'application de bureau a son propre magasin, au même
 * format (src-tauri/src/store.rs).
 *
 * La validation (pure, réutilisable hors de Node) est dans `api/reglages.ts` ;
 * cette classe lit et écrit le fichier et applique les réglages à `config`.
 */
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

  /** Vue publique : la clé API n'est jamais renvoyée au navigateur. */
  publicView(): ServerSettings {
    return publicSettingsView(currentSettings(), {
      editable: this.editable,
      configured: this.configured,
    });
  }

  /** Valide puis applique et enregistre les réglages. Lève une erreur lisible si invalides. */
  update(input: unknown): ServerSettings {
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
      return parseSettingsFile(JSON.parse(readFileSync(this.path, "utf-8")));
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
    const content = settingsFileContent(settings);
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
