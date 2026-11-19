import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

// Regression test for the v1.5.14 incident (2026-10-23): server.ts imported a
// new ./src/utils/llmJson.ts, but the runtime stage of the Dockerfile copies
// server files one by one, so the container crash-looped with
// "Cannot find module './src/utils/llmJson.ts'". Every relative import of the
// server entrypoint must be copied into the runtime image.

const root = join(import.meta.dirname, "../..");
const dockerfile = readFileSync(join(root, "Dockerfile"), "utf-8");
// Les fichiers du journal importent à leur tour leurs modules (règles, badges,
// pilote) : leurs imports sont vérifiés aussi.
const serverSource = [
  "server.ts",
  "journal.ts",
  "journal.rules.ts",
  "journal.badges.ts",
  "journal.driver.bun.ts",
]
  .map((file) => readFileSync(join(root, file), "utf-8"))
  .join("\n");

describe("Dockerfile runtime stage", () => {
  const copied = dockerfile
    .split("\n")
    .filter((line) => line.startsWith("COPY ") && !line.includes("--from="))
    .flatMap((line) => line.split(/\s+/).slice(1, -1));

  const localImports = [...serverSource.matchAll(/from "\.\/([^"]+)"|import "\.\/([^"]+)"/g)].map(
    (m) => m[1] ?? m[2],
  );

  // A file is covered when it is copied by name or when its directory is.
  const isCopied = (file: string) =>
    copied.some((entry) => entry === file || file.startsWith(`${entry.replace(/\/$/, "")}/`));

  it.each([...new Set(localImports)])("copies %s imported by the server", (file) => {
    expect(isCopied(file), `${file} is missing from the runtime image`).toBe(true);
  });
});
