#!/usr/bin/env node
/**
 * Vérifie les résultats de l'autotest de l'application de bureau (JSON écrit par la page
 * d'autotest, src/desktop/autotest.ts, quand l'application est lancée avec
 * GRAMMARIA_AUTOTEST_OUT=<fichier>). Node seul, sans dépendance.
 *
 * Usage : node scripts/desktop/verifier-autotest.mjs <autotest.json> [--webview webkit|webview2]
 *   --webview : moteur attendu (défaut : webview2 sous Windows, webkit ailleurs), vérifié sur
 *               `navigator.userAgent` (« Edg/ » pour WebView2).
 *
 * Critères (code de sortie 1 si l'un n'est pas tenu, 2 si le fichier est absent ou illisible) :
 *  - page terminée, aucun critère de la page en échec, aucune erreur d'étape ni de page ;
 *  - détections IDENTIQUES à tests/fixtures/correcteur/reference.json (recomparées ici, à partir
 *    du fichier du dépôt) ; premier contrôle < 30 s, contrôles suivants (160 mots) < 3 s ;
 *  - journal : schéma 3, aucun mot des textes corrigés dans les octets du fichier de la base
 *    (ni dans le WAL), lot atomique écrit, lots refusés sans rien écrire, conflit reconnu ;
 *  - réglages : clé API absente des réponses à la page, reçue par le modèle ;
 *  - flux : 3000 fragments dans l'ordre, annulations vues par le modèle, relance sans
 *    chat_template_kwargs, interruption d'une correction ;
 *  - aucune violation de la CSP ; moteur de la WebView attendu.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const option = (nom) => {
  const i = args.indexOf(nom);
  return i >= 0 ? args[i + 1] : undefined;
};
const chemin = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--webview");
if (!chemin) {
  console.error(
    "Usage : node scripts/desktop/verifier-autotest.mjs <autotest.json> [--webview webkit|webview2]",
  );
  process.exit(2);
}
const webview = option("--webview") ?? (process.platform === "win32" ? "webview2" : "webkit");

let r;
try {
  r = JSON.parse(readFileSync(chemin, "utf8"));
} catch (error) {
  console.error(`ÉCHEC résultats illisibles ou absents (${chemin}) : ${error.message}`);
  process.exit(2);
}

let echecs = 0;
const ok = (condition, message, detail) => {
  console.log(`${condition ? "OK  " : "ÉCHEC"} ${message}`);
  if (!condition) {
    echecs++;
    if (detail !== undefined) console.log(`      ${JSON.stringify(detail).slice(0, 800)}`);
  }
  return condition;
};

ok(r.termine === true, "autotest terminé", r.erreurs);
ok((r.erreurs ?? []).length === 0, "aucune erreur d'étape", r.erreurs);
ok((r.erreursPage ?? []).length === 0, "aucune erreur de page", r.erreursPage);
const criteres = r.criteres ?? [];
ok(criteres.length > 0, `critères de la page présents (${criteres.length})`);
for (const c of criteres.filter((c) => !c.ok)) ok(false, `page : ${c.nom}`, c.detail);

// Correcteur : recomparaison avec la référence du dépôt.
const reference = JSON.parse(
  readFileSync(join(RACINE, "tests/fixtures/correcteur/reference.json"), "utf8"),
);
const detections = r.correcteur?.detections ?? {};
// Champs dans un ordre fixe : l'application réécrit le JSON (clés triées).
const canonique = (liste) =>
  JSON.stringify(
    (liste ?? null) && liste.map((d) => [d.regle, d.debut, d.longueur, d.message, d.suggestions]),
  );
const differents = reference.textes
  .filter(({ nom, detections: attendues }) => canonique(detections[nom]) !== canonique(attendues))
  .map(({ nom }) => nom);
ok(
  differents.length === 0,
  `détections identiques à la référence du dépôt (${reference.textes.length - differents.length}/${reference.textes.length} textes)`,
  differents,
);
const premier = r.correcteur?.premierControle?.dureeMs;
ok(typeof premier === "number" && premier < 30_000, `premier contrôle < 30 s (${premier} ms)`);
const suivants = r.correcteur?.controlesSuivants160MotsMs?.max;
ok(
  typeof suivants === "number" && suivants < 3_000,
  `contrôles suivants < 3 s (max ${suivants} ms)`,
);

// Journal.
ok(r.journal?.userVersion === 3, "schéma du journal en version 3", r.journal?.userVersion);
ok(
  Array.isArray(r.journal?.textesTrouves) && r.journal.textesTrouves.length === 0,
  "aucun texte de l'utilisateur dans le fichier du journal",
  r.journal?.textesTrouves,
);
const refus = r.journal?.refus ?? {};
ok(
  Object.keys(refus).length >= 4 && Object.values(refus).every((m) => m !== "ACCEPTÉ"),
  "lots et lectures interdits refusés",
  refus,
);
ok(
  String(refus.gardeExpectChanges ?? "").startsWith("Conflit :"),
  "garde expectChanges : « Conflit : »",
);

// Réglages.
ok(
  r.reglages?.vue?.hasApiKey === true && !("llmApiKey" in (r.reglages?.vue ?? {})),
  "clé API absente de la vue des réglages",
);
ok(r.reglages?.cleRecueParLeModele === true, "clé API reçue par le modèle");

// Modèle.
const m = r.modele ?? {};
ok(
  m.debit?.fragments === 3000 && m.debit?.ordreRespecte === true,
  "3000 fragments dans l'ordre",
  m.debit,
);
ok(
  m.annulation?.erreur === "AbortError" &&
    m.annulation?.apresAnnulation === 0 &&
    m.annulation?.coupeesVuesParLeModele === 1,
  "annulation pendant le flux",
  m.annulation,
);
ok(
  m.annulationAvantPremierFragment?.coupeesVuesParLeModele === 1,
  "annulation avant le premier fragment",
  m.annulationAvantPremierFragment,
);
ok(
  JSON.stringify(m.relance?.avecParametre) === "[true,false]" && m.relance?.ensuite === false,
  "relance sans chat_template_kwargs, refus retenu",
  m.relance,
);
ok(
  m.interruption?.premiere === "Correction remplacée par une nouvelle demande." &&
    m.interruption?.coupeesVuesParLeModele === 1,
  "interruption d'une correction",
  m.interruption,
);

// Sécurité et moteur.
ok((r.cspViolations ?? null)?.length === 0, "aucune violation de la CSP", r.cspViolations);
ok(
  r.acces?.temoins?.fetchDirect?.startsWith("refusé") &&
    r.acces?.temoins?.evaluation?.startsWith("refusé"),
  "témoins bloqués par la CSP (fetch direct, évaluation)",
);
const ua = String(r.userAgent ?? "");
ok(
  webview === "webview2" ? /Edg\//.test(ua) : /AppleWebKit/.test(ua) && !/Chrome|Edg\//.test(ua),
  `moteur ${webview} (${ua})`,
);

console.log(
  `\nTemps : interface montée à ${r.interface?.monteeDepuisLancementMs} ms ; correcteur chargé en ` +
    `${r.correcteur?.chargement?.chargementMs} ms ; premier contrôle ${premier} ms (réponse à ` +
    `${r.correcteur?.premierControle?.depuisLancementMs} ms du lancement de la page) ; contrôles suivants ` +
    `médiane ${r.correcteur?.controlesSuivants160MotsMs?.mediane} ms ; 3000 fragments en ${m.debit?.totalMs} ms ; ` +
    `autotest complet ${r.dureeMs} ms.`,
);
console.log(echecs === 0 ? "Autotest réussi." : `${echecs} critère(s) non tenu(s).`);
process.exit(echecs === 0 ? 0 : 1);
