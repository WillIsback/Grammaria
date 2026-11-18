import react from "@vitejs/plugin-react";
import autoprefixer from "autoprefixer";
import tailwindcss from "tailwindcss";
import { defineConfig, lazyPlugins } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    printWidth: 100,
    // Le site Astro de documentation a son propre outillage.
    ignorePatterns: ["docs/**"],
  },
  lint: {
    plugins: ["typescript", "unicorn", "oxc", "react", "jsx-a11y"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    ignorePatterns: ["docs/**"],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      // Exceptions reprises de l'ancienne configuration Biome.
      "no-control-regex": "off",
      "jsx-a11y/no-noninteractive-element-to-interactive-role": "off",
      "jsx-a11y/prefer-tag-over-role": "off",
    },
    options: { typeAware: true, typeCheck: true },
  },
  plugins: lazyPlugins(() => [react()]),
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
  build: {
    outDir: "dist",
    sourcemap: false,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
  },
});
