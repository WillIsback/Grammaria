export const config = {
  port: Number(process.env.PORT ?? 25000),
  /**
   * Interface d'écoute. Par défaut 127.0.0.1 : le serveur n'est joignable que
   * depuis la machine. L'image Docker pose HOST=0.0.0.0 (le conteneur doit
   * écouter toutes ses interfaces pour recevoir le port publié), et l'exposition
   * est alors maîtrisée par la publication du port (127.0.0.1:25000 par défaut
   * dans le docker-compose.yml généré). Exposer sur le réseau exige un proxy
   * inverse authentifiant : le serveur n'a pas d'authentification.
   */
  host: process.env.HOST ?? "127.0.0.1",
  /**
   * Mode bureau (GRAMMARIA_DESKTOP=1) : serveur local d'un seul utilisateur, lancé sans
   * Docker ; réglages du LLM modifiables depuis l'interface, requêtes d'autres hôtes ou
   * origines refusées. L'application de bureau, elle, n'utilise plus le serveur Bun.
   */
  desktop: process.env.GRAMMARIA_DESKTOP === "1",
  /** Fichiers de l'interface (défaut : `dist/` à côté de server.ts). */
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
