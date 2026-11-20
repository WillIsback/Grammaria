/**
 * Politique de sécurité du bureau et constructions qu'elle interdit dans le code livré.
 * Utilisé par les tests du build (tests/unit/desktop.build.test.ts).
 */

/**
 * Politique de la WebView (celle du prototype #18, sans les adresses IPC de Tauri) : ni
 * `unsafe-eval` ni `wasm-unsafe-eval`.
 */
export const CSP_BUREAU = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** Constructions qui évaluent ou compilent du code (refusées sans `unsafe-eval`). */
export const CONSTRUCTIONS_INTERDITES: { nom: string; motif: RegExp }[] = [
  { nom: "eval(", motif: /(?<![\w$.])eval\s*\(/g },
  { nom: "new Function", motif: /\bnew\s+Function\s*\(/g },
  { nom: "Function(…)", motif: /(?<![\w$.])Function\s*\(/g },
  { nom: "minuteur à chaîne", motif: /\bset(?:Timeout|Interval)\s*\(\s*["'`]/g },
  { nom: "import dynamique", motif: /(?<![\w$.])import\s*\(/g },
  { nom: "WebAssembly", motif: /\bWebAssembly\.(?:compile|instantiate|Module)\b/g },
];

/** Occurrences des constructions interdites dans `source`, avec un extrait autour. */
export function constructionsInterdites(source: string): { nom: string; extrait: string }[] {
  const trouvees: { nom: string; extrait: string }[] = [];
  for (const { nom, motif } of CONSTRUCTIONS_INTERDITES) {
    for (const m of source.matchAll(motif)) {
      trouvees.push({ nom, extrait: source.slice(Math.max(0, m.index - 40), m.index + 40) });
    }
  }
  return trouvees;
}
