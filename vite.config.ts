import react from "@vitejs/plugin-react";
import autoprefixer from "autoprefixer";
import tailwindcss from "tailwindcss";
import { defineConfig, lazyPlugins } from "vite-plus";
import { construireArchiveLt } from "./scripts/desktop/pack-lt.ts";

/**
 * Build du correcteur de l'application de bureau (`vp build --mode bureau`, après le build de
 * l'interface dans dist/bureau : voir le script `build:bureau` de package.json).
 *
 * Mode séparé plutôt qu'un `new Worker(new URL(...))` dans l'interface : le build web habituel
 * (`vp build`) ne produit ni le Worker (environ 1 Mo) ni l'archive des règles (environ 14 Mo).
 * Produit dist/bureau/lt/worker.js (Worker module, minifié) et dist/bureau/lt/fr.pack.
 *
 * Noms non conservés (pas de `keepNames`) : le portage de LanguageTool enregistre ses classes
 * sous leur nom Java écrit en toutes lettres (`static FQCN`, ClassBroker) ; `constructor.name`
 * ne sert qu'en repli d'une clé de cache (les langues ont un FQCN) et dans un `toString` de
 * débogage. Vérifié : mêmes détections que le serveur sur tout le corpus
 * (scripts/desktop/verifier-correcteur.mjs), pour 60 ko de moins.
 */
const buildBureau = {
  outDir: "dist/bureau/lt",
  emptyOutDir: true,
  copyPublicDir: false,
  sourcemap: false,
  target: "es2022",
  // Build d'application plutôt que `build.lib` : en mode bibliothèque, le format ES n'est pas
  // minifié (espaces conservés), soit 2,2 Mo au lieu de 1,1 Mo.
  minify: true,
  // Un Worker unique d'environ 1 Mo, chargé une fois au démarrage : pas d'avertissement.
  chunkSizeWarningLimit: 1500,
  rolldownOptions: {
    input: "src/desktop/lt.worker.ts",
    output: {
      format: "es" as const,
      entryFileNames: "worker.js",
      // Un seul fichier : un Worker module ne charge rien d'autre que l'archive.
      codeSplitting: false,
    },
  },
};

/**
 * Plugins du build du bureau :
 * - l'archive des ressources de LanguageTool (scripts/desktop/pack-lt.ts) est ajoutée au build ;
 * - le module Hunspell (WebAssembly, 0,5 Mo, et son chargeur) est remplacé par un module vide :
 *   le français utilise Morfologik et le Worker ne l'initialise pas (`hunspellWasm: false`).
 */
const pluginsBureau = () => [
  {
    name: "grammaria:archive-lt",
    generateBundle(this: { emitFile(file: object): string }) {
      this.emitFile({ type: "asset", fileName: "fr.pack", source: construireArchiveLt().octets });
    },
  },
  {
    name: "grammaria:sans-hunspell",
    enforce: "pre" as const,
    load(id: string) {
      if (!/[\\/]ltjs-core[\\/]src[\\/]lib[\\/]hunspell[\\/]wasm[\\/]hunspell\.js$/.test(id))
        return null;
      return `export default async function () {
        throw new Error("Hunspell n'est pas embarqué dans le correcteur du bureau.");
      }`;
    },
  },
];

export default defineConfig(({ mode }) => ({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    printWidth: 100,
    // Projets annexes (site Astro, évaluations Python) et données générées.
    ignorePatterns: ["docs/**", "eval/**", "benchmark/**", "public/**"],
  },
  lint: {
    plugins: ["typescript", "unicorn", "oxc", "react", "jsx-a11y"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    ignorePatterns: ["docs/**", "eval/**", "public/**"],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      // Exceptions reprises de l'ancienne configuration Biome.
      "no-control-regex": "off",
      "jsx-a11y/no-noninteractive-element-to-interactive-role": "off",
      "jsx-a11y/prefer-tag-over-role": "off",
    },
    options: { typeAware: true, typeCheck: true },
  },
  plugins: mode === "bureau" ? pluginsBureau() : lazyPlugins(() => [react()]),
  css: {
    postcss: {
      plugins: [
        tailwindcss({
          content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
          darkMode: "class",
          theme: {
            extend: {
              colors: {
                brand: {
                  50: "#eff6ff",
                  100: "#dbeafe",
                  200: "#bfdbfe",
                  300: "#93c5fd",
                  400: "#60a5fa",
                  500: "#3b82f6",
                  600: "#2563eb",
                  700: "#1d4ed8",
                  800: "#1e40af",
                  900: "#1e3a5f",
                },
                surface: {
                  50: "#fafbfc",
                  100: "#f1f5f9",
                  200: "#e2e8f0",
                  300: "#cbd5e1",
                },
              },
              borderRadius: {
                xl: "0.875rem",
                "2xl": "1rem",
                "3xl": "1.25rem",
              },
              boxShadow: {
                subtle: "0 1px 3px rgba(0,0,0,0.04), 0 1px 2px rgba(0,0,0,0.02)",
                card: "0 2px 8px rgba(0,0,0,0.04), 0 1px 2px rgba(0,0,0,0.03)",
                elevated: "0 4px 16px rgba(0,0,0,0.06), 0 2px 4px rgba(0,0,0,0.03)",
                glow: "0 0 20px rgba(59,130,246,0.15)",
              },
              fontFamily: {
                sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "sans-serif"],
              },
            },
          },
          plugins: [],
        }),
        autoprefixer(),
      ],
    },
  },
  base: "./",
  server: {
    port: 25001,
    host: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:25000",
        changeOrigin: true,
        secure: false,
      },
      "/v1": {
        target: "http://127.0.0.1:25000",
        changeOrigin: true,
        secure: false,
      },
    },
  },
  build:
    mode === "bureau"
      ? buildBureau
      : {
          outDir: "dist",
          sourcemap: false,
        },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
  },
}));
