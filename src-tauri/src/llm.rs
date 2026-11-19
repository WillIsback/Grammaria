//! Relais du modèle de langage (API compatible OpenAI) en streaming.
//!
//! Rust ne porte AUCUNE règle métier : il ajoute l'adresse et la clé API des
//! réglages (que la page ne connaît pas), envoie le corps préparé par la page
//! tel quel avec `"stream": true`, lit le flux SSE et pousse chaque fragment
//! de texte dans un `Channel`. Le choix du modèle, `chat_template_kwargs`, la
//! relance quand l'API refuse ce paramètre et le nettoyage du texte restent en
//! TypeScript (`src/utils/upstream.ts`, `src/utils/llmText.ts`).
//!
//! La fin et l'erreur du flux passent PAR LE CHANNEL, après le dernier
//! fragment : la réponse de `invoke` peut devancer les derniers messages.
//!
//! Seules les erreurs vont au journal technique (`logs`) : statut et message, la
//! clé masquée ; jamais les textes ni les en-têtes.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use reqwest::{redirect, Client, Method, RequestBuilder, Response, Url};
use serde::Serialize;
use serde_json::Value;
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::oneshot;

use crate::logs;
use crate::store::{endpoint, Store, Upstream};

/// Établissement de la connexion (TCP et TLS).
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// Silence maximal entre deux paquets reçus. Un modèle local peut mettre
/// longtemps à charger ses poids ou à lire un long texte avant le premier
/// mot : la limite est large, mais une connexion morte finit par échouer.
const READ_TIMEOUT: Duration = Duration::from_secs(300);
/// Durée totale de `GET /v1/models`.
const MODELS_TIMEOUT: Duration = Duration::from_secs(20);
/// Corps d'erreur amont conservé (octets lus, puis caractères transmis).
const ERROR_BODY_BYTES: usize = 64 * 1024;
const ERROR_MESSAGE_CHARS: usize = 4_000;
/// Ligne SSE maximale, et lignes `data:` cumulées d'un même événement : au-delà,
/// le flux est considéré comme invalide (un fragment de texte fait quelques
/// dizaines d'octets ; un serveur qui n'envoie jamais de ligne vide ne doit pas
/// faire grossir la mémoire sans fin).
const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;
const MAX_EVENT_BYTES: usize = 8 * 1024 * 1024;
/// Corps de `GET /v1/models` (les listes les plus longues, avec descriptions,
/// font de l'ordre du mégaoctet).
const MODELS_BODY_BYTES: usize = 8 * 1024 * 1024;
/// Redirections suivies au plus (même origine seulement).
const MAX_REDIRECTS: usize = 5;

/// Erreur transmise à la page, lisible par `isThinkingParamRejection`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LlmError {
    /// Statut HTTP de la réponse amont, quand il y en a une.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    /// Corps de la réponse amont (tronqué), ou message en français.
    pub message: String,
    /// Vrai quand la requête a été annulée (`llm_cancel`).
    pub cancelled: bool,
}

impl LlmError {
    fn new(message: impl Into<String>) -> Self {
        LlmError {
            status: None,
            message: message.into(),
            cancelled: false,
        }
    }

    fn cancelled() -> Self {
        LlmError {
            status: None,
            message: "Requête annulée.".into(),
            cancelled: true,
        }
    }

    /// Erreur réseau : sans l'URL (pas d'identifiants éventuels), avec la
    /// cause précise (« connexion refusée », certificat…).
    fn network(context: &str, error: reqwest::Error) -> Self {
        if error.is_timeout() {
            return LlmError::new(format!(
                "{context} : le serveur du modèle ne répond pas (délai dépassé)."
            ));
        }
        let error = error.without_url();
        let mut message = format!("{context} : {error}");
        let mut source = std::error::Error::source(&error);
        while let Some(cause) = source {
            message.push_str(" : ");
            message.push_str(&cause.to_string());
            source = cause.source();
        }
        LlmError::new(message)
    }
}

/// Statistiques de fin de flux.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmStats {
    pub duration_ms: u64,
    /// Délai avant le premier fragment de texte.
    pub first_token_ms: Option<u64>,
    /// Fragments de raisonnement reçus (jamais transmis à la page).
    pub reasoning_chunks: u32,
    pub content_chunks: u32,
}

/// Message du Channel de `llm_chat`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "event", content = "data")]
pub enum LlmEvent {
    Delta(String),
    Done(LlmStats),
    Error(LlmError),
}

/// Client HTTP et requêtes en cours, annulables par leur identifiant.
pub struct Llm {
    client: Client,
    running: Mutex<HashMap<u64, oneshot::Sender<()>>>,
}

impl Llm {
    /// Client de l'application : TLS rustls (fournisseur ring, celui du
    /// plugin de mise à jour), certificats du système, proxy du système.
    pub fn new() -> reqwest::Result<Self> {
        Ok(Self::with_client(client_builder().build()?))
    }

    fn with_client(client: Client) -> Self {
        Llm {
            client,
            running: Mutex::new(HashMap::new()),
        }
    }

    fn running(&self) -> std::sync::MutexGuard<'_, HashMap<u64, oneshot::Sender<()>>> {
        self.running
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    /// Annule la requête `id`. Faux si elle est déjà terminée (ou inconnue).
    pub fn cancel(&self, id: u64) -> bool {
        self.running()
            .remove(&id)
            .is_some_and(|sender| sender.send(()).is_ok())
    }

    /// `GET /v1/models`, avec la clé des réglages.
    pub async fn models(&self, upstream: Option<Upstream>) -> Result<Value, LlmError> {
        let mut response = request(&self.client, upstream, Method::GET, &["v1", "models"])?
            .timeout(MODELS_TIMEOUT)
            .send()
            .await
            .map_err(|error| LlmError::network("Liste des modèles indisponible", error))?;
        if !response.status().is_success() {
            return Err(failure(response).await);
        }
        let trop_gros = || {
            LlmError::new(format!(
                "Liste des modèles trop volumineuse (plus de {} Mio).",
                MODELS_BODY_BYTES / (1024 * 1024)
            ))
        };
        if response
            .content_length()
            .is_some_and(|length| length > MODELS_BODY_BYTES as u64)
        {
            return Err(trop_gros());
        }
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| LlmError::network("Liste des modèles illisible", error))?
        {
            if body.len() + chunk.len() > MODELS_BODY_BYTES {
                return Err(trop_gros());
            }
            body.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&body)
            .map_err(|error| LlmError::new(format!("Liste des modèles illisible : {error}")))
    }

    /// `POST /v1/chat/completions` en streaming. Chaque fragment de texte part
    /// dans `sink` ; renvoie le dernier message (fin ou erreur), que l'appelant
    /// envoie à son tour. `sink` renvoie faux quand la page n'écoute plus.
    pub async fn chat(
        &self,
        id: u64,
        upstream: Option<Upstream>,
        body: Value,
        mut sink: impl FnMut(LlmEvent) -> bool,
    ) -> LlmEvent {
        let started = Instant::now();
        let (cancel_tx, cancel_rx) = oneshot::channel();
        {
            let mut running = self.running();
            if running.contains_key(&id) {
                return LlmEvent::Error(LlmError::new(format!(
                    "Une requête {id} est déjà en cours."
                )));
            }
            running.insert(id, cancel_tx);
        }
        let result = tokio::select! {
            // Abandonner l'autre branche ferme la connexion vers le modèle.
            Ok(()) = cancel_rx => Err(LlmError::cancelled()),
            result = stream(&self.client, upstream, body, &mut sink, started) => result,
        };
        self.running().remove(&id);
        match result {
            Ok(mut stats) => {
                stats.duration_ms = elapsed_ms(started);
                LlmEvent::Done(stats)
            }
            Err(error) => LlmEvent::Error(error),
        }
    }
}

fn client_builder() -> reqwest::ClientBuilder {
    // reqwest est compilé sans fournisseur cryptographique (`rustls-no-provider`) :
    // celui du processus doit être installé avant de créer un client.
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        // Échoue seulement si un autre fil l'a installé entre-temps.
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(READ_TIMEOUT)
        .user_agent(concat!("Grammaria/", env!("CARGO_PKG_VERSION")))
        .redirect(redirect::Policy::custom(|attempt| {
            match redirection(attempt.previous(), attempt.url()) {
                Ok(()) => attempt.follow(),
                Err(message) => attempt.error(message),
            }
        }))
}

/// Décision pour une redirection : suivie seulement si elle reste sur
/// l'origine (schéma, hôte, port) de la requête d'origine, et au plus
/// `MAX_REDIRECTS` fois. Le corps (le texte de l'utilisateur) et la clé ne
/// doivent jamais partir vers un autre serveur que celui des réglages.
fn redirection(previous: &[Url], next: &Url) -> Result<(), String> {
    let Some(first) = previous.first() else {
        return Ok(());
    };
    if previous.len() > MAX_REDIRECTS {
        return Err(format!(
            "Le serveur du modèle redirige plus de {MAX_REDIRECTS} fois."
        ));
    }
    if next.origin() != first.origin() {
        return Err(format!(
            "Le serveur du modèle redirige vers une autre adresse ({}) : redirection refusée. Corrigez l'adresse dans les réglages.",
            next.origin().ascii_serialization()
        ));
    }
    Ok(())
}

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

/// Requête vers le serveur des réglages, au chemin `segments` joint à son
/// adresse. `Authorization` seulement s'il y a une clé ; les redirections ne
/// sont suivies que sur la même origine (`redirections`).
fn request(
    client: &Client,
    upstream: Option<Upstream>,
    method: Method,
    segments: &[&str],
) -> Result<RequestBuilder, LlmError> {
    let upstream = upstream.ok_or_else(|| {
        LlmError::new("Aucun modèle n'est configuré : renseignez son adresse dans les réglages.")
    })?;
    // Une adresse enregistrée par une version plus ancienne peut contenir des
    // paramètres ou des identifiants : refusée ici, avec le message des réglages.
    let url = endpoint(&upstream.target, segments).map_err(LlmError::new)?;
    let mut builder = client.request(method, url);
    if !upstream.api_key.is_empty() {
        builder = builder.bearer_auth(upstream.api_key);
    }
    Ok(builder)
}

/// Réponse amont en échec : statut et corps (tronqué), pour que la page
/// reconnaisse par exemple le refus de `chat_template_kwargs`.
async fn failure(mut response: Response) -> LlmError {
    let status = response.status();
    // Au plus ERROR_BODY_BYTES octets gardés, même si un paquet est énorme ;
    // le reste du corps n'est pas lu (la connexion est abandonnée).
    let mut body = Vec::new();
    while body.len() < ERROR_BODY_BYTES {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                let place = ERROR_BODY_BYTES - body.len();
                body.extend_from_slice(&chunk[..chunk.len().min(place)]);
            }
            _ => break,
        }
    }
    let text = String::from_utf8_lossy(&body);
    let mut message: String = text.trim().chars().take(ERROR_MESSAGE_CHARS).collect();
    if message.is_empty() {
        message = format!("HTTP {status}");
    }
    LlmError {
        status: Some(status.as_u16()),
        message,
        cancelled: false,
    }
}

/// Envoie la requête et relaie le flux jusqu'à `[DONE]` ou la fin du corps.
async fn stream(
    client: &Client,
    upstream: Option<Upstream>,
    mut body: Value,
    sink: &mut impl FnMut(LlmEvent) -> bool,
    started: Instant,
) -> Result<LlmStats, LlmError> {
    let Some(fields) = body.as_object_mut() else {
        return Err(LlmError::new(
            "Le corps de la requête du modèle doit être un objet JSON.",
        ));
    };
    fields.insert("stream".into(), Value::Bool(true));
    let mut response = request(
        client,
        upstream,
        Method::POST,
        &["v1", "chat", "completions"],
    )?
    .json(&body)
    .send()
    .await
    .map_err(|error| LlmError::network("Serveur du modèle injoignable", error))?;
    if !response.status().is_success() {
        return Err(failure(response).await);
    }

    let mut relay = Relay {
        stats: LlmStats::default(),
        started,
    };
    let mut parser = SseParser::default();
    loop {
        let chunk = response
            .chunk()
            .await
            .map_err(|error| LlmError::network("Flux du modèle interrompu", error))?;
        let events = match &chunk {
            Some(bytes) => parser.feed(bytes)?,
            None => parser.finish()?,
        };
        for event in events {
            if relay.event(&event, sink)? == Flow::Done {
                return Ok(relay.stats);
            }
        }
        if chunk.is_none() {
            // Fin du corps sans `[DONE]` : le texte reçu est complet.
            return Ok(relay.stats);
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Flow {
    Continue,
    Done,
}

/// Interprétation des événements SSE d'une API compatible OpenAI.
struct Relay {
    stats: LlmStats,
    started: Instant,
}

impl Relay {
    /// Un événement : ses lignes `data:` jointes par `\n` (norme SSE). Un
    /// serveur qui enchaîne des `data:` sans ligne vide entre deux objets
    /// JSON est aussi accepté, ligne par ligne.
    fn event(
        &mut self,
        lines: &[String],
        sink: &mut impl FnMut(LlmEvent) -> bool,
    ) -> Result<Flow, LlmError> {
        let joined = lines.join("\n");
        if lines.len() > 1 && serde_json::from_str::<Value>(&joined).is_err() {
            for line in lines {
                if self.data(line, sink)? == Flow::Done {
                    return Ok(Flow::Done);
                }
            }
            return Ok(Flow::Continue);
        }
        self.data(&joined, sink)
    }

    fn data(
        &mut self,
        data: &str,
        sink: &mut impl FnMut(LlmEvent) -> bool,
    ) -> Result<Flow, LlmError> {
        let data = data.trim();
        if data == "[DONE]" {
            return Ok(Flow::Done);
        }
        // Autre chose que du JSON (message de service…) : ignoré.
        let Ok(event) = serde_json::from_str::<Value>(data) else {
            return Ok(Flow::Continue);
        };
        // Erreur signalée dans le flux (vLLM, fournisseurs en ligne).
        if let Some(error) = event.get("error").filter(|error| !error.is_null()) {
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .map_or_else(|| error.to_string(), str::to_owned);
            return Err(LlmError::new(message));
        }
        let delta = &event["choices"][0]["delta"];
        let has = |key: &str| delta[key].as_str().is_some_and(|text| !text.is_empty());
        if has("reasoning_content") || has("reasoning") {
            self.stats.reasoning_chunks += 1;
        }
        if let Some(text) = delta["content"].as_str().filter(|text| !text.is_empty()) {
            self.stats
                .first_token_ms
                .get_or_insert_with(|| elapsed_ms(self.started));
            self.stats.content_chunks += 1;
            if !sink(LlmEvent::Delta(text.to_owned())) {
                // La page ne reçoit plus rien (fenêtre fermée, rechargée).
                return Err(LlmError::cancelled());
            }
        }
        Ok(Flow::Continue)
    }
}

/// Lecteur SSE incrémental. Les octets reçus sont mis de côté jusqu'à une fin
/// de ligne complète (LF, CRLF ou CR) : un paquet coupé au milieu d'une ligne
/// ou d'un caractère UTF-8 n'est décodé qu'une fois la ligne entière reçue.
#[derive(Default)]
struct SseParser {
    buffer: Vec<u8>,
    /// Position du tampon jusqu'où aucune fin de ligne n'a été trouvée : la
    /// recherche reprend là, sans relire une longue ligne à chaque paquet.
    scanned: usize,
    /// Lignes `data:` de l'événement en cours, et leur taille cumulée.
    data: Vec<String>,
    data_bytes: usize,
}

impl SseParser {
    /// Ajoute des octets ; renvoie les événements terminés (lignes `data:`).
    fn feed(&mut self, bytes: &[u8]) -> Result<Vec<Vec<String>>, LlmError> {
        self.buffer.extend_from_slice(bytes);
        let mut events = Vec::new();
        let mut start = 0;
        let mut from = self.scanned;
        loop {
            let Some(offset) = self.buffer[from..]
                .iter()
                .position(|byte| *byte == b'\n' || *byte == b'\r')
            else {
                from = self.buffer.len();
                break;
            };
            let end = from + offset;
            let next = match self.buffer[end] {
                b'\n' => end + 1,
                // CR en dernier octet : peut-être un CRLF coupé, on attend.
                _ if end + 1 == self.buffer.len() => {
                    from = end;
                    break;
                }
                _ if self.buffer[end + 1] == b'\n' => end + 2,
                _ => end + 1,
            };
            let line = String::from_utf8_lossy(&self.buffer[start..end]).into_owned();
            self.line(&line, &mut events)?;
            start = next;
            from = next;
        }
        self.buffer.drain(..start);
        self.scanned = from - start;
        if self.buffer.len() > MAX_LINE_BYTES {
            return Err(LlmError::new(
                "Flux du modèle invalide : ligne trop longue.",
            ));
        }
        Ok(events)
    }

    /// Fin du corps : dernière ligne sans fin de ligne et événement en cours.
    fn finish(&mut self) -> Result<Vec<Vec<String>>, LlmError> {
        let mut events = Vec::new();
        let mut rest = std::mem::take(&mut self.buffer);
        self.scanned = 0;
        if rest.last() == Some(&b'\r') {
            rest.pop();
        }
        if !rest.is_empty() {
            let line = String::from_utf8_lossy(&rest).into_owned();
            self.line(&line, &mut events)?;
        }
        self.line("", &mut events)?;
        Ok(events)
    }

    fn line(&mut self, line: &str, events: &mut Vec<Vec<String>>) -> Result<(), LlmError> {
        if line.is_empty() {
            if !self.data.is_empty() {
                events.push(std::mem::take(&mut self.data));
                self.data_bytes = 0;
            }
            return Ok(());
        }
        // Commentaire (« : keepalive »).
        if line.starts_with(':') {
            return Ok(());
        }
        let (field, value) = line.split_once(':').unwrap_or((line, ""));
        if field == "data" {
            let value = value.strip_prefix(' ').unwrap_or(value);
            // Mémoire réelle : le texte et la `String` qui le porte.
            self.data_bytes += value.len() + std::mem::size_of::<String>();
            if self.data_bytes > MAX_EVENT_BYTES {
                return Err(LlmError::new(
                    "Flux du modèle invalide : événement trop long.",
                ));
            }
            self.data.push(value.to_owned());
        }
        // `event`, `id`, `retry` : sans usage pour une API OpenAI.
        Ok(())
    }
}

/// `GET /v1/models` du serveur des réglages (JSON tel quel).
#[tauri::command]
pub async fn llm_models(store: State<'_, Store>, llm: State<'_, Llm>) -> Result<Value, LlmError> {
    let upstream = store.upstream();
    let cle = upstream.as_ref().map(|u| u.api_key.clone());
    llm.models(upstream)
        .await
        .inspect_err(|error| journaliser("llm_models", error, cle.as_deref()))
}

/// Erreur du relais dans le journal technique : statut et message (corps de la
/// réponse amont, tronqué et masqué), jamais la clé ni le texte envoyé. Une
/// annulation (bouton « Arrêter ») n'est pas une erreur.
fn journaliser(commande: &str, error: &LlmError, cle: Option<&str>) {
    if error.cancelled {
        return;
    }
    // Aucun modèle configuré (premier lancement) : un état, pas une panne.
    let Some(cle) = cle else {
        logs::ecrire(logs::Niveau::Info, commande, "Aucun modèle configuré.");
        return;
    };
    let statut = error.status.map_or_else(
        || "sans réponse".to_string(),
        |status| format!("HTTP {status}"),
    );
    logs::ecrire_masque(
        logs::Niveau::Erreur,
        commande,
        &format!(
            "Relais du modèle ({statut}) : {}",
            message_sans_entree(&error.message)
        ),
        &[cle],
    );
}

/// Message d'erreur amont sans la requête qu'il recopierait : une erreur de
/// validation (FastAPI, vLLM…) cite la valeur refusée (`"input": …`), un
/// relais comme LiteLLM recopie parfois toute la requête (`'messages': […]`,
/// `messages=[…]`) : le texte de l'utilisateur ne doit pas entrer dans le
/// journal technique. Le message est coupé à la première clé qui peut le porter
/// (`input`, `inputs`, `messages`, `content`, `prompt`, `text`, entre
/// guillemets doubles, simples ou échappés, suivie de `:` ou `=`, ou nue
/// devant `=`), puis borné à 300 caractères.
fn message_sans_entree(message: &str) -> String {
    static CLES: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let cles = CLES.get_or_init(|| {
        regex::Regex::new(
            r#"(?i)["'\\]+(?:input|inputs|messages|content|prompt|text)["'\\]+\s*[:=]|\b(?:input|inputs|messages|content|prompt|text)\s*="#,
        )
        .expect("motif valide")
    });
    let coupe = cles.find(message).map_or(message.len(), |m| m.start());
    let mut texte: String = message[..coupe].chars().take(300).collect();
    if texte.len() < message.len() {
        texte.push('…');
    }
    texte
}

/// Correction en streaming : fragments, puis fin ou erreur, par `on_event`.
#[tauri::command]
pub async fn llm_chat(
    store: State<'_, Store>,
    llm: State<'_, Llm>,
    request_id: u64,
    body: Value,
    on_event: Channel<LlmEvent>,
) -> Result<(), String> {
    let upstream = store.upstream();
    let cle = upstream.as_ref().map(|u| u.api_key.clone());
    let last = llm
        .chat(request_id, upstream, body, |event| {
            on_event.send(event).is_ok()
        })
        .await;
    if let LlmEvent::Error(error) = &last {
        journaliser("llm_chat", error, cle.as_deref());
    }
    on_event.send(last).map_err(|error| error.to_string())
}

/// Annule la requête `request_id` (bouton « Arrêter », nouvelle correction).
#[tauri::command]
pub fn llm_cancel(llm: State<'_, Llm>, request_id: u64) -> bool {
    llm.cancel(request_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::mpsc;
    use std::sync::Arc;

    /// Requête reçue par le serveur de test.
    #[derive(Debug)]
    struct Received {
        line: String,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    }

    impl Received {
        fn header(&self, name: &str) -> Option<&str> {
            self.headers
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case(name))
                .map(|(_, value)| value.as_str())
        }
        fn json(&self) -> Value {
            serde_json::from_slice(&self.body).expect("corps JSON")
        }
    }

    fn read_request(stream: &mut TcpStream) -> Received {
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let mut headers = Vec::new();
        loop {
            let mut header = String::new();
            reader.read_line(&mut header).unwrap();
            let header = header.trim_end();
            if header.is_empty() {
                break;
            }
            let (key, value) = header.split_once(':').unwrap();
            headers.push((key.trim().to_owned(), value.trim().to_owned()));
        }
        let length: usize = headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case("content-length"))
            .map_or(0, |(_, value)| value.parse().unwrap());
        let mut body = vec![0; length];
        reader.read_exact(&mut body).unwrap();
        Received {
            line: line.trim_end().to_owned(),
            headers,
            body,
        }
    }

    /// Petit serveur HTTP local : une connexion, traitée par `respond`, qui
    /// écrit la réponse brute (morceau par morceau s'il le veut).
    fn serve(
        respond: impl FnOnce(&mut TcpStream) + Send + 'static,
    ) -> (String, mpsc::Receiver<Received>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let received = read_request(&mut stream);
            tx.send(received).unwrap();
            respond(&mut stream);
        });
        (address, rx)
    }

    fn send_parts(stream: &mut TcpStream, parts: &[&[u8]]) {
        for part in parts {
            stream.write_all(part).unwrap();
            stream.flush().unwrap();
            std::thread::sleep(Duration::from_millis(15));
        }
    }

    /// En-tête d'une réponse SSE sans longueur : le corps finit à la fermeture.
    const SSE_HEAD: &[u8] =
        b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n";

    fn llm() -> Llm {
        // Pas de proxy du système dans les tests : le serveur est local.
        Llm::with_client(client_builder().no_proxy().build().unwrap())
    }

    fn upstream(target: &str, key: &str) -> Option<Upstream> {
        Some(Upstream {
            target: target.to_owned(),
            api_key: key.to_owned(),
        })
    }

    fn run(
        llm: &Llm,
        id: u64,
        upstream: Option<Upstream>,
        body: Value,
    ) -> (Vec<LlmEvent>, LlmEvent) {
        let mut events = Vec::new();
        let last = tauri::async_runtime::block_on(llm.chat(id, upstream, body, |event| {
            events.push(event);
            true
        }));
        (events, last)
    }

    fn deltas(events: &[LlmEvent]) -> String {
        events
            .iter()
            .map(|event| match event {
                LlmEvent::Delta(text) => text.as_str(),
                other => panic!("message inattendu avant la fin : {other:?}"),
            })
            .collect()
    }

    #[test]
    fn le_flux_est_relaye_fragment_par_fragment() {
        let (address, received) = serve(|stream| {
            let e_aigu = "é".as_bytes();
            send_parts(
                stream,
                &[
                    SSE_HEAD,
                    b": keepalive\n\n",
                    b"data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"je r\xc3\xa9fl\xc3\xa9chis\"}}]}\n\n",
                    // Coupé au milieu d'une ligne…
                    b"data: {\"choices\":[{\"delta\":{\"content\":\"Il a mang",
                    // … et au milieu du caractère « é » (2 octets en UTF-8).
                    &e_aigu[..1],
                    &[&e_aigu[1..], b"\"}}]}\r\n\r\n".as_ref()].concat(),
                    "data: {\"choices\":[{\"delta\":{\"content\":\" des pommes 🍎.\"}}]}\r\n\r\n".as_bytes(),
                    b"data: {\"choices\":[{\"delta\":{}}],\"usage\":{\"total_tokens\":9}}\n\n",
                    b"data: [DONE]\n\n",
                    // Après [DONE] : ignoré.
                    b"data: {\"choices\":[{\"delta\":{\"content\":\"jamais\"}}]}\n\n",
                ],
            );
        });
        let body = json!({
            "model": "modele-de-test",
            "messages": [{ "role": "user", "content": "Il a mangé des pommes." }],
            "temperature": 0.1,
            "chat_template_kwargs": { "enable_thinking": false },
            "stream": false,
        });
        let (events, last) = run(&llm(), 1, upstream(&address, "sk-test"), body.clone());
        assert_eq!(deltas(&events), "Il a mangé des pommes 🍎.");
        let LlmEvent::Done(stats) = last else {
            panic!("fin attendue : {last:?}");
        };
        assert_eq!(stats.content_chunks, 2);
        assert_eq!(stats.reasoning_chunks, 1);
        assert!(stats.first_token_ms.is_some());

        let request = received.recv().unwrap();
        assert_eq!(request.line, "POST /v1/chat/completions HTTP/1.1");
        assert_eq!(request.header("authorization"), Some("Bearer sk-test"));
        assert_eq!(request.header("content-type"), Some("application/json"));
        // Corps transmis tel quel, `stream` forcé à vrai.
        let mut expected = body;
        expected["stream"] = json!(true);
        assert_eq!(request.json(), expected);
    }

    #[test]
    fn sans_cle_aucun_en_tete_authorization() {
        let (address, received) = serve(|stream| {
            send_parts(stream, &[SSE_HEAD, b"data: [DONE]\n\n"]);
        });
        let (events, last) = run(&llm(), 1, upstream(&address, ""), json!({ "messages": [] }));
        assert!(events.is_empty());
        assert!(matches!(last, LlmEvent::Done(_)));
        assert_eq!(received.recv().unwrap().header("authorization"), None);
    }

    #[test]
    fn un_refus_http_400_est_relaye_avec_son_statut_et_son_corps() {
        let corps = r#"{"object":"error","message":"chat_template_kwargs is not supported","type":"BadRequestError","code":400}"#;
        let (address, _received) = serve(move |stream| {
            let response = format!(
                "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{corps}",
                corps.len()
            );
            send_parts(stream, &[response.as_bytes()]);
        });
        let (events, last) = run(&llm(), 1, upstream(&address, "k"), json!({}));
        assert!(events.is_empty());
        let expected = LlmError {
            status: Some(400),
            message: corps.to_owned(),
            cancelled: false,
        };
        assert_eq!(last, LlmEvent::Error(expected));
        // Forme reçue par la page (contrat LlmEvent).
        assert_eq!(
            serde_json::to_value(&last).unwrap(),
            json!({ "event": "error", "data": { "status": 400, "message": corps, "cancelled": false } })
        );
    }

    #[test]
    fn une_erreur_dans_le_flux_termine_la_requete() {
        let (address, _received) = serve(|stream| {
            send_parts(
                stream,
                &[
                    SSE_HEAD,
                    "data: {\"choices\":[{\"delta\":{\"content\":\"Dé\"}}]}\n\n".as_bytes(),
                    b"data: {\"error\":{\"message\":\"context length exceeded\"}}\n\n",
                ],
            );
        });
        let (events, last) = run(&llm(), 1, upstream(&address, ""), json!({}));
        assert_eq!(deltas(&events), "Dé");
        assert_eq!(
            last,
            LlmEvent::Error(LlmError::new("context length exceeded"))
        );
    }

    #[test]
    fn l_annulation_coupe_le_flux() {
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let (address, _received) = serve(move |stream| {
            send_parts(
                stream,
                &[
                    SSE_HEAD,
                    b"data: {\"choices\":[{\"delta\":{\"content\":\"Un\"}}]}\n\n",
                ],
            );
            // Le modèle « réfléchit » : plus rien jusqu'à la fin du test.
            let _ = release_rx.recv_timeout(Duration::from_secs(30));
        });
        let llm = Arc::new(llm());
        let canceller = llm.clone();
        let started = Instant::now();
        let mut events = Vec::new();
        let last = tauri::async_runtime::block_on(llm.chat(
            7,
            upstream(&address, ""),
            json!({}),
            |event| {
                events.push(event);
                // Premier fragment reçu : l'utilisateur clique sur « Arrêter ».
                assert!(canceller.cancel(7));
                true
            },
        ));
        assert_eq!(deltas(&events), "Un");
        assert_eq!(last, LlmEvent::Error(LlmError::cancelled()));
        assert!(started.elapsed() < Duration::from_secs(5));
        // Terminée : plus rien à annuler, l'identifiant est libre.
        assert!(!llm.cancel(7));
        assert!(llm.running().is_empty());
        let _ = release_tx.send(());
    }

    #[test]
    fn la_coupure_d_un_caractere_utf8_entre_deux_paquets_ne_l_abime_pas() {
        // Chaque octet dans son propre paquet, CRLF compris.
        let flux = "data: {\"choices\":[{\"delta\":{\"content\":\"à l’été 🙂\"}}]}\r\n\r\ndata: [DONE]\r\n\r\n";
        let mut parser = SseParser::default();
        let mut events = Vec::new();
        for byte in flux.as_bytes() {
            events.extend(parser.feed(std::slice::from_ref(byte)).unwrap());
        }
        assert_eq!(events.len(), 2);
        let mut relay = Relay {
            stats: LlmStats::default(),
            started: Instant::now(),
        };
        let mut texte = String::new();
        let mut sink = |event: LlmEvent| {
            if let LlmEvent::Delta(delta) = event {
                texte.push_str(&delta);
            }
            true
        };
        assert_eq!(relay.event(&events[0], &mut sink).unwrap(), Flow::Continue);
        assert_eq!(relay.event(&events[1], &mut sink).unwrap(), Flow::Done);
        assert_eq!(texte, "à l’été 🙂");

        // Et à travers le réseau, coupé au milieu de l'émoji (4 octets).
        let emoji = "🙂".as_bytes();
        let premier = [
            b"data: {\"choices\":[{\"delta\":{\"content\":\"".as_ref(),
            &emoji[..2],
        ]
        .concat();
        let second = [&emoji[2..], b"\"}}]}\n\n".as_ref()].concat();
        let (address, _received) = serve(move |stream| {
            send_parts(stream, &[SSE_HEAD, &premier, &second]);
        });
        // Fin du corps sans [DONE] : la requête se termine normalement.
        let (events, last) = run(&llm(), 1, upstream(&address, ""), json!({}));
        assert_eq!(deltas(&events), "🙂");
        assert!(matches!(last, LlmEvent::Done(_)));
    }

    #[test]
    fn les_variantes_de_sse_sont_comprises() {
        let mut parser = SseParser::default();
        // CR seul, champ sans espace, plusieurs `data:` dans un événement.
        let mut events = parser
            .feed(b"data:{\"a\":\r\rdata: {\"b\":1}\ndata: {\"c\":2}\n\nevent: x\nid: 3\n\n")
            .unwrap();
        events.extend(parser.finish().unwrap());
        assert_eq!(
            events,
            vec![
                vec!["{\"a\":".to_owned()],
                vec!["{\"b\":1}".to_owned(), "{\"c\":2}".to_owned()],
            ]
        );
        // Dernière ligne sans fin de ligne : relue à la fermeture.
        let mut parser = SseParser::default();
        assert!(parser.feed(b"data: [DONE]").unwrap().is_empty());
        assert_eq!(parser.finish().unwrap(), vec![vec!["[DONE]".to_owned()]]);
        // Deux objets JSON sans ligne vide entre eux : relus un par un.
        let mut relay = Relay {
            stats: LlmStats::default(),
            started: Instant::now(),
        };
        let mut texte = String::new();
        let lignes = vec![
            r#"{"choices":[{"delta":{"content":"a"}}]}"#.to_owned(),
            r#"{"choices":[{"delta":{"content":"b"}}]}"#.to_owned(),
        ];
        relay
            .event(&lignes, &mut |event| {
                if let LlmEvent::Delta(delta) = event {
                    texte.push_str(&delta);
                }
                true
            })
            .unwrap();
        assert_eq!(texte, "ab");
    }

    #[test]
    fn la_liste_des_modeles_passe_par_les_reglages() {
        let (address, received) = serve(|stream| {
            let corps = r#"{"object":"list","data":[{"id":"m1"}]}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{corps}",
                corps.len()
            );
            send_parts(stream, &[response.as_bytes()]);
        });
        let models = tauri::async_runtime::block_on(llm().models(upstream(&address, "cle")));
        assert_eq!(models.unwrap()["data"][0]["id"], "m1");
        let request = received.recv().unwrap();
        assert_eq!(request.line, "GET /v1/models HTTP/1.1");
        assert_eq!(request.header("authorization"), Some("Bearer cle"));

        let (address, _received) = serve(|stream| {
            send_parts(
                stream,
                &[b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n"],
            );
        });
        let error =
            tauri::async_runtime::block_on(llm().models(upstream(&address, "x"))).unwrap_err();
        assert_eq!(error.status, Some(401));
        assert_eq!(error.message, "HTTP 401 Unauthorized");
    }

    #[test]
    fn sans_modele_configure_ou_serveur_injoignable_l_erreur_est_lisible() {
        let (events, last) = run(&llm(), 1, None, json!({}));
        assert!(events.is_empty());
        let LlmEvent::Error(error) = last else {
            panic!()
        };
        assert!(error.message.starts_with("Aucun modèle n'est configuré"));
        assert_eq!(error.status, None);

        // Port fermé : connexion refusée, message sans l'adresse complète.
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let (_, last) = run(
            &llm(),
            2,
            upstream(&format!("http://127.0.0.1:{port}"), "sk-ne-pas-montrer"),
            json!({}),
        );
        let LlmEvent::Error(error) = last else {
            panic!()
        };
        assert!(
            error.message.starts_with("Serveur du modèle injoignable"),
            "{}",
            error.message
        );
        assert!(!error.message.contains("sk-ne-pas-montrer"));
        assert!(
            !error.message.contains("/v1/chat/completions"),
            "{}",
            error.message
        );

        // Corps qui n'est pas un objet : refusé sans rien envoyer.
        let (_, last) = run(&llm(), 3, upstream("http://127.0.0.1:9", ""), json!([1, 2]));
        let LlmEvent::Error(error) = last else {
            panic!()
        };
        assert!(error.message.contains("objet JSON"));
    }

    #[test]
    fn un_identifiant_deja_en_cours_est_refuse() {
        let llm = llm();
        let (tx, _rx) = oneshot::channel();
        llm.running().insert(4, tx);
        let (_, last) = run(&llm, 4, upstream("http://127.0.0.1:9", ""), json!({}));
        let LlmEvent::Error(error) = last else {
            panic!()
        };
        assert!(error.message.contains("déjà en cours"));
        // La requête existante n'a pas été annulée par la seconde.
        assert!(llm.running().contains_key(&4));
    }

    #[test]
    fn les_messages_du_channel_suivent_le_contrat() {
        assert_eq!(
            serde_json::to_value(LlmEvent::Delta("é".into())).unwrap(),
            json!({ "event": "delta", "data": "é" })
        );
        let done = LlmEvent::Done(LlmStats {
            duration_ms: 12,
            first_token_ms: Some(3),
            reasoning_chunks: 0,
            content_chunks: 2,
        });
        assert_eq!(
            serde_json::to_value(done).unwrap(),
            json!({ "event": "done", "data": { "durationMs": 12, "firstTokenMs": 3, "reasoningChunks": 0, "contentChunks": 2 } })
        );
        assert_eq!(
            serde_json::to_value(LlmEvent::Error(LlmError::cancelled())).unwrap(),
            json!({ "event": "error", "data": { "message": "Requête annulée.", "cancelled": true } })
        );
    }

    /// Le journal technique ne reçoit pas la requête qu'un message d'erreur amont recopie.
    #[test]
    fn le_message_journalise_ne_recopie_pas_la_requete() {
        let pydantic = r#"{"detail":[{"type":"extra_forbidden","loc":["body","x"],"msg":"Extra inputs are not permitted","input":{"messages":[{"role":"user","content":"Mon texte privé"}]}}]}"#;
        let journalise = message_sans_entree(pydantic);
        assert!(!journalise.contains("Mon texte privé"));
        assert!(journalise.contains("Extra inputs are not permitted"));
        assert!(journalise.ends_with('…'));
        assert_eq!(message_sans_entree("HTTP 503"), "HTTP 503");
        assert_eq!(message_sans_entree(&"é".repeat(400)).chars().count(), 301);
    }

    /// Formes réalistes : relais (LiteLLM) qui recopie la requête en dict
    /// Python, JSON échappé dans une chaîne, `prompt` / `text` des API de
    /// complétion, arguments nommés.
    #[test]
    fn le_message_journalise_ne_recopie_pas_la_requete_sous_aucune_forme() {
        let prive = "Mon texte privé";
        let cas = [
            (
                format!("litellm.BadRequestError: OpenAIException - Error code: 400 - {{'error': {{'message': 'context length exceeded'}}}} Received Model Group=gpt\nkwargs={{'messages': [{{'role': 'user', 'content': '{prive}'}}]}}"),
                "context length exceeded",
            ),
            (
                format!("{{'detail': 'bad request', 'input': {{'content': '{prive}'}}}}"),
                "bad request",
            ),
            (
                format!(
                    r#"{{"error":{{"message":"upstream error: {{\"messages\":[{{\"role\":\"user\",\"content\":\"{prive}\"}}]}}"}}}}"#
                ),
                "upstream error",
            ),
            (
                format!(r#"{{"error":"Input validation error","prompt":"{prive}"}}"#),
                "Input validation error",
            ),
            (
                format!(r#"{{"object":"error","message":"invalid request","text":"{prive}"}}"#),
                "invalid request",
            ),
            (
                format!("TypeError: create() got an unexpected keyword argument; messages=[{{'content': '{prive}'}}]"),
                "unexpected keyword argument",
            ),
        ];
        for (message, garde) in cas {
            let journalise = message_sans_entree(&message);
            assert!(!journalise.contains(prive), "{journalise}");
            assert!(journalise.contains(garde), "{journalise}");
        }
        // Le mot seul, sans valeur, ne coupe rien.
        let neutre =
            r#"{"error":{"message":"content type must be text","type":"invalid_request_error"}}"#;
        assert_eq!(message_sans_entree(neutre), neutre);
    }

    #[test]
    fn un_evenement_sans_fin_est_refuse() {
        // `data: x` sans jamais de ligne vide : l'événement grossirait sans fin.
        let mut parser = SseParser::default();
        let paquet = b"data: x\n".repeat(64 * 1024);
        let mut resultat = Ok(Vec::new());
        for _ in 0..1_000 {
            resultat = parser.feed(&paquet);
            if resultat.is_err() {
                break;
            }
        }
        assert_eq!(
            resultat.unwrap_err().message,
            "Flux du modèle invalide : événement trop long."
        );

        // À travers le réseau : la requête se termine en erreur, sans attendre.
        let (address, _received) = serve(|stream| {
            stream.write_all(SSE_HEAD).unwrap();
            let paquet = b"data: x\n".repeat(8 * 1024);
            while stream.write_all(&paquet).is_ok() {}
        });
        let (events, last) = run(&llm(), 1, upstream(&address, ""), json!({}));
        assert!(events.is_empty());
        let LlmEvent::Error(error) = last else {
            panic!("erreur attendue : {last:?}")
        };
        assert!(
            error.message.contains("événement trop long"),
            "{}",
            error.message
        );
    }

    #[test]
    fn une_longue_ligne_en_petits_paquets_est_lue_en_temps_lineaire() {
        // 4 Mio en paquets de 64 octets : relire le tampon à chaque paquet
        // coûterait de l'ordre de 10^11 comparaisons.
        let ligne = format!("data: \"{}\"\n\n", "a".repeat(4 * 1024 * 1024));
        let mut parser = SseParser::default();
        let debut = Instant::now();
        let mut events = Vec::new();
        for paquet in ligne.as_bytes().chunks(64) {
            events.extend(parser.feed(paquet).unwrap());
        }
        assert_eq!(events.len(), 1);
        assert_eq!(events[0][0].len(), 4 * 1024 * 1024 + 2);
        assert!(
            debut.elapsed() < Duration::from_secs(5),
            "{:?}",
            debut.elapsed()
        );
        // La reprise de la recherche n'oublie pas un CR coupé de son LF.
        let mut parser = SseParser::default();
        assert!(parser.feed(b"data: a\r").unwrap().is_empty());
        assert_eq!(parser.feed(b"\n\r\n").unwrap(), vec![vec!["a".to_owned()]]);
    }

    #[test]
    fn la_liste_des_modeles_et_le_corps_d_erreur_sont_bornes() {
        // Liste énorme annoncée par Content-Length : refusée sans la lire.
        let (address, _received) = serve(|stream| {
            let tete = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
                MODELS_BODY_BYTES + 1
            );
            let _ = stream.write_all(tete.as_bytes());
        });
        let error =
            tauri::async_runtime::block_on(llm().models(upstream(&address, ""))).unwrap_err();
        assert_eq!(
            error.message,
            "Liste des modèles trop volumineuse (plus de 8 Mio)."
        );

        // Sans longueur annoncée : coupée dès que la borne est dépassée.
        let (address, _received) = serve(|stream| {
            let _ = stream.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"data\":[",
            );
            let paquet = b"{\"id\":\"modele\"},".repeat(4096);
            while stream.write_all(&paquet).is_ok() {}
        });
        let error =
            tauri::async_runtime::block_on(llm().models(upstream(&address, ""))).unwrap_err();
        assert!(
            error.message.contains("trop volumineuse"),
            "{}",
            error.message
        );

        // Corps d'erreur sans fin : au plus ERROR_BODY_BYTES lus, message borné.
        let (address, _received) = serve(|stream| {
            let _ = stream
                .write_all(b"HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n");
            let paquet = vec![b'e'; 256 * 1024];
            while stream.write_all(&paquet).is_ok() {}
        });
        let (_, last) = run(&llm(), 1, upstream(&address, ""), json!({}));
        let LlmEvent::Error(error) = last else {
            panic!("erreur attendue : {last:?}")
        };
        assert_eq!(error.status, Some(500));
        assert_eq!(error.message.chars().count(), ERROR_MESSAGE_CHARS);
    }

    /// Serveur local qui répond à `n` connexions successives.
    fn serve_n(
        n: usize,
        mut respond: impl FnMut(usize, &mut TcpStream) + Send + 'static,
    ) -> (String, mpsc::Receiver<Received>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for index in 0..n {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                let received = read_request(&mut stream);
                respond(index, &mut stream);
                let _ = tx.send(received);
            }
        });
        (address, rx)
    }

    #[test]
    fn une_redirection_sur_la_meme_origine_est_suivie_avec_la_cle() {
        let (address, received) = serve_n(2, |index, stream| {
            let reponse: &[u8] = if index == 0 {
                b"HTTP/1.1 307 Temporary Redirect\r\nLocation: /autre/v1/chat/completions\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            } else {
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n"
            };
            let _ = stream.write_all(reponse);
        });
        let (events, last) = run(
            &llm(),
            1,
            upstream(&address, "cle"),
            json!({ "messages": [] }),
        );
        assert_eq!(deltas(&events), "ok");
        assert!(matches!(last, LlmEvent::Done(_)), "{last:?}");
        let premiere = received.recv().unwrap();
        let seconde = received.recv().unwrap();
        assert_eq!(premiere.line, "POST /v1/chat/completions HTTP/1.1");
        assert_eq!(seconde.line, "POST /autre/v1/chat/completions HTTP/1.1");
        assert_eq!(seconde.header("authorization"), Some("Bearer cle"));
    }

    #[test]
    fn une_redirection_vers_une_autre_origine_est_refusee() {
        // L'autre origine : un second serveur, qui ne doit rien recevoir.
        let (ailleurs, recu_ailleurs) = serve_n(1, |_, stream| {
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
        });
        let location = format!("{ailleurs}/v1/chat/completions");
        let (address, _received) = serve_n(1, move |_, stream| {
            let reponse = format!(
                "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            let _ = stream.write_all(reponse.as_bytes());
        });
        let (events, last) = run(&llm(), 1, upstream(&address, "cle"), json!({}));
        assert!(events.is_empty());
        let LlmEvent::Error(error) = last else {
            panic!("erreur attendue : {last:?}")
        };
        assert!(
            error.message.contains("redirige vers une autre adresse"),
            "{}",
            error.message
        );
        assert!(recu_ailleurs
            .recv_timeout(Duration::from_millis(300))
            .is_err());
    }

    #[test]
    fn la_decision_de_redirection_compare_les_origines() {
        let url = |texte: &str| Url::parse(texte).unwrap();
        let origine = [url("https://api.exemple.fr/v1/models")];
        assert!(redirection(&origine, &url("https://api.exemple.fr/autre")).is_ok());
        assert!(redirection(&origine, &url("https://api.exemple.fr:443/x")).is_ok());
        for autre in [
            "http://api.exemple.fr/v1/models",
            "https://api.exemple.fr:8443/v1/models",
            "https://autre.exemple.fr/v1/models",
            "https://exemple.fr/v1/models",
        ] {
            assert!(redirection(&origine, &url(autre)).is_err(), "{autre}");
        }
        let chaine = vec![url("https://api.exemple.fr/"); MAX_REDIRECTS + 1];
        assert!(redirection(&chaine, &url("https://api.exemple.fr/x"))
            .unwrap_err()
            .contains("plus de 5 fois"));
    }

    #[test]
    fn les_chemins_sont_joints_et_une_ancienne_adresse_invalide_est_signalee() {
        let (address, received) = serve(|stream| {
            send_parts(stream, &[SSE_HEAD, b"data: [DONE]\n\n"]);
        });
        let (_, last) = run(
            &llm(),
            1,
            upstream(&format!("{address}/openai"), ""),
            json!({}),
        );
        assert!(matches!(last, LlmEvent::Done(_)), "{last:?}");
        assert_eq!(
            received.recv().unwrap().line,
            "POST /openai/v1/chat/completions HTTP/1.1"
        );

        // Adresse d'un ancien settings.json, avec identifiants : rien n'est envoyé.
        let (_, last) = run(
            &llm(),
            2,
            upstream("http://moi:secret@127.0.0.1:9", ""),
            json!({}),
        );
        let LlmEvent::Error(error) = last else {
            panic!("erreur attendue : {last:?}")
        };
        assert_eq!(error.message, crate::store::TARGET_EXTRAS_ERROR);
    }
}
