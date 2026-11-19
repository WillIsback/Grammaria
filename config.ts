export const config = {
  port: Number(process.env.PORT ?? 25000),
  /** Interface d'écoute ; l'application de bureau impose 127.0.0.1. */
  host: process.env.HOST ?? "0.0.0.0",
  /**
   * Mode bureau (GRAMMARIA_DESKTOP=1) : serveur local d'un seul utilisateur,
   * réglages du LLM modifiables depuis l'interface, requêtes d'autres origines refusées.
   */
  desktop: process.env.GRAMMARIA_DESKTOP === "1",
  /** Fichiers de l'interface ; obligatoire pour l'exécutable compilé. */
  distDir: process.env.GRAMMARIA_DIST_DIR ?? "",
  validWordsPath: process.env.GRAMMARIA_VALID_WORDS_PATH ?? "",
  /** Réglages du LLM enregistrés par l'interface (mode bureau). */
  settingsPath: process.env.GRAMMARIA_SETTINGS_PATH ?? "",
  llmTarget: process.env.LLM_TARGET ?? "http://127.0.0.1:30000",
  llmApiKey: process.env.LLM_API_KEY ?? "",
  llmModelName: process.env.LLM_MODEL_NAME ?? "",
  llmDisableThinking: process.env.LLM_DISABLE_THINKING !== "false",
  corsOrigins: (process.env.CORS_ORIGIN ?? "").split(",").filter(Boolean),
  otelEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "",
  llmTopK: Number(process.env.LLM_TOP_K ?? -1),
  journalPath: process.env.JOURNAL_PATH ?? "./data/grammaria.db",
};
