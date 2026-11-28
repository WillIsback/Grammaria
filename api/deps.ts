import type { Analysis } from "../src/analysis/analyze.ts";
import type { BadgeAnnonce } from "../src/analysis/badges/vue.ts";
import type { EtatCycle } from "../src/analysis/regles/cycle.ts";
import type { LTMatch } from "../src/types.ts";
import type { ServerSettings, SettingsUpdate } from "./reglages.ts";

/**
 * Dépendances injectées dans le gestionnaire d'API (`api/handler.ts`).
 *
 * Le gestionnaire tourne sur le serveur Bun et dans la WebView du bureau :
 * ce module ne décrit que des interfaces, sans rien importer de Bun ni de Node.
 * Chaque méthode peut répondre tout de suite ou par une promesse
 * (`MaybePromise`) : le gestionnaire attend (`await`) chaque appel, que
 * l'implémentation soit synchrone (SQLite de Bun) ou asynchrone (commandes
 * Rust du bureau).
 */

export type MaybePromise<T> = T | Promise<T>;

/** Issue de l'enregistrement d'une réponse à un choix à deux formes. */
export type AnswerResult = "recorded" | "unknown" | "conflict";

/**
 * Journal des fautes : les méthodes publiques de `Journal` (`journal.ts`)
 * utilisées par les routes. Les réponses sont renvoyées telles quelles en JSON ;
 * seuls les champs que le gestionnaire lit sont typés précisément.
 */
export interface JournalDeps {
  /** Enregistre une analyse ; renvoie ce qu'il faut afficher près du bouton Copier. */
  record(
    analysis: Analysis,
    now: number,
    options: { original?: string; corrected?: string },
  ): MaybePromise<object>;
  /** Bilan d'une période (note moyenne affichée près du bouton Copier). */
  period(days: number): MaybePromise<unknown>;
  /** Bilan du journal (`GET /api/journal`). */
  summary(days: number): MaybePromise<unknown>;
  /** Écran « Progression » (`GET /api/progress`). */
  progress(): MaybePromise<unknown>;
  /**
   * Export anonyme de la bêta (`GET /api/progress/export`) : déjà validé par
   * `validerExport` (src/analysis/progression/export.ts).
   */
  exportBeta(options: {
    application: string;
    plateforme: "bureau" | "serveur";
  }): MaybePromise<unknown>;
  /** Cycle de vie des règles. */
  rules(): MaybePromise<readonly { state: EtatCycle }[]>;
  ruleEvents(options: { limit?: number; ruleKey?: string }): MaybePromise<unknown[]>;
  answerChoice(choiceId: number, correct: boolean): MaybePromise<AnswerResult>;
  purge(): MaybePromise<void>;
  badges: {
    /** Attribue les badges nouvellement obtenus. */
    award(): MaybePromise<BadgeAnnonce[]>;
    /** Catalogue complet, obtenus ou non. */
    catalogue(): MaybePromise<unknown>;
  };
}

/** Correcteur grammatical intégré (règles LanguageTool). */
export interface CorrecteurDeps {
  check(text: string): MaybePromise<LTMatch[]>;
}

/** Réglages du LLM. La clé API n'en sort jamais. */
export interface ReglagesDeps {
  /** Vue publique (sans la clé API). `editable` : modifiables (mode bureau). */
  vuePublique(): MaybePromise<ServerSettings>;
  /**
   * Applique et enregistre une modification déjà validée (`parseUpdate`) ;
   * appelée seulement si la vue est `editable`. Le client du modèle doit
   * ensuite utiliser les nouveaux réglages (adresse, clé).
   */
  mettreAJour(update: SettingsUpdate): MaybePromise<ServerSettings>;
}

/** Mots ajoutés au dictionnaire par l'utilisateur. */
export interface MotsValidesDeps {
  lire(): MaybePromise<string[]>;
  /** Ajoute un mot déjà validé, s'il est absent ; renvoie la liste à jour. Lève une erreur si l'enregistrement échoue. */
  ajouter(word: string): MaybePromise<string[]>;
}

/**
 * Un fragment du flux du modèle. `content` : texte de la réponse, affiché.
 * `reasoning` : fragment de raisonnement, compté mais jamais affiché.
 * `reasoningChunks` : nombre de fragments de raisonnement déjà comptés par
 * un relais qui ne les transmet pas (bureau : statistiques de fin du relais
 * Rust), ajouté au compteur.
 */
export interface FragmentModele {
  content?: string;
  reasoning?: string;
  reasoningChunks?: number;
}

/**
 * Erreur levée par le modèle : `status` (HTTP, si l'API a répondu) et
 * `message`, lus par `isThinkingParamRejection` pour relancer sans le
 * paramètre de raisonnement.
 */
export interface ErreurModele {
  status?: number | null;
  message: string;
}

/**
 * Accès de bas niveau au serveur du modèle, sans règle métier : le
 * gestionnaire choisit le modèle, coupe le raisonnement, relance, mesure et
 * met en forme le flux renvoyé à l'interface.
 *
 * Serveur : SDK OpenAI. Bureau : commandes Rust `llm_models`, `llm_chat`
 * (fragments par Channel) et `llm_cancel` (sur abandon du signal).
 */
export interface ModeleDeps {
  /**
   * Corps JSON de GET /v1/models (`{ data: [{ id, type? }] }`). Lève une
   * erreur lisible si le serveur du modèle est injoignable ou refuse.
   */
  listerModeles(): Promise<unknown>;
  /**
   * Envoie `corps` (corps de /v1/chat/completions, `stream: true`, prêt à
   * partir) et renvoie le flux des fragments. La promesse est rejetée avec une
   * `ErreurModele` si l'API refuse la requête avant le premier fragment
   * (par exemple 400 sur `chat_template_kwargs`) ; une erreur en cours de flux
   * est levée par l'itérateur. L'abandon de `signal` annule la requête.
   */
  ouvrirFlux(
    corps: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<AsyncIterable<FragmentModele>>;
  /**
   * Relais brut des autres routes /v1/* (serveur : même chemin chez le
   * modèle, avec sa clé). Le gestionnaire n'y ajoute que l'en-tête CORS.
   * Absent (bureau) : GET /v1/models est servi par `listerModeles`, les
   * autres routes répondent 404.
   */
  relayer?(req: Request): Promise<Response>;
}

export interface OptionsGestionnaire {
  /** Mode bureau : réglages modifiables. Le filtrage Host/Origine reste au serveur. */
  bureau: boolean;
  /**
   * Version publiée de Grammaria (« 0.5.0 »), inscrite dans l'export de la bêta.
   * Absente (développement, tests) : « 0.0.0 ».
   */
  versionApplication?: () => Promise<string>;
  /** Origines autorisées à lire les réponses (CORS), en plus des origines locales. */
  originesCors: readonly string[];
  /** `top_k` envoyé au modèle s'il est > 0 (-1 : désactivé, non envoyé). */
  llmTopK: number;
  /**
   * Annule la requête au modèle dès l'abandon du signal de la requête (`req.signal`), même
   * avant le premier fragment. Bureau seulement : la requête vient du pont, dont le signal est
   * celui de l'interface. Sans effet sur le serveur (non défini).
   */
  suivreAbandonRequete?: boolean;
  /** Horloge en millisecondes (Date.now par défaut). */
  horloge?: () => number;
  /**
   * Appelée à la fin de chaque correction réussie, avec ses seules mesures (jamais le texte).
   * Bureau : ligne de fin de correction du journal technique `grammaria.log` (le serveur
   * l'écrit sur sa sortie standard).
   */
  surFinCorrection?: (mesure: MesureCorrection) => void;
}

/** Mesures d'une correction terminée. */
export interface MesureCorrection {
  dureeMs: number;
  /** Délai avant le premier mot (null : aucun texte reçu). */
  premierMotMs: number | null;
  fragmentsRaisonnement: number;
  raisonnementCoupe: boolean;
}

export interface DependancesApi {
  journal: JournalDeps;
  correcteur: CorrecteurDeps;
  reglages: ReglagesDeps;
  motsValides: MotsValidesDeps;
  modele: ModeleDeps;
  options: OptionsGestionnaire;
}
