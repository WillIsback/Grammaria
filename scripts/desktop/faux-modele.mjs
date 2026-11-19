#!/usr/bin/env node
/**
 * Faux serveur de modèle compatible OpenAI (GET /v1/models, POST /v1/chat/completions en
 * streaming SSE), pour l'autotest de l'application de bureau et la vérification à la main.
 * Node seul (aucune dépendance, pas de Bun). N'écoute que sur 127.0.0.1.
 *
 * Usage : node scripts/desktop/faux-modele.mjs [--port 31977]
 *   (variables : FAUX_MODELE_PORT, FAUX_MODELE_CLE — clé API attendue, « sk-autotest-cle » par défaut)
 *
 * Comportement selon le champ `model` de la conversation :
 *   debit   3000 fragments numérotés « m0 », « m1 »… sans pause (débit, ordre) ;
 *   lent    un fragment « mot<i> » toutes les 50 ms, 400 au plus (annulation) ;
 *   muet    aucune réponse pendant 30 s (annulation avant le premier fragment) ;
 *   rejet   400 si `chat_template_kwargs` est présent, comme une API qui refuse ce paramètre ;
 *   pense   raisonne (fragments `reasoning_content`) si `chat_template_kwargs` est absent ;
 *   autre   « corrige » le texte reçu (quelques fautes fixes) et le renvoie mot à mot.
 *
 * GET /v1/models répond aussi `etat` : clé reçue conforme, connexions coupées par le client,
 * corps reçus (sans les messages). Rien n'est écrit sur disque.
 */
import { createServer } from "node:http";

const args = process.argv.slice(2);
const option = (nom) => {
  const i = args.indexOf(nom);
  return i >= 0 ? args[i + 1] : undefined;
};
const PORT = Number(option("--port") ?? process.env.FAUX_MODELE_PORT ?? 31977);
const CLE = process.env.FAUX_MODELE_CLE ?? "sk-autotest-cle";

/** Fautes « corrigées » par le faux modèle. */
const CORRECTIONS = [
  [/\bils on\b/g, "ils ont"],
  [/\bIls on\b/g, "Ils ont"],
  [/\ba Lyon\b/g, "à Lyon"],
  [/\bva a\b/g, "va à"],
  [/\bJ'ai envoyer\b/g, "J'ai envoyé"],
  [/\bétait content\b/g, "étaient contents"],
  [/\bdevellopement\b/g, "développement"],
];

const etat = { requetes: 0, connexionsCoupees: 0, cleConforme: null, derniersCorps: [] };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function lireCorps(req) {
  return new Promise((resolve, reject) => {
    const morceaux = [];
    req.on("data", (m) => morceaux.push(m));
    req.on("end", () => resolve(Buffer.concat(morceaux).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res, statut, corps) {
  res.writeHead(statut, { "Content-Type": "application/json" });
  res.end(JSON.stringify(corps));
}

function texteUtilisateur(corps) {
  const messages = Array.isArray(corps.messages) ? corps.messages : [];
  const dernier = [...messages].reverse().find((m) => m.role === "user");
  return String(dernier?.content ?? "")
    .replace(/^<texte>\n/, "")
    .replace(/\n<\/texte>$/, "");
}

const serveur = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const auth = req.headers.authorization ?? "";
  if (url.pathname === "/v1/models" && req.method === "GET") {
    etat.cleConforme = auth === `Bearer ${CLE}`;
    return json(res, 200, {
      object: "list",
      data: [{ id: "faux-modele", object: "model", created: 0, owned_by: "grammaria" }],
      etat,
    });
  }
  if (url.pathname !== "/v1/chat/completions" || req.method !== "POST") {
    return json(res, 404, { error: { message: "Not found" } });
  }

  let corps;
  try {
    corps = JSON.parse(await lireCorps(req));
  } catch {
    return json(res, 400, { error: { message: "Invalid JSON" } });
  }
  etat.requetes++;
  etat.cleConforme = auth === `Bearer ${CLE}`;
  const { messages: _messages, ...resume } = corps;
  etat.derniersCorps.push(resume);
  if (etat.derniersCorps.length > 20) etat.derniersCorps.shift();
  const avecParametre = corps.chat_template_kwargs !== undefined;

  if (corps.model === "rejet" && avecParametre) {
    return json(res, 400, {
      error: { message: "Unrecognized request argument supplied: chat_template_kwargs" },
    });
  }

  let coupee = false;
  res.on("close", () => {
    if (!res.writableEnded) {
      coupee = true;
      etat.connexionsCoupees++;
    }
  });
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const envoyer = (delta, fin = null) =>
    !coupee &&
    res.write(
      `data: ${JSON.stringify({
        id: "faux",
        object: "chat.completion.chunk",
        created: 0,
        model: corps.model,
        choices: [{ index: 0, delta, finish_reason: fin }],
      })}\n\n`,
    );

  if (corps.model === "debit") {
    for (let i = 0; i < 3000 && !coupee; i++) {
      envoyer({ content: `m${i} ` });
      if (i % 100 === 99) await pause(0);
    }
  } else if (corps.model === "lent") {
    for (let i = 0; i < 400 && !coupee; i++) {
      envoyer({ content: `mot${i} ` });
      await pause(50);
    }
  } else if (corps.model === "muet") {
    for (let i = 0; i < 300 && !coupee; i++) await pause(100);
  } else {
    if (corps.model === "pense" && !avecParametre) {
      for (let i = 0; i < 5 && !coupee; i++) {
        envoyer({ reasoning_content: "je réfléchis " });
        await pause(20);
      }
    }
    let texte = corps.model === "rejet" ? "Les enfants étaient contents." : texteUtilisateur(corps);
    for (const [motif, remplacement] of CORRECTIONS) texte = texte.replace(motif, remplacement);
    for (const mot of texte.split(/(?<= )/)) {
      if (coupee) break;
      envoyer({ content: mot });
      await pause(5);
    }
  }
  if (coupee) return;
  envoyer({}, "stop");
  res.end("data: [DONE]\n\n");
});

serveur.listen(PORT, "127.0.0.1", () => {
  console.log(`[faux-modele] prêt sur http://127.0.0.1:${PORT}`);
});
