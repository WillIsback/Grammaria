/**
 * Le « pont » de l'application de bureau : remplace `window.fetch` pour les seules requêtes de
 * même origine vers `/api/…` et `/v1/…`, et les confie au gestionnaire d'API partagé avec le
 * serveur Bun (`creerGestionnaire`, api/handler.ts). Toute autre requête part par le `fetch`
 * d'origine. Les services de l'interface (src/services, src/utils/llm.ts) restent inchangés :
 * ils appellent `fetch("/api/check")` comme dans le navigateur.
 *
 * Ce qu'un vrai `fetch` ferait, et que le pont reproduit :
 *  - le corps de la réponse est un flux (`new Response(ReadableStream)`) : le flux SSE de
 *    `/v1/chat/completions` se lit fragment par fragment ;
 *  - l'abandon du signal de la requête rejette la promesse avec une `AbortError`, ou fait
 *    échouer la lecture du corps avec une `AbortError`, et annule le flux du gestionnaire
 *    (qui annule la requête au modèle) ;
 *  - une exception du gestionnaire devient une réponse 500, comme sur le serveur.
 */

export type Gestionnaire = (req: Request) => Promise<Response | null>;
type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Adresse visée par `fetch(input)`, résolue par rapport à la page. */
function adresse(input: RequestInfo | URL, base: string): URL | null {
  try {
    if (input instanceof URL) return input;
    return new URL(typeof input === "string" ? input : input.url, base);
  } catch {
    return null;
  }
}

/**
 * Vrai pour une route de l'API servie par la page elle-même. On compare schéma et hôte plutôt
 * que `URL.origin`, qui vaut "null" pour un schéma non standard (`tauri://localhost` sous Linux
 * et macOS ; `http://tauri.localhost` sous Windows).
 */
export function estRouteApi(url: URL, page: URL): boolean {
  return (
    url.protocol === page.protocol &&
    url.host === page.host &&
    (url.pathname.startsWith("/api/") || url.pathname.startsWith("/v1/"))
  );
}

function erreurAbandon(signal: AbortSignal): unknown {
  const raison: unknown = signal.reason;
  if (raison instanceof Error || raison instanceof DOMException) return raison;
  return new DOMException("La requête a été interrompue.", "AbortError");
}

/** Le corps de `reponse`, interrompu (AbortError) par l'abandon de `signal`. */
function corpsInterruptible(reponse: Response, signal: AbortSignal | undefined): Response {
  if (!reponse.body || !signal) return reponse;
  const lecteur = reponse.body.getReader();
  let fini = false;
  const corps = new ReadableStream<Uint8Array>({
    start(controleur) {
      signal.addEventListener(
        "abort",
        () => {
          if (fini) return;
          fini = true;
          controleur.error(erreurAbandon(signal));
          // Annule le flux du gestionnaire : la requête au modèle est annulée.
          lecteur.cancel(signal.reason).catch(() => {});
        },
        { once: true },
      );
    },
    async pull(controleur) {
      try {
        const { done, value } = await lecteur.read();
        if (fini) return;
        if (done) {
          fini = true;
          controleur.close();
        } else {
          controleur.enqueue(value);
        }
      } catch (error) {
        if (!fini) {
          fini = true;
          controleur.error(error);
        }
      }
    },
    cancel(raison) {
      fini = true;
      return lecteur.cancel(raison);
    },
  });
  return new Response(corps, {
    status: reponse.status,
    statusText: reponse.statusText,
    headers: reponse.headers,
  });
}

/** Traite une requête de l'API par le gestionnaire, avec la sémantique d'abandon de `fetch`. */
export async function traiterRequete(
  gestionnaire: Gestionnaire,
  requete: Request,
  signal: AbortSignal | undefined,
): Promise<Response> {
  if (signal?.aborted) throw erreurAbandon(signal);
  const travail = gestionnaire(requete).then(
    (reponse) =>
      reponse ??
      new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    (error: unknown) => {
      console.error("[Pont] Erreur du gestionnaire :", error);
      return new Response(JSON.stringify({ error: "Internal error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    },
  );
  if (!signal) return travail;

  return new Promise<Response>((resolve, reject) => {
    let abandonnee = false;
    const surAbandon = () => {
      abandonnee = true;
      reject(erreurAbandon(signal));
    };
    signal.addEventListener("abort", surAbandon, { once: true });
    void travail.then((reponse) => {
      signal.removeEventListener("abort", surAbandon);
      if (abandonnee) {
        // Réponse arrivée après l'abandon : personne ne la lira, son flux est annulé.
        reponse.body?.cancel().catch(() => {});
        return;
      }
      resolve(corpsInterruptible(reponse, signal));
    });
  });
}

export interface Pont {
  /** Remet le `fetch` d'origine. */
  desinstaller(): void;
  /** Requêtes traitées par le pont depuis son installation (route, statut, durée). */
  journal: { route: string; statut: number; ms: number }[];
}

/**
 * Installe le pont sur `cible` (window par défaut). À appeler AVANT le premier rendu de
 * l'interface : ses premières requêtes (réglages, journal) passent déjà par le pont.
 */
export function installerPont(
  gestionnaire: Gestionnaire,
  cible: { fetch: Fetch; location: { href: string } } = window,
): Pont {
  const fetchOrigine = cible.fetch;
  const journal: Pont["journal"] = [];
  const garder = (route: string, statut: number, debut: number) => {
    journal.push({ route, statut, ms: Math.round(performance.now() - debut) });
    if (journal.length > 200) journal.shift();
  };

  const fetchPont: Fetch = async (input, init) => {
    const page = new URL(cible.location.href);
    const url = adresse(input, page.href);
    if (!url || !estRouteApi(url, page)) return fetchOrigine.call(cible, input, init);
    // La requête n'est construite que pour l'API : `new Request(requête)` consommerait le
    // corps d'une requête que l'on doit transmettre intacte au fetch d'origine.
    const requete = new Request(input instanceof Request ? input : url.href, init);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const debut = performance.now();
    const route = `${requete.method} ${url.pathname}`;
    try {
      const reponse = await traiterRequete(gestionnaire, requete, signal ?? undefined);
      garder(route, reponse.status, debut);
      return reponse;
    } catch (error) {
      garder(route, 0, debut);
      throw error;
    }
  };

  cible.fetch = fetchPont;
  return {
    journal,
    desinstaller() {
      if (cible.fetch === fetchPont) cible.fetch = fetchOrigine;
    },
  };
}
