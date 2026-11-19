/** Déclarations minimales de @valueerror/ltjs-core (paquet sans types). */
declare module "@valueerror/ltjs-core" {
  import type { LTMatch } from "./types";

  export interface CheckOptions {
    /** Code de langue LanguageTool, par exemple « fr ». */
    language: string;
  }

  export function check(text: string, options: CheckOptions): Promise<{ matches: LTMatch[] }>;
}

declare module "@valueerror/ltjs-core/src/core/resources/ResourceDataBroker.js" {
  /** Ajoute un dossier où le moteur cherche ses fichiers de règles. */
  export function addResourceRoot(dir: string): void;
}

/** Enregistre les règles françaises auprès du moteur (effet de bord à l'import). */
declare module "@valueerror/ltjs-lang-fr";
