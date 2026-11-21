/**
 * Autotest de l'application de bureau, exécuté DANS la vraie WebView (WebKitGTK, WebView2) :
 * preuve, pour la CI, que l'application sans serveur fonctionne de bout en bout.
 *
 * Porte : ce module n'est chargé par l'amorce que si l'application l'a demandé
 * (`window.__GRAMMARIA_AUTOTEST__`, script d'initialisation posé par Rust seulement quand la
 * variable d'environnement GRAMMARIA_AUTOTEST_OUT est définie). Sa première action est la
 * commande `autotest_config`, que Rust refuse hors de ce mode (aucune capability ne l'autorise,
 * et la commande elle-même répond « inactif ») : sans la variable, il ne fait RIEN. En mode
 * autotest, Rust place les données dans un dossier temporaire, jamais dans celui de
 * l'utilisateur.
 *
 * Étapes (toutes par le pont, comme l'interface, sauf mention) :
 *  1. interface montée ;
 *  2. correcteur : premier contrôle (temps depuis le lancement), détections du corpus
 *     comparées à la référence du serveur (tests/fixtures/correcteur/reference.json), produite
 *     par le même moteur Rust ;
 *  3. journal : schéma 3, analyses enregistrées (astuce à la 3ᵉ faute), aucun mot des textes
 *     corrigés dans le fichier de la base (commande `autotest_textes_journal`), lot SQLite atomique et lots
 *     refusés par le pilote Tauri (rien d'écrit), export de la bêta (valide, sans texte, écrit
 *     par Rust sous son nom fixe), effacement ;
 *  4. réglages : clé API jamais renvoyée à la page, mais bien reçue par le modèle ; stockage
 *     de la clé (trousseau du système, ou fichier sans trousseau) ;
 *  5. modèle (faux serveur local, scripts/desktop/faux-modele.mjs) : ordre des fragments,
 *     annulation pendant le flux et avant le premier fragment, refus de chat_template_kwargs
 *     puis relance, interruption d'une correction par src/utils/llm.ts ;
 *  6. accès : commandes de plugin refusées, `fetch` direct vers le modèle et évaluation de
 *     code bloqués par la CSP ; aucune autre violation de la CSP ;
 * puis écrit le JSON de résultats (commande `autotest_terminer`) : l'application se ferme avec
 * le code 0 si tous les critères sont tenus, 1 sinon.
 */
import reference from "../../tests/fixtures/correcteur/reference.json";
import { estConflit } from "../../journal.driver.ts";
import {
  nomFichierExport,
  texteExport,
  validerTexteExport,
} from "../analysis/progression/export.ts";
import type { CorrectionSettings, LTMatch } from "../types.ts";
import { CORRECTION_REMPLACEE, correctText } from "../utils/llm.ts";
import type { CorrecteurBureau } from "./correcteur.ts";
import { creerPiloteTauri } from "./journal.driver.tauri.ts";
import type { Pont } from "./pont.ts";
import { type ApiTauri, messageErreur } from "./tauri.ts";

interface ConfigAutotest {
  /** Adresse du faux serveur du modèle. */
  modele: string;
  /** Clé API attendue par le faux modèle. */
  cle: string;
}

export interface ContexteAutotest {
  api: ApiTauri;
  correcteur: CorrecteurBureau;
  pont: Pont;
  prechauffage: Promise<void>;
}

type Critere = { nom: string; ok: boolean; detail?: unknown };

/** Réglages de correction de l'interface par défaut. */
const REGLAGES_CORRECTION: CorrectionSettings = {
  mode: "formel",
  fixGrammar: true,
  fixSpelling: true,
  fixSyntax: true,
  fixStyle: true,
};

const maintenant = () => performance.now();
const arrondi = (n: number) => Math.round(n * 10) / 10;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function stat(valeurs: number[]) {
  const s = [...valeurs].sort((a, b) => a - b);
  const q = (p: number) => arrondi(s[Math.min(s.length - 1, Math.floor(p * s.length))]);
  return { n: s.length, min: arrondi(s[0]), mediane: q(0.5), max: arrondi(s[s.length - 1]) };
}

async function attendre<T>(lire: () => T | null | undefined, delaiMs: number): Promise<T | null> {
  const fin = maintenant() + delaiMs;
  while (maintenant() < fin) {
    const valeur = lire();
    if (valeur) return valeur;
    await pause(50);
  }
  return null;
}

const resumer = (m: LTMatch) => ({
  regle: m.rule.id,
  debut: m.offset,
  longueur: m.length,
  message: m.message,
  suggestions: m.replacements.slice(0, 5).map((r) => r.value),
});

const postJson = (chemin: string, corps: unknown, init: RequestInit = {}) =>
  fetch(chemin, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corps),
    ...init,
  });

/** Événements `data:` d'un flux SSE, lus au fil de l'eau ; `surEvenement` peut arrêter la lecture. */
async function lireSse(
  reponse: Response,
  surEvenement: (evenement: Record<string, unknown>) => boolean | void = () => {},
): Promise<Record<string, unknown>[]> {
  const lecteur = reponse.body!.getReader();
  const decodeur = new TextDecoder();
  const evenements: Record<string, unknown>[] = [];
  let tampon = "";
  for (;;) {
    const { done, value } = await lecteur.read();
    if (done) return evenements;
    tampon += decodeur.decode(value, { stream: true });
    const blocs = tampon.split("\n\n");
    tampon = blocs.pop() ?? "";
    for (const bloc of blocs) {
      if (!bloc.startsWith("data: ")) continue;
      const evenement = JSON.parse(bloc.slice(6)) as Record<string, unknown>;
      evenements.push(evenement);
      if (surEvenement(evenement) === false) return evenements;
    }
  }
}

export async function lancerAutotest(contexte: ContexteAutotest): Promise<void> {
  const { api } = contexte;
  let config: ConfigAutotest;
  try {
    config = await api.invoke<ConfigAutotest>("autotest_config");
  } catch {
    // Hors du mode autotest : rien n'est exécuté.
    return;
  }

  const violations: string[] = [];
  document.addEventListener("securitypolicyviolation", (e) =>
    violations.push(`${e.violatedDirective} ← ${e.blockedURI || e.sourceFile || "?"}`),
  );
  const erreursPage: string[] = [];
  window.addEventListener("error", (e) => erreursPage.push(String(e.message)));
  window.addEventListener("unhandledrejection", (e) => erreursPage.push(messageErreur(e.reason)));

  const criteres: Critere[] = [];
  const critere = (nom: string, ok: boolean, detail?: unknown) => {
    criteres.push(detail === undefined ? { nom, ok } : { nom, ok, detail });
    return ok;
  };
  const r: Record<string, unknown> = {
    version: 1,
    termine: false,
    userAgent: navigator.userAgent,
    page: location.href,
    debutDepuisLancementMs: arrondi(maintenant()),
    erreurs: [] as string[],
  };
  const erreurs = r.erreurs as string[];
  const etape = async (nom: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (error) {
      erreurs.push(`${nom} : ${messageErreur(error)}`);
      critere(`${nom} : sans exception`, false, messageErreur(error));
    }
  };
  const etatModele = async () =>
    ((await (await fetch("/v1/models")).json()) as { etat: Record<string, unknown> }).etat;

  // ───────────────────────── 1. Interface ─────────────────────────
  await etape("interface", async () => {
    const zone = await attendre(() => document.querySelector("textarea"), 15_000);
    r.interface = { zoneDeSaisie: zone !== null, monteeDepuisLancementMs: arrondi(maintenant()) };
    critere("interface montée (zone de saisie)", zone !== null);
  });

  // ───────────────────────── 2. Correcteur ─────────────────────────
  await etape("correcteur", async () => {
    const textes = reference.textes;
    const t0 = maintenant();
    const premiere = await postJson("/api/check", { text: textes[0].texte });
    const premierMs = maintenant() - t0;
    const premierDepuisLancementMs = maintenant();
    critere("premier contrôle : 200", premiere.status === 200, premiere.status);
    await premiere.json();

    const suivants: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t = maintenant();
      await (await postJson("/api/check", { text: textes[0].texte })).json();
      suivants.push(maintenant() - t);
    }

    const ecarts: { nom: string; obtenu: string[]; attendu: string[] }[] = [];
    const detections: Record<string, ReturnType<typeof resumer>[]> = {};
    let identiques = 0;
    for (const { nom, texte, detections: attendues } of textes) {
      // POST /api/check refuse un texte vide ou blanc (400) : ces textes de la référence
      // sont soumis directement au correcteur (même moteur).
      const matches = texte.trim()
        ? ((await (await postJson("/api/check", { text: texte })).json()) as { matches: LTMatch[] })
            .matches
        : await contexte.correcteur.check(texte);
      const obtenues = matches.map(resumer);
      detections[nom] = obtenues;
      if (JSON.stringify(obtenues) === JSON.stringify(attendues)) identiques++;
      else {
        const cle = (d: { regle: string; debut: number; longueur: number }) =>
          `${d.regle}@${d.debut}+${d.longueur}`;
        ecarts.push({ nom, obtenu: obtenues.map(cle), attendu: attendues.map(cle) });
      }
    }
    r.correcteur = {
      chargement: contexte.correcteur.mesures,
      premierControle: {
        dureeMs: arrondi(premierMs),
        depuisLancementMs: arrondi(premierDepuisLancementMs),
      },
      controlesSuivants160MotsMs: stat(suivants),
      textes: textes.length,
      identiques,
      ecarts,
      detections,
    };
    critere(
      `détections identiques à la référence (${identiques}/${textes.length} textes)`,
      identiques === textes.length,
      ecarts.length ? ecarts.slice(0, 3) : undefined,
    );
    critere("premier contrôle < 30 s", premierMs < 30_000, arrondi(premierMs));
  });

  // ───────────────────────── 3. Journal ─────────────────────────
  await etape("journal", async () => {
    const pilote = creerPiloteTauri(api.invoke);
    const j: Record<string, unknown> = (r.journal = {});
    j.userVersion = (
      await pilote.read<{ user_version: number }>("PRAGMA user_version")
    )[0]?.user_version;
    critere("schéma du journal en version 3", j.userVersion === 3, j.userVersion);

    // Analyses par le pont : l'astuce apparaît à la 3e faute de la même règle.
    const interventions: (string | null)[] = [];
    for (let i = 0; i < 3; i++) {
      const corps = (await (
        await postJson("/api/analyze", {
          original: "Ils on fini le dossier hier soir.",
          corrected: "Ils ont fini le dossier hier soir.",
          matches: [],
        })
      ).json()) as { intervention: { type: string } | null };
      interventions.push(corps.intervention?.type ?? null);
    }
    j.interventions = interventions;
    critere(
      "astuce à la 3e faute",
      interventions[0] === null && interventions[2] === "astuce",
      interventions,
    );

    // Aucun texte de l'utilisateur dans le fichier du journal (#32) : des textes à mots
    // improbables, avec les vraies détections du correcteur, puis Rust cherche ces mots
    // dans les octets de la base et de ses fichiers annexes (UTF-8 et UTF-16).
    const sentinelles = ["Zorglubienne", "Brabanthrope", "quixotérismal", "Vélocipédisme-ζ"];
    for (const [original, corrected] of [
      [
        "Hier, Zorglubienne et Brabanthrope mange des quixotérismals.",
        "Hier, Zorglubienne et Brabanthrope mangent des quixotérismal.",
      ],
      ["Ils on vu Vélocipédisme-ζ hier soir.", "Ils ont vu Vélocipédisme-ζ hier soir."],
    ]) {
      const { matches } = (await (await postJson("/api/check", { text: original })).json()) as {
        matches: LTMatch[];
      };
      await (await postJson("/api/analyze", { original, corrected, matches })).json();
    }
    j.textesTrouves = await api.invoke<string[]>("autotest_textes_journal", { sentinelles });
    critere(
      "aucun texte de l'utilisateur dans le fichier du journal",
      Array.isArray(j.textesTrouves) && j.textesTrouves.length === 0,
      j.textesTrouves,
    );

    // Export anonyme de la bêta (#34) : par le pont, valide et sans aucun mot des textes, puis
    // écrit par Rust (dossier fixé par Rust : ici, celui des données isolées de l'autotest).
    const reponseExport = await fetch("/api/progress/export");
    const texteBrut = await reponseExport.text();
    const resultatExport = validerTexteExport(texteBrut);
    j.export = { statut: reponseExport.status, valide: resultatExport.ok };
    critere(
      "export de la bêta valide, sans aucun mot des textes corrigés",
      reponseExport.status === 200 &&
        resultatExport.ok &&
        sentinelles.every((mot) => !texteBrut.toLowerCase().includes(mot.toLowerCase())),
      j.export,
    );
    if (resultatExport.ok) {
      const contenu = texteExport(resultatExport.export);
      const chemin = await api.invoke<string>("export_beta_enregistrer", { contenu });
      const refus = await api
        .invoke<string>("export_beta_enregistrer", { contenu: '{"format":"autre"}' })
        .then(
          () => "ACCEPTÉ",
          (error: unknown) => messageErreur(error),
        );
      j.exportEcrit = { chemin, refus };
      critere(
        "export écrit par Rust sous son nom fixe ; contenu hors format refusé",
        chemin.endsWith(nomFichierExport(resultatExport.export.participant)) && refus !== "ACCEPTÉ",
        j.exportEcrit,
      );
    }

    const compter = async () =>
      (
        await pilote.read<{ texts: number; faults: number }>(
          "SELECT (SELECT COUNT(*) FROM texts) AS texts, (SELECT COUNT(*) FROM faults) AS faults",
        )
      )[0];
    const lot = () => [
      {
        sql: "INSERT INTO texts (created_at, word_count, fault_count, unclassified_count, score) VALUES (?, ?, ?, ?, ?)",
        params: [Date.now(), 10, 2, 0, 15],
      },
      ...[0, 1].map(() => ({
        sql: `INSERT INTO faults (text_id, created_at, rule_key, source, category_id, category_name,
                issue_type, counted)
              VALUES (?, ?, 'AUTOTEST', 'lt', 'GRAMMAR', 'Grammaire', 'grammar', 1)`,
        params: [{ $rowid: 0 }, Date.now()],
      })),
    ];
    const avant = await compter();
    const t = maintenant();
    const resultats = await pilote.batch(lot());
    j.lotMs = arrondi(maintenant() - t);
    const apres = await compter();
    critere(
      "lot atomique écrit (1 texte, 2 fautes rattachées)",
      apres.texts === avant.texts + 1 &&
        apres.faults === avant.faults + 2 &&
        resultats.length === 3,
      { avant, apres },
    );

    const refus: Record<string, string> = {};
    const tenter = async (nom: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
        refus[nom] = "ACCEPTÉ";
      } catch (error) {
        refus[nom] = messageErreur(error);
        return error;
      }
      return null;
    };
    await tenter("instructionInvalide", () =>
      pilote.batch([...lot(), { sql: "INSERT INTO table_absente VALUES (1)" }]),
    );
    const conflit = await tenter("gardeExpectChanges", () =>
      pilote.batch([
        ...lot(),
        { sql: "UPDATE texts SET score = 0 WHERE id = -1", expectChanges: 1 },
      ]),
    );
    await tenter("ecritureParDbRead", () => pilote.read("DELETE FROM texts"));
    await tenter("attach", () => pilote.batch([{ sql: "ATTACH DATABASE 'autre.db' AS autre" }]));
    await tenter("transactionDansUnLot", () => pilote.batch([{ sql: "BEGIN" }]));
    const apresRefus = await compter();
    j.refus = refus;
    critere(
      "lots refusés : rien d'écrit",
      Object.values(refus).every((m) => m !== "ACCEPTÉ") &&
        apresRefus.texts === apres.texts &&
        apresRefus.faults === apres.faults,
      { refus, apresRefus },
    );
    critere("conflit reconnu (« Conflit : »)", conflit !== null && estConflit(conflit));

    const purge = await fetch("/api/journal", { method: "DELETE" });
    const vide = await compter();
    critere("« Effacer le journal » vide la base", purge.status === 200 && vide.texts === 0, vide);
  });

  // ───────────────────────── 4. Réglages ─────────────────────────
  await etape("réglages", async () => {
    const reponse = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ llmTarget: config.modele, llmApiKey: config.cle, llmModelName: "" }),
    });
    const texte = await reponse.text();
    const lecture = await (await fetch("/api/settings")).text();
    const etat = await etatModele();
    const vue = JSON.parse(texte) as { hasApiKey?: boolean; apiKeyStorage?: string };
    r.reglages = {
      statut: reponse.status,
      vue,
      cleRecueParLeModele: etat.cleConforme,
      // Vérifié par scripts/desktop/verifier-autotest.mjs sur les fichiers du dossier de
      // données : « trousseau », la clé n'est dans aucun ; « fichier », réglages en 0600.
      stockageCle: vue.apiKeyStorage,
    };
    critere("réglages enregistrés", reponse.status === 200 && vue.hasApiKey === true);
    critere(
      "clé API jamais renvoyée à la page",
      !texte.includes(config.cle) && !lecture.includes(config.cle),
    );
    critere("clé API transmise au modèle par l'application", etat.cleConforme === true);
    critere(
      `stockage de la clé API : ${vue.apiKeyStorage}`,
      vue.apiKeyStorage === "trousseau" || vue.apiKeyStorage === "fichier",
      vue.apiKeyStorage,
    );
  });

  // ───────────────────────── 5. Modèle ─────────────────────────
  await etape("modèle", async () => {
    const m: Record<string, unknown> = (r.modele = {});
    const messages = [{ role: "user", content: "Les enfants était content." }];

    // Débit et ordre : 3000 fragments.
    {
      const t0 = maintenant();
      let premier = 0;
      let n = 0;
      let ordre = true;
      const evenements = await lireSse(
        await postJson("/v1/chat/completions", { model: "debit", messages }),
        (e) => {
          if (typeof e.delta === "string") {
            premier ||= maintenant() - t0;
            if (e.delta !== `m${n} `) ordre = false;
            n++;
          }
        },
      );
      m.debit = {
        fragments: n,
        ordreRespecte: ordre,
        premierFragmentMs: arrondi(premier),
        totalMs: arrondi(maintenant() - t0),
        fin: evenements.at(-1)?.done === true,
      };
      critere("flux : 3000 fragments reçus dans l'ordre", n === 3000 && ordre, m.debit);
    }

    // Annulation pendant le flux : la lecture échoue (AbortError), le modèle voit la coupure.
    {
      const coupeesAvant = Number((await etatModele()).connexionsCoupees);
      const controleur = new AbortController();
      let recus = 0;
      let apresAnnulation = 0;
      let nomErreur = "";
      try {
        await lireSse(
          await postJson(
            "/v1/chat/completions",
            { model: "lent", messages },
            { signal: controleur.signal },
          ),
          (e) => {
            if (typeof e.delta !== "string") return;
            recus++;
            if (controleur.signal.aborted) apresAnnulation++;
            if (recus === 5) controleur.abort();
          },
        );
      } catch (error) {
        nomErreur = (error as Error).name;
      }
      await pause(600);
      const coupees = Number((await etatModele()).connexionsCoupees) - coupeesAvant;
      m.annulation = { recus, apresAnnulation, erreur: nomErreur, coupeesVuesParLeModele: coupees };
      critere(
        "annulation pendant le flux : AbortError, 0 fragment après, connexion coupée",
        nomErreur === "AbortError" && apresAnnulation === 0 && coupees === 1,
        m.annulation,
      );
    }

    // Annulation avant le premier fragment.
    {
      const coupeesAvant = Number((await etatModele()).connexionsCoupees);
      const controleur = new AbortController();
      setTimeout(() => controleur.abort(), 300);
      let nomErreur = "";
      try {
        await postJson(
          "/v1/chat/completions",
          { model: "muet", messages },
          { signal: controleur.signal },
        );
      } catch (error) {
        nomErreur = (error as Error).name;
      }
      await pause(600);
      const coupees = Number((await etatModele()).connexionsCoupees) - coupeesAvant;
      m.annulationAvantPremierFragment = { erreur: nomErreur, coupeesVuesParLeModele: coupees };
      critere(
        "annulation avant le premier fragment : AbortError, connexion coupée",
        nomErreur === "AbortError" && coupees === 1,
        m.annulationAvantPremierFragment,
      );
    }

    // Refus de chat_template_kwargs (400) : relance sans lui, puis refus retenu.
    {
      const fin = (
        await lireSse(await postJson("/v1/chat/completions", { model: "rejet", messages }))
      ).at(-1);
      const corps = (await etatModele()).derniersCorps as Record<string, unknown>[];
      const deuxDerniers = corps.slice(-2).map((c) => "chat_template_kwargs" in c);
      await lireSse(await postJson("/v1/chat/completions", { model: "rejet", messages }));
      const encore = ((await etatModele()).derniersCorps as Record<string, unknown>[]).at(-1)!;
      m.relance = { fin, avecParametre: deuxDerniers, ensuite: "chat_template_kwargs" in encore };
      critere(
        "refus du paramètre de raisonnement : relance sans lui, puis retenu",
        fin?.done === true &&
          fin.text === "Les enfants étaient contents." &&
          deuxDerniers[0] === true &&
          deuxDerniers[1] === false &&
          !("chat_template_kwargs" in encore),
        m.relance,
      );
    }

    // Interruption d'une correction par src/utils/llm.ts (une nouvelle correction l'annule).
    {
      const coupeesAvant = Number((await etatModele()).connexionsCoupees);
      const definirModele = (nom: string) =>
        fetch("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ llmModelName: nom }),
        });
      await definirModele("lent");
      let affiche = "";
      const premiere = correctText("texte", REGLAGES_CORRECTION, {
        onText: (t) => (affiche = t),
      }).then(
        () => "terminée (anormal)",
        (error: unknown) => messageErreur(error),
      );
      await attendre(() => affiche.length > 10, 5_000);
      await definirModele("");
      const t0 = maintenant();
      const seconde = await correctText("Ils on fini le dossier.", REGLAGES_CORRECTION);
      const premiereIssue = await premiere;
      await pause(600);
      const coupees = Number((await etatModele()).connexionsCoupees) - coupeesAvant;
      m.interruption = {
        afficheAvantInterruption: affiche.slice(0, 40),
        premiere: premiereIssue,
        seconde: seconde.text,
        secondeMs: arrondi(maintenant() - t0),
        coupeesVuesParLeModele: coupees,
      };
      critere(
        "interruption d'une correction (llm.ts) : requête annulée, la suivante aboutit",
        premiereIssue === CORRECTION_REMPLACEE &&
          seconde.text === "Ils ont fini le dossier." &&
          coupees === 1,
        m.interruption,
      );
    }
  });

  // ───────────────────────── 6. Accès et CSP ─────────────────────────
  await etape("accès", async () => {
    const a: Record<string, unknown> = (r.acces = {});
    const statut = await api.invoke<{ currentVersion: string; mode: string }>("update_status");
    a.miseAJour = statut;
    critere("commande de mise à jour accessible", typeof statut.currentVersion === "string");
    const refus: Record<string, string> = {};
    for (const [commande, args] of [
      ["plugin:opener|open_url", { url: "https://example.com" }],
      ["plugin:updater|check", {}],
      ["plugin:window|close", { label: "main" }],
      ["plugin:event|listen", { event: "x", target: { kind: "Any" }, handler: 1 }],
    ] as const) {
      try {
        await api.invoke(commande, args);
        refus[commande] = "ACCEPTÉ";
      } catch (error) {
        refus[commande] = messageErreur(error).slice(0, 160);
      }
    }
    a.commandesRefusees = refus;
    critere(
      "commandes de Tauri et des plugins refusées",
      Object.values(refus).every((m) => m !== "ACCEPTÉ"),
      refus,
    );

    // Témoins volontaires : la CSP doit les bloquer (violations attendues, comptées à part).
    const avant = violations.length;
    let fetchDirect = "ACCEPTÉ";
    try {
      await fetch(`${config.modele}/v1/models`);
    } catch (error) {
      fetchDirect = `refusé : ${messageErreur(error)}`;
    }
    let evaluation = "ACCEPTÉ";
    try {
      // Témoin volontaire : doit être refusé par la CSP (pas de unsafe-eval).
      // oxlint-disable-next-line typescript/no-implied-eval
      new Function("return 1")();
    } catch (error) {
      evaluation = `refusé : ${messageErreur(error)}`;
    }
    await pause(200);
    a.temoins = { fetchDirect, evaluation, violations: violations.splice(avant) };
    critere("fetch direct vers le modèle bloqué par la CSP", fetchDirect !== "ACCEPTÉ");
    critere("évaluation de code bloquée par la CSP", evaluation !== "ACCEPTÉ");
  });

  r.requetesDuPont = contexte.pont.journal.length;
  r.cspViolations = violations;
  r.erreursPage = erreursPage;
  critere("aucune violation de la CSP", violations.length === 0, violations);
  critere("aucune erreur de page", erreursPage.length === 0, erreursPage);
  critere("aucune erreur d'étape", erreurs.length === 0, erreurs);
  r.criteres = criteres;
  r.reussi = criteres.every((c) => c.ok);
  r.dureeMs = arrondi(maintenant() - (r.debutDepuisLancementMs as number));
  r.termine = true;
  await api.invoke("autotest_terminer", { resultat: r, reussi: r.reussi });
}
