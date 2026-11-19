/**
 * Worker du correcteur grammatical de l'application de bureau (WebView).
 *
 * Même moteur que le serveur (règles françaises de LanguageTool portées en JavaScript), dans sa
 * version navigateur : aucune ressource n'est lue sur disque, tout vient de l'archive `fr.pack`
 * servie à côté de ce script (même origine). L'analyse et le chargement des règles (quelques
 * secondes) se font ici, hors du fil principal de la page.
 *
 * Protocole (types dans protocole-lt.ts, utilisés par correcteur.ts) :
 *   - au démarrage, le Worker charge l'archive puis les règles et envoie `pret` ou `erreur` ;
 *   - `controle` → `resultat` (détections au format JSON de POST /api/check) ou `echec` ;
 *   - `diagnostic` → noms de ressources demandés par le moteur et absents de l'archive.
 *
 * Construit par `vp build --mode bureau` (vite.config.ts), sans `eval` ni `new Function` : la
 * politique de sécurité du bureau interdit `unsafe-eval`.
 */
import { check, preloadResources } from "@valueerror/ltjs-core/browser";
import { MemoryResourceBackend } from "@valueerror/ltjs-core/src/core/resources/ResourceDataBroker.js";
// Enregistre les règles françaises : le build navigateur ne découvre pas les paquets de langue.
import "@valueerror/ltjs-lang-fr";
import { lireArchive } from "./archive-lt.ts";
import { CHEMIN_ARCHIVE, type MessageDuWorker, type MessageVersWorker } from "./protocole-lt.ts";

// Le projet ne charge pas la bibliothèque de types « webworker » : portée minimale du Worker.
declare const self: {
  postMessage(message: MessageDuWorker): void;
  onmessage: ((event: MessageEvent<MessageVersWorker>) => void) | null;
  location: { href: string };
};

const envoyer = (message: MessageDuWorker) => self.postMessage(message);
const texteErreur = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Le moteur lit ses ressources par nom ; un nom absent de l'archive n'est pas une erreur en soi
 * (ltjs essaie par exemple des traductions régionales facultatives), mais la liste permet de
 * vérifier que l'archive est complète (message `diagnostic`, utilisé par la vérification). Les
 * lectures du magasin mémoire sont seulement observées, pas modifiées.
 */
const absentes = new Set<string>();
const prototype = MemoryResourceBackend.prototype as unknown as Record<
  "read" | "getUrl",
  (this: unknown, nom: string) => unknown
>;
for (const methode of ["read", "getUrl"] as const) {
  const original = prototype[methode];
  prototype[methode] = function (this: unknown, nom: string) {
    const resultat = original.call(this, nom);
    if (resultat === null && !nom.startsWith(".dup/")) absentes.add(nom);
    return resultat;
  };
}

async function charger(): Promise<void> {
  const t0 = performance.now();
  const url = new URL(CHEMIN_ARCHIVE, self.location.href);
  let reponse: Response;
  try {
    reponse = await fetch(url);
  } catch (error) {
    throw new Error(`archive des règles inaccessible (${url.pathname}) : ${texteErreur(error)}`, {
      cause: error,
    });
  }
  if (!reponse.ok) {
    throw new Error(`archive des règles introuvable (${url.pathname} : HTTP ${reponse.status}).`);
  }
  const archive = new Uint8Array(await reponse.arrayBuffer());
  const archiveMs = performance.now() - t0;

  const fichiers = lireArchive(archive);
  const noms = [...fichiers.keys()];
  await preloadResources({
    entries: noms.map((nom) => ({ url: nom, name: nom })),
    hunspellWasm: false, // le français utilise Morfologik
    fetchImpl: async (nom: string) => fichiers.get(nom)!,
  });
  const lectureMs = performance.now() - t0 - archiveMs;

  // Chargement des règles, comme `GrammarChecker.warmUp()` du serveur.
  const t1 = performance.now();
  await check("Bonjour.", { language: "fr" });
  envoyer({
    type: "pret",
    mesures: {
      archiveOctets: archive.length,
      fichiers: noms.length,
      archiveMs,
      lectureMs,
      reglesMs: performance.now() - t1,
      totalMs: performance.now() - t0,
    },
  });
}

const pret = charger();
pret.catch((error: unknown) => envoyer({ type: "erreur", message: texteErreur(error) }));

self.onmessage = async (event) => {
  const message = event.data;
  if (message.type === "diagnostic") {
    envoyer({ type: "diagnostic", absentes: [...absentes].sort() });
    return;
  }
  const { id, texte } = message;
  try {
    await pret;
    const resultat = await check(texte, { language: "fr" });
    // Sérialisé comme la réponse JSON du serveur : mêmes champs, mêmes valeurs absentes.
    envoyer({ type: "resultat", id, json: JSON.stringify(resultat.matches) });
  } catch (error) {
    envoyer({ type: "echec", id, message: texteErreur(error) });
  }
};
