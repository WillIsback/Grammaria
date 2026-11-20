export type CorrectionMode = "formel" | "semi-formel" | "informel" | "technical";

export interface CorrectionSettings {
  mode: CorrectionMode;
  fixGrammar: boolean;
  fixSpelling: boolean;
  fixSyntax: boolean;
  fixStyle: boolean;
}

export interface CorrectionStats {
  processingTime: number;
  modificationCount: number;
}

// Détections du correcteur grammatical (format LanguageTool)
export interface LTMatch {
  message: string;
  shortMessage: string;
  offset: number;
  length: number;
  replacements: { value: string }[];
  rule: {
    id: string;
    description?: string;
    issueType?: string;
    category?: { id: string; name: string };
  };
}

export interface LTResponse {
  matches: LTMatch[];
}

// LLM types (migrés depuis api.ts)
export interface ModelInfo {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

export interface CorrectionEntry {
  avant: string;
  apres: string;
  regle: string;
  /** Astuce de la fiche de règle, quand la faute en possède une. */
  astuce?: string;
}

export interface StreamCallbacks {
  /** Appelé à chaque fragment reçu, avec le texte accumulé. */
  onText?: (text: string) => void;
}

export interface LlmResult {
  text: string;
  duration: number;
}

/** Bilan des sept derniers jours renvoyé par le journal. */
export interface WeekSummary {
  texts: number;
  words: number;
  faults: number;
  score: number | null;
}
