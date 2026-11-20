/**
 * Messages d'erreur de l'application de bureau affichés hors de React : l'interface peut ne pas
 * être montée (journal impossible à ouvrir), ou rester utilisable avec un correcteur absent.
 * Construits avec le DOM (`textContent`, pas de HTML interprété) et des styles en ligne : rien à
 * charger, compatibles avec la politique de sécurité de la page.
 */

const ROUGE = "#b91c1c";

/** Consigne et bouton propres à un cas, à la place de « Fermez Grammaria… » et « Réessayer ». */
export interface ActionErreur {
  /** Consigne affichée sous le message (null : aucune). */
  aide: string | null;
  libelle: string;
  /** Action du bouton ; un rejet affiche `siEchec` sous le bouton. */
  surClic: () => Promise<unknown>;
  siEchec: string;
}

/**
 * Remplace la page par un message lisible et un bouton « Réessayer » (recharge la page), ou
 * par la consigne et le bouton de `action` quand relancer n'y changerait rien.
 */
export function afficherErreur(
  titre: string,
  detail: string,
  doc: Document = document,
  action?: ActionErreur,
): void {
  const racine = doc.getElementById("root") ?? doc.body;
  racine.replaceChildren();
  const boite = doc.createElement("div");
  boite.setAttribute("role", "alert");
  boite.dataset.testid = "erreur-demarrage";
  boite.style.cssText =
    "font:15px/1.5 Inter,system-ui,sans-serif;max-width:36rem;margin:18vh auto;padding:0 1rem;color:#1e293b";
  const h1 = doc.createElement("h1");
  h1.textContent = titre;
  h1.style.cssText = `font-size:1.25rem;font-weight:600;color:${ROUGE};margin:0 0 .75rem`;
  const p = doc.createElement("p");
  p.textContent = detail;
  p.style.cssText = "margin:0 0 .75rem;white-space:pre-wrap;word-break:break-word";
  boite.append(h1, p);
  const texteAide =
    action === undefined
      ? "Fermez Grammaria puis relancez-la. Si le problème persiste, signalez-le avec le message ci-dessus."
      : action.aide;
  if (texteAide !== null) {
    const aide = doc.createElement("p");
    aide.textContent = texteAide;
    aide.style.cssText = "margin:0 0 1.25rem;color:#475569";
    boite.append(aide);
  }
  const bouton = doc.createElement("button");
  bouton.type = "button";
  bouton.textContent = action?.libelle ?? "Réessayer";
  bouton.style.cssText =
    "font:inherit;padding:.5rem 1rem;border-radius:.5rem;border:1px solid #cbd5e1;background:#fff;cursor:pointer";
  boite.append(bouton);
  if (action === undefined) {
    bouton.addEventListener("click", () => doc.defaultView?.location.reload());
  } else {
    // Échec de l'action : message annoncé à part (role="status").
    const echec = doc.createElement("p");
    echec.setAttribute("role", "status");
    echec.style.cssText = "margin:.75rem 0 0;color:#475569";
    bouton.addEventListener("click", () => {
      echec.textContent = "";
      action.surClic().catch(() => {
        echec.textContent = action.siEchec;
      });
    });
    boite.append(echec);
  }
  racine.append(boite);
}

/** Bandeau fermable en bas de la fenêtre : l'interface reste utilisable. */
export function afficherBandeau(message: string, doc: Document = document): HTMLElement {
  doc.querySelector('[data-testid="bandeau-bureau"]')?.remove();
  const bandeau = doc.createElement("div");
  bandeau.setAttribute("role", "status");
  bandeau.dataset.testid = "bandeau-bureau";
  bandeau.style.cssText =
    "position:fixed;left:1rem;right:1rem;bottom:1rem;z-index:2147483647;display:flex;gap:1rem;" +
    "align-items:flex-start;max-width:44rem;margin:0 auto;padding:.75rem 1rem;border-radius:.75rem;" +
    `background:#fef2f2;border:1px solid #fecaca;color:${ROUGE};font:14px/1.45 Inter,system-ui,sans-serif;` +
    "box-shadow:0 4px 16px rgba(0,0,0,.08)";
  const texte = doc.createElement("span");
  texte.textContent = message;
  texte.style.flex = "1";
  const fermer = doc.createElement("button");
  fermer.type = "button";
  fermer.textContent = "×";
  fermer.setAttribute("aria-label", "Fermer");
  fermer.style.cssText =
    "font:inherit;font-size:18px;line-height:1;border:0;background:none;color:inherit;cursor:pointer";
  fermer.addEventListener("click", () => bandeau.remove());
  bandeau.append(texte, fermer);
  doc.body.append(bandeau);
  return bandeau;
}
