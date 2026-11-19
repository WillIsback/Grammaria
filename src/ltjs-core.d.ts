/** Déclarations minimales de @valueerror/ltjs-core (paquet sans types). */
declare module "@valueerror/ltjs-core" {
  import type { LTMatch } from "./types";

  export interface CheckOptions {
    /** Code de langue LanguageTool, par exemple « fr ». */
    language: string;
  }

  export function check(text: string, options: CheckOptions): Promise<{ matches: LTMatch[] }>;
}
