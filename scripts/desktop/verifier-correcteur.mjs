#!/usr/bin/env node
/**
 * Vérifie le correcteur de l'application de bureau tel qu'il est livré (dist/bureau/lt/) :
 *
 *  1. paquet du Worker : aucune construction qui évalue du code (`eval`, `new Function`,
 *     `Function(…)`, minuteur à chaîne), aucun import dynamique ni WebAssembly à compiler ;
 *  2. dans Chromium (Playwright, navigateur préinstallé : ce script ne télécharge rien), sous une
 *     politique de sécurité stricte, celle du bureau (ni `unsafe-eval` ni `wasm-unsafe-eval`) :
 *     - le témoin `new Function` est bien refusé dans la page et dans un Worker ;
 *     - les détections du Worker (façade src/desktop/correcteur.ts) sont identiques à la
 *       référence du serveur (tests/fixtures/correcteur/reference.json) sur tout le corpus ;
 *     - le moteur n'a demandé aucune ressource qui existe dans ltjs mais manque à l'archive ;
 *     - archive absente, abîmée ou tronquée, Worker introuvable : erreur lisible et rapide ;
 *     - mesures : tailles, chargement des règles, premier contrôle et suivants (160 et ~900
 *       mots), fil principal, mémoire.
 *
 * Node ≥ 22.18 seulement (pas de Bun). Usage, après `npm run build:bureau` (ou `vp build --mode bureau`) :
 *   node scripts/desktop/verifier-correcteur.mjs [--dossier dist/bureau/lt] [--json sortie.json]
 * Sort en erreur au premier critère non tenu.
 */
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
// Node ≥ 22.18 exécute directement ce module TypeScript (types effacés).
import { CONSTRUCTIONS_INTERDITES, CSP_BUREAU as CSP } from "./csp-bureau.ts";

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const option = (nom) => {
  const i = args.indexOf(nom);
  return i >= 0 ? args[i + 1] : undefined;
};
const DOSSIER = resolve(RACINE, option("--dossier") ?? "dist/bureau/lt");
const SORTIE_JSON = option("--json");

let echecs = 0;
const ok = (condition, message) => {
  console.log(`${condition ? "OK  " : "ÉCHEC"} ${message}`);
  if (!condition) echecs++;
  return condition;
};
const mo = (octets) => `${(octets / 1048576).toFixed(2)} Mo`;

// ───────────────────────── 1. Paquet produit ─────────────────────────
const cheminWorker = join(DOSSIER, "worker.js");
const cheminArchive = join(DOSSIER, "fr.pack");
let worker;
let archive;
try {
  worker = readFileSync(cheminWorker);
  archive = readFileSync(cheminArchive);
} catch {
  console.error(
    `Build du bureau absent (${DOSSIER}) : lancer d'abord \`npm run build:bureau\` ou \`npx vp build --mode bureau\`.`,
  );
  process.exit(2);
}
const sourceWorker = worker.toString("utf8");
for (const { nom, motif } of CONSTRUCTIONS_INTERDITES) {
  const trouves = [...sourceWorker.matchAll(motif)].map((m) =>
    sourceWorker.slice(Math.max(0, m.index - 40), m.index + 40),
  );
  ok(trouves.length === 0, `worker.js sans ${nom}${trouves.length ? ` : ${trouves[0]}` : ""}`);
}
const fichiersLt = readdirSync(DOSSIER).sort();
ok(
  JSON.stringify(fichiersLt) === JSON.stringify(["fr.pack", "worker.js"]),
  `dist/bureau/lt ne contient que worker.js et fr.pack (${fichiersLt.join(", ")})`,
);
const brotli = (octets) =>
  brotliCompressSync(octets, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_SIZE_HINT]: octets.length,
    },
  }).length;
const tailles = {
  workerOctets: worker.length,
  workerGzip: gzipSync(worker, { level: 9 }).length,
  workerBrotli: brotli(worker),
  archiveOctets: archive.length,
  archiveGzip: gzipSync(archive, { level: 9 }).length,
  archiveBrotli: brotli(archive),
};
console.log(
  `     tailles : worker.js ${mo(tailles.workerOctets)} (gzip ${mo(tailles.workerGzip)}, brotli ${mo(tailles.workerBrotli)}) ; ` +
    `fr.pack ${mo(tailles.archiveOctets)} (gzip ${mo(tailles.archiveGzip)}, brotli ${mo(tailles.archiveBrotli)})`,
);

// ───────────────────────── 2. Page de vérification (Vite+) ─────────────────────────
const temporaire = mkdtempSync(join(tmpdir(), "grammaria-verifier-"));
const { build } = await import("vite-plus");
await build({
  configFile: false,
  logLevel: "warn",
  root: RACINE,
  publicDir: false,
  build: {
    outDir: temporaire,
    emptyOutDir: true,
    minify: false,
    target: "es2022",
    rolldownOptions: {
      input: join(RACINE, "scripts/desktop/verifier-page.ts"),
      output: { entryFileNames: "verifier.js", codeSplitting: false },
    },
  },
});
const scriptPage = readFileSync(join(temporaire, "verifier.js"));
rmSync(temporaire, { recursive: true, force: true });

const reference = JSON.parse(
  readFileSync(join(RACINE, "tests/fixtures/correcteur/reference.json"), "utf8"),
);

// Archive abîmée (un octet de données inversé) et tronquée, pour les cas d'erreur.
const abimee = Buffer.from(archive);
abimee[abimee.length - 1000] ^= 0xff;
const tronquee = archive.subarray(0, Math.floor(archive.length / 2));

const PAGE = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>chargement</title>
<script type="module" src="/verifier.js"></script></head><body>Vérification du correcteur</body></html>`;
const SONDE = `let bloque = false;
try { new Function("return 1")(); } catch { bloque = true; }
postMessage(bloque);`;

const serveur = createServer((req, res) => {
  const chemin = new URL(req.url, "http://localhost").pathname;
  const envoyer = (statut, type, corps) => {
    res.writeHead(statut, {
      "Content-Type": type,
      "Content-Security-Policy": CSP,
      "Cache-Control": "no-store",
    });
    res.end(corps);
  };
  const js = "text/javascript; charset=utf-8";
  const binaire = "application/octet-stream";
  if (chemin === "/") return envoyer(200, "text/html; charset=utf-8", PAGE);
  if (chemin === "/verifier.js") return envoyer(200, js, scriptPage);
  if (chemin === "/sonde-worker.js") return envoyer(200, js, SONDE);
  const cas = /^\/(?:(absente|abimee|tronquee|rien)\/)?lt\/(worker\.js|fr\.pack)$/.exec(chemin);
  if (cas) {
    const [, variante, fichier] = cas;
    if (variante === "rien") return envoyer(404, "text/plain", "absent");
    if (fichier === "worker.js") return envoyer(200, js, worker);
    if (variante === "absente") return envoyer(404, "text/plain", "absent");
    if (variante === "abimee") return envoyer(200, binaire, abimee);
    if (variante === "tronquee") return envoyer(200, binaire, tronquee);
    return envoyer(200, binaire, archive);
  }
  envoyer(404, "text/plain", "absent");
});
await new Promise((ok) => serveur.listen(0, "127.0.0.1", ok));
const base = `http://127.0.0.1:${serveur.address().port}`;

// ───────────────────────── 3. Chromium ─────────────────────────
const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require("playwright");
} catch {
  playwright = require(require.resolve("playwright", { paths: ["/opt/node-tools/node_modules"] }));
}
const navigateur = await playwright.chromium.launch({
  // Tailles de tas exactes (performance.memory) pour la mesure de mémoire.
  args: ["--enable-precise-memory-info"],
});
const resultat = { tailles, csp: CSP };
try {
  const page = await navigateur.newPage();
  const consoleWorker = [];
  page.on("console", (m) => consoleWorker.push(`${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => consoleWorker.push(`erreur de page : ${e.message}`));
  await page.goto(base);
  await page.waitForFunction(() => document.title === "prêt");
  resultat.navigateur = await page.evaluate(() => navigator.userAgent);

  // Sécurité.
  resultat.securite = await page.evaluate(() => globalThis.verifier.securite());
  ok(resultat.securite.evalBloqueDansLaPage, "CSP active : new Function refusé dans la page");
  ok(resultat.securite.evalBloqueDansUnWorker, "CSP active : new Function refusé dans un Worker");

  // Corpus.
  const textes = reference.textes.map(({ nom, texte }) => ({ nom, texte }));
  const texte = (nom) => reference.textes.find((t) => t.nom === nom).texte;
  const corpus = await page.evaluate(
    ([t, m]) => globalThis.verifier.corpus(t, m),
    [textes, { court: texte("marche-160-mots"), long: texte("long") }],
  );
  const resumer = (m) => ({
    regle: m.rule.id,
    debut: m.offset,
    longueur: m.length,
    message: m.message,
    suggestions: m.replacements.slice(0, 5).map((r) => r.value),
  });
  let identiques = 0;
  for (const attendu of reference.textes) {
    const obtenu = (corpus.resultats[attendu.nom] ?? []).map(resumer);
    const egal = JSON.stringify(obtenu) === JSON.stringify(attendu.detections);
    if (egal) identiques++;
    else {
      const cle = (d) => `${d.regle}@${d.debut}+${d.longueur}`;
      ok(
        false,
        `${attendu.nom} : écart ${JSON.stringify({
          serveur: attendu.detections.map(cle),
          worker: obtenu.map(cle),
        })}`,
      );
    }
  }
  const totalDetections = reference.textes.reduce((n, t) => n + t.detections.length, 0);
  ok(
    identiques === reference.textes.length,
    `détections identiques à la référence du serveur : ${identiques}/${reference.textes.length} textes, ${totalDetections} détections (règle, position, longueur, message, suggestions, ordre)`,
  );

  // Ressources : un nom absent de l'archive ne doit exister nulle part dans ltjs.
  const existantes = new Set();
  const parcourir = (dossier, prefixe = "") => {
    for (const e of readdirSync(dossier, { withFileTypes: true })) {
      if (e.isDirectory()) parcourir(join(dossier, e.name), `${prefixe}${e.name}/`);
      else existantes.add(`${prefixe}${e.name}`);
    }
  };
  for (const paquet of ["@valueerror/ltjs-core", "@valueerror/ltjs-lang-fr"]) {
    parcourir(join(dirname(require.resolve(`${paquet}/package.json`)), "resources"));
  }
  const manquantes = corpus.absentes.filter((nom) => existantes.has(nom));
  ok(
    manquantes.length === 0,
    `aucune ressource de ltjs demandée et absente de l'archive (${corpus.absentes.length} noms absents partout, ex. ${corpus.absentes.slice(0, 3).join(", ")})${manquantes.length ? ` — MANQUANTES : ${manquantes.join(", ")}` : ""}`,
  );
  delete corpus.resultats;
  resultat.corpus = corpus;

  // Robustesse.
  resultat.robustesse = await page.evaluate(() => globalThis.verifier.robustesse());
  const r = resultat.robustesse;
  ok(
    /introuvable.*HTTP 404/.test(r.archiveAbsente.message) && r.archiveAbsente.etat === "erreur",
    `archive absente : « ${r.archiveAbsente.message} » (${r.archiveAbsente.ms} ms)`,
  );
  ok(
    /somme de contrôle/.test(r.archiveAbimee.message),
    `archive abîmée : « ${r.archiveAbimee.message} » (${r.archiveAbimee.ms} ms)`,
  );
  ok(
    /tronqué/.test(r.archiveTronquee.message),
    `archive tronquée : « ${r.archiveTronquee.message} » (${r.archiveTronquee.ms} ms)`,
  );
  ok(
    /n'a pas pu charger ses règles/.test(r.workerAbsent.message),
    `Worker introuvable : « ${r.workerAbsent.message} » (${r.workerAbsent.ms} ms)`,
  );
  ok(
    corpus.filPrincipalEcartMaxMs.chargement < 250 && corpus.filPrincipalEcartMaxMs.controles < 250,
    `fil principal libre : écart maximal entre deux tics de 10 ms = ${corpus.filPrincipalEcartMaxMs.chargement} ms pendant le chargement, ${corpus.filPrincipalEcartMaxMs.controles} ms pendant les contrôles`,
  );

  // Seule violation attendue : le témoin `new Function` de la page (type « eval »).
  resultat.violationsCsp = await page.evaluate(() => globalThis.verifier.violations());
  const autres = resultat.violationsCsp.filter((v) => !v.endsWith(" ← eval"));
  ok(
    autres.length === 0 && resultat.violationsCsp.length === 1,
    `aucune violation de CSP hors du témoin (${resultat.violationsCsp.join(" ; ")})`,
  );
  await page.close();

  // Mémoire (page neuve) : mémoire résidente des processus de rendu de Chromium (la page et son
  // Worker y tournent), avant et après le chargement du correcteur ; tas JavaScript de la page.
  const navigateurCdp = await navigateur.newBrowserCDPSession();
  const residente = async () => {
    const { processInfo } = await navigateurCdp.send("SystemInfo.getProcessInfo");
    let total = 0;
    for (const { id, type } of processInfo) {
      if (type !== "renderer") continue;
      try {
        total +=
          Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${id}/status`, "utf8"))[1]) * 1024;
      } catch {
        return null; // hors Linux
      }
    }
    return total;
  };
  const pageMemoire = await navigateur.newPage();
  const cdp = await pageMemoire.context().newCDPSession(pageMemoire);
  await pageMemoire.goto(base);
  await pageMemoire.waitForFunction(() => document.title === "prêt");
  const tasPage = async () => {
    await cdp.send("HeapProfiler.collectGarbage");
    return (await cdp.send("Runtime.getHeapUsage")).usedSize;
  };
  const memoireAvant = { residente: await residente(), tas: await tasPage() };
  await pageMemoire.evaluate(
    (t) => globalThis.verifier.demarrerPourMemoire(t),
    texte("marche-160-mots"),
  );
  resultat.memoire = {
    residenteAvantOctets: memoireAvant.residente,
    residenteApresOctets: await residente(),
    tasPageAvantOctets: memoireAvant.tas,
    tasPageApresOctets: await tasPage(),
  };
  await pageMemoire.close();
  if (echecs) console.log(consoleWorker.slice(-20).join("\n"));
} finally {
  await navigateur.close();
  serveur.close();
}

const c = resultat.corpus;
const m = resultat.memoire;
const mediane = (v) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
console.log(`
Mesures (${resultat.navigateur})
  chargement : archive ${c.chargement.archiveMs.toFixed(0)} ms, lecture ${c.chargement.lectureMs.toFixed(0)} ms, règles ${c.chargement.reglesMs.toFixed(0)} ms, total ${c.chargement.totalMs.toFixed(0)} ms (${c.chargement.fichiers} fichiers)
  premier contrôle (160 mots) depuis le lancement : ${c.premierControleDepuisLancementMs} ms
  contrôles 160 mots : ${c.controles160MotsMs.join(" / ")} ms (médiane des suivants ${mediane(c.controles160MotsMs.slice(1))} ms)
  contrôles ~900 mots : ${c.controles900MotsMs.join(" / ")} ms (médiane des suivants ${mediane(c.controles900MotsMs.slice(1))} ms)
  mémoire : processus de rendu (page + Worker) ${m.residenteAvantOctets === null ? "non mesurable hors Linux" : `${mo(m.residenteAvantOctets)} avant, ${mo(m.residenteApresOctets)} avec le correcteur prêt (+${mo(m.residenteApresOctets - m.residenteAvantOctets)})`} ; tas JavaScript de la page ${mo(m.tasPageAvantOctets)} → ${mo(m.tasPageApresOctets)}`);
if (SORTIE_JSON) writeFileSync(SORTIE_JSON, `${JSON.stringify(resultat, null, 1)}\n`);
console.log(echecs ? `\n${echecs} critère(s) non tenu(s)` : "\nCorrecteur du bureau vérifié.");
process.exit(echecs ? 1 : 0);
