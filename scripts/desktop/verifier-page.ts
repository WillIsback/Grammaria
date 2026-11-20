/**
 * Page de vérification du correcteur du bureau, exécutée dans Chromium par
 * scripts/desktop/verifier-correcteur.mjs (qui la construit avec Vite+ et la sert sous une
 * politique de sécurité stricte). Utilise la façade de production (src/desktop/correcteur.ts)
 * et le Worker de production (dist/bureau/lt/worker.js).
 */
import { CorrecteurBureau } from "../../src/desktop/correcteur.ts";
import type { LTMatch } from "../../src/types.ts";

const maintenant = () => performance.now();
const arrondi = (n: number) => Math.round(n * 10) / 10;

/** Fil principal : plus grand écart entre deux tics d'un minuteur de 10 ms. */
function surveillerFil() {
  let dernier = maintenant();
  let ecartMax = 0;
  const minuteur = setInterval(() => {
    const t = maintenant();
    ecartMax = Math.max(ecartMax, t - dernier);
    dernier = t;
  }, 10);
  return () => {
    clearInterval(minuteur);
    return arrondi(ecartMax);
  };
}

const violations: string[] = [];
document.addEventListener("securitypolicyviolation", (e) => {
  violations.push(`${e.violatedDirective} ← ${e.blockedURI || e.sourceFile}`);
});

/** La politique de la page interdit-elle bien l'évaluation de code ? (témoin) */
function evalBloqueDansLaPage(): boolean {
  try {
    // Témoin volontaire : doit être refusé par la CSP.
    // oxlint-disable-next-line typescript/no-implied-eval
    new Function("return 1")();
    return false;
  } catch {
    return true;
  }
}

/** Même témoin dans un Worker servi avec les mêmes en-têtes que celui du correcteur. */
function evalBloqueDansUnWorker(): Promise<boolean> {
  return new Promise((resolve) => {
    const sonde = new Worker("/sonde-worker.js", { type: "module" });
    sonde.onmessage = (event: MessageEvent<boolean>) => {
      resolve(event.data);
      sonde.terminate();
    };
  });
}

interface TexteCorpus {
  nom: string;
  texte: string;
}

async function corpus(textes: TexteCorpus[], mesures: { court: string; long: string }) {
  const correcteur = new CorrecteurBureau({ urlWorker: "/lt/worker.js" });
  const finFilChargement = surveillerFil();
  const t0 = maintenant();
  // Premier contrôle demandé tout de suite : son temps inclut le chargement des règles.
  const premier = correcteur.check(mesures.court);
  await premier;
  const premierDepuisLancementMs = arrondi(maintenant() - t0);
  const filPendantChargementMs = finFilChargement();

  const chronometrer = async (texte: string, fois: number) => {
    const durees: number[] = [];
    for (let i = 0; i < fois; i++) {
      const t = maintenant();
      await correcteur.check(texte);
      durees.push(arrondi(maintenant() - t));
    }
    return durees;
  };
  const finFilControles = surveillerFil();
  const court = await chronometrer(mesures.court, 6);
  const long = await chronometrer(mesures.long, 6);
  const filPendantControlesMs = finFilControles();

  // Plusieurs demandes à la fois : file d'attente, réponses dans l'ordre des demandes.
  const resultats: Record<string, LTMatch[]> = {};
  await Promise.all(
    textes.map(async ({ nom, texte }) => {
      resultats[nom] = await correcteur.check(texte);
    }),
  );
  const absentes = await correcteur.diagnostic();
  const mesuresChargement = correcteur.mesures;
  correcteur.close();
  return {
    chargement: mesuresChargement,
    premierControleDepuisLancementMs: premierDepuisLancementMs,
    controles160MotsMs: court,
    controles900MotsMs: long,
    filPrincipalEcartMaxMs: {
      chargement: filPendantChargementMs,
      controles: filPendantControlesMs,
    },
    resultats,
    absentes,
  };
}

/** Archive absente, abîmée, Worker introuvable : message lisible, sans blocage. */
async function robustesse() {
  const cas: Record<string, string> = {
    archiveAbsente: "/absente/lt/worker.js",
    archiveAbimee: "/abimee/lt/worker.js",
    archiveTronquee: "/tronquee/lt/worker.js",
    workerAbsent: "/rien/lt/worker.js",
  };
  const sortie: Record<string, { message: string; ms: number; etat: string }> = {};
  for (const [nom, urlWorker] of Object.entries(cas)) {
    const correcteur = new CorrecteurBureau({ urlWorker });
    const t = maintenant();
    let message = "(aucune erreur)";
    try {
      await correcteur.check("Bonjour.");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    sortie[nom] = { message, ms: arrondi(maintenant() - t), etat: correcteur.etat };
    correcteur.close();
  }
  return sortie;
}

// Témoin de la page évalué au chargement : pendant un `page.evaluate` de Playwright, le
// protocole de débogage lève l'interdiction d'`eval` (allowUnsafeEvalBlockedByCSP).
const evalBloqueAuChargement = evalBloqueDansLaPage();

async function securite() {
  return {
    evalBloqueDansLaPage: evalBloqueAuChargement,
    evalBloqueDansUnWorker: await evalBloqueDansUnWorker(),
  };
}

/** Démarre un correcteur et attend sa première réponse ; la mémoire est lue par le script. */
let correcteurMemoire: CorrecteurBureau | null = null;
async function demarrerPourMemoire(texte: string) {
  correcteurMemoire = new CorrecteurBureau({ urlWorker: "/lt/worker.js" });
  await correcteurMemoire.check(texte);
}

Object.assign(globalThis, {
  verifier: { corpus, robustesse, securite, demarrerPourMemoire, violations: () => violations },
});
document.title = "prêt";
