//! Réglages du modèle (`settings.json`) et mots valides (`valid-words.json`).
//!
//! Même format et mêmes validations que le serveur Bun (`settings.ts`, route
//! `/api/valid-words` de `server.ts`) : les fichiers existants sont repris
//! tels quels, et les messages d'erreur sont les mêmes.
//!
//! La clé API ne sort jamais de Rust : la page ne voit que `hasApiKey` et
//! `apiKeyStorage`. Elle n'est lue que par le relais du modèle (`llm.rs`), qui
//! l'envoie au seul serveur enregistré avec elle. Quand l'adresse du modèle
//! change de serveur (origine : schéma, hôte, port) sans qu'une nouvelle clé
//! soit fournie, la clé enregistrée est effacée : elle ne doit jamais partir
//! ailleurs.
//!
//! La clé est rangée dans le trousseau du système (`trousseau.rs`) ; le fichier
//! ne garde que l'indicateur `llmApiKeyInKeyring`. Sans trousseau (Linux sans
//! service de secrets), elle reste dans `settings.json`, lisible par le seul
//! compte (0600), et la page l'indique. Une clé en clair (version précédente,
//! ou trousseau devenu disponible) est déplacée dans le trousseau au démarrage
//! (`migrer_vers_le_trousseau`) : écrite, relue à l'identique, puis seulement
//! retirée du fichier.
//!
//! Les fichiers sont relus à chaque appel (ils font quelques centaines
//! d'octets) : un fichier modifié à la main est pris en compte sans relancer
//! l'application. La clé lue dans le trousseau est gardée en mémoire le temps
//! de l'exécution.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::logs;
use crate::trousseau::Coffre;
use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value};
use tauri::State;
use url::Url;

/// Noms des fichiers dans le dossier de données de l'application.
pub const SETTINGS_FILE: &str = "settings.json";
pub const VALID_WORDS_FILE: &str = "valid-words.json";

/// Version du fichier de réglages. Avant la 2, l'application de bureau
/// recopiait `llmDisableThinking` sans que l'utilisateur l'ait choisi : ce
/// champ est ignoré dans un fichier plus ancien (comme `settings.ts`).
const SETTINGS_VERSION: u32 = 2;

/// Longueur maximale d'un champ texte, en unités UTF-16 (`String.length`).
const MAX_FIELD_LENGTH: usize = 2_000;

/// Longueur maximale d'un mot valide, en unités UTF-16.
const MAX_WORD_LENGTH: usize = 100;

/// Réglages du modèle, clé comprise. Jamais sérialisé vers la page.
#[derive(Clone, PartialEq, Eq)]
pub struct LlmSettings {
    pub llm_target: String,
    /// Clé gardée dans le fichier (aucun trousseau disponible) ; vide sinon.
    pub llm_api_key: String,
    pub llm_model_name: String,
    pub llm_disable_thinking: bool,
    /// Une clé est rangée dans le trousseau du système (indicateur du fichier).
    pub cle_dans_le_trousseau: bool,
}

/// Sans la clé, pour qu'un `{:?}` ne la fasse jamais apparaître.
impl std::fmt::Debug for LlmSettings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LlmSettings")
            .field("llm_target", &self.llm_target)
            .field("has_api_key", &!self.llm_api_key.is_empty())
            .field("llm_model_name", &self.llm_model_name)
            .field("llm_disable_thinking", &self.llm_disable_thinking)
            .field("cle_dans_le_trousseau", &self.cle_dans_le_trousseau)
            .finish()
    }
}

impl LlmSettings {
    fn has_api_key(&self) -> bool {
        !self.llm_api_key.is_empty() || self.cle_dans_le_trousseau
    }

    /// Où est la clé ; `fichier` l'emporte (clé en clair, à déplacer).
    fn api_key_storage(&self) -> &'static str {
        if !self.llm_api_key.is_empty() {
            "fichier"
        } else if self.cle_dans_le_trousseau {
            "trousseau"
        } else {
            "aucune"
        }
    }
}

/// Valeurs du bureau sans fichier : aucun modèle (le serveur était lancé avec
/// `LLM_TARGET` vide), raisonnement coupé (`LLM_DISABLE_THINKING` non défini).
impl Default for LlmSettings {
    fn default() -> Self {
        Self {
            llm_target: String::new(),
            llm_api_key: String::new(),
            llm_model_name: String::new(),
            llm_disable_thinking: true,
            cle_dans_le_trousseau: false,
        }
    }
}

/// Vue publique, identique à `ServerSettings` (`src/services/settings.ts`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicSettings {
    pub editable: bool,
    pub configured: bool,
    pub llm_target: String,
    pub llm_model_name: String,
    pub llm_disable_thinking: bool,
    pub has_api_key: bool,
    /// `settings.json` présent mais illisible ou invalide : ses réglages (et
    /// la clé) sont ignorés, la page prévient l'utilisateur. Absent du JSON
    /// quand il est faux (champ facultatif de `ServerSettings`) ; redevient
    /// faux dès qu'un enregistrement réécrit le fichier.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub settings_unreadable: bool,
    /// Où est rangée la clé : `trousseau`, `fichier` (aucun trousseau
    /// disponible : fichier lisible par le seul compte) ou `aucune`. Propre au
    /// bureau : le serveur web n'envoie pas ce champ.
    pub api_key_storage: &'static str,
}

/// Contenu de `settings.json`, champs dans l'ordre écrit par `settings.ts`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsFile<'a> {
    settings_version: u32,
    llm_target: &'a str,
    llm_api_key: &'a str,
    llm_model_name: &'a str,
    llm_disable_thinking: bool,
    /// Absent quand il est faux : sans clé, ou clé dans le fichier (repli).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    llm_api_key_in_keyring: bool,
}

/// Indicateur non secret du fichier : la clé est dans le trousseau.
const KEYRING_FLAG: &str = "llmApiKeyInKeyring";

/// Champs fournis par une mise à jour (absents : inchangés).
#[derive(Default)]
struct SettingsUpdate {
    llm_target: Option<String>,
    llm_api_key: Option<String>,
    llm_model_name: Option<String>,
    llm_disable_thinking: Option<bool>,
    /// Lu dans le fichier seulement, jamais fourni par la page.
    cle_dans_le_trousseau: Option<bool>,
}

/// Accès aux deux fichiers et au trousseau. Le verrou sérialise les
/// lectures-écritures et garde la clé déjà lue dans le trousseau.
#[derive(Clone)]
pub struct Store(Arc<StoreInner>);

struct StoreInner {
    settings_path: PathBuf,
    words_path: PathBuf,
    coffre: Box<dyn Coffre>,
    /// Clé du trousseau lue ou écrite pendant cette exécution.
    cle_en_memoire: Mutex<Option<String>>,
}

/// Où envoyer les requêtes du modèle, et avec quelle clé.
pub struct Upstream {
    pub target: String,
    pub api_key: String,
}

impl std::fmt::Debug for Upstream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Upstream")
            .field("target", &self.target)
            .field("has_api_key", &!self.api_key.is_empty())
            .finish()
    }
}

impl Store {
    /// Fichiers `settings.json` et `valid-words.json` de `data_dir` ; clé dans
    /// `coffre` (le trousseau du système, ou un coffre en mémoire en test).
    pub fn new(data_dir: &Path, coffre: Box<dyn Coffre>) -> Self {
        Store(Arc::new(StoreInner {
            settings_path: data_dir.join(SETTINGS_FILE),
            words_path: data_dir.join(VALID_WORDS_FILE),
            coffre,
            cle_en_memoire: Mutex::new(None),
        }))
    }

    fn locked<T>(&self, work: impl FnOnce(&StoreInner, &mut Option<String>) -> T) -> T {
        let mut cle_en_memoire = self
            .0
            .cle_en_memoire
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        work(&self.0, &mut cle_en_memoire)
    }

    /// Réglages publics (sans la clé). Ne touche pas au trousseau.
    pub fn settings(&self) -> PublicSettings {
        self.locked(|inner, _| {
            let (exists, unreadable, settings) = read_settings_state(&inner.settings_path);
            PublicSettings {
                settings_unreadable: unreadable,
                ..public_view(exists, &settings)
            }
        })
    }

    /// Valide, applique et enregistre une mise à jour (`PUT /api/settings`).
    /// Une nouvelle clé va dans le trousseau, où elle doit être relue à
    /// l'identique ; sinon (aucun trousseau) dans le fichier, en 0600. Une clé
    /// effacée (champ vidé, ou adresse d'un autre serveur) sort du trousseau.
    pub fn update_settings(&self, input: &Value) -> Result<PublicSettings, String> {
        self.locked(|inner, cle_en_memoire| {
            let update = parse_update(input, false)?;
            let nouvelle_cle = update.llm_api_key.clone().filter(|cle| !cle.is_empty());
            let (_, current) = read_settings(&inner.settings_path);
            let mut next = apply_update(&current, update);
            if let Some(cle) = &nouvelle_cle {
                match ranger(inner.coffre.as_ref(), cle) {
                    Ok(()) => {
                        next.llm_api_key.clear();
                        next.cle_dans_le_trousseau = true;
                    }
                    Err(erreur) => logs::ecrire_masque(
                        logs::Niveau::Avertissement,
                        "réglages",
                        &format!(
                            "Trousseau indisponible ({erreur}) : repli sur le fichier de \
                             réglages, lisible par le seul compte."
                        ),
                        &[cle],
                    ),
                }
            }
            write_settings(&inner.settings_path, &next)
                .map_err(|error| format!("Enregistrement des réglages impossible : {error}"))?;
            // Le fichier ne renvoie plus à l'entrée du trousseau : elle est
            // retirée (clé effacée, ou nouvelle clé gardée dans le fichier).
            if current.cle_dans_le_trousseau && !next.cle_dans_le_trousseau {
                effacer(inner.coffre.as_ref());
            }
            if nouvelle_cle.is_some() && next.cle_dans_le_trousseau {
                logs::ecrire(
                    logs::Niveau::Info,
                    "réglages",
                    "Clé API rangée dans le trousseau du système.",
                );
            }
            // Clé en mémoire : la nouvelle si elle est au trousseau, aucune si
            // le fichier n'y renvoie plus ; sinon (clé inchangée) celle déjà lue.
            if nouvelle_cle.is_some() || !next.cle_dans_le_trousseau {
                *cle_en_memoire = nouvelle_cle.filter(|_| next.cle_dans_le_trousseau);
            }
            Ok(public_view(true, &next))
        })
    }

    /// Adresse et clé du modèle, pour le relais. `None` sans modèle configuré.
    /// La clé du trousseau n'est lue qu'ici, puis gardée en mémoire.
    pub fn upstream(&self) -> Option<Upstream> {
        self.locked(|inner, cle_en_memoire| {
            let (exists, settings) = read_settings(&inner.settings_path);
            if !exists || settings.llm_target.is_empty() {
                return None;
            }
            let api_key = if settings.llm_api_key.is_empty() && settings.cle_dans_le_trousseau {
                cle_du_trousseau(inner.coffre.as_ref(), cle_en_memoire)
            } else {
                settings.llm_api_key
            };
            Some(Upstream {
                target: settings.llm_target,
                api_key,
            })
        })
    }

    /// Clé déjà connue (fichier, ou trousseau déjà lu), sans interroger le
    /// trousseau : pour la masquer dans le journal technique.
    pub fn cle_connue(&self) -> String {
        self.locked(|inner, cle_en_memoire| {
            let (_, settings) = read_settings(&inner.settings_path);
            if settings.llm_api_key.is_empty() {
                cle_en_memoire.clone().unwrap_or_default()
            } else {
                settings.llm_api_key
            }
        })
    }

    /// Au démarrage : impose 0600 au fichier de réglages (Unix), puis déplace
    /// une clé en clair dans le trousseau. Elle n'est retirée du fichier
    /// qu'une fois relue à l'identique dans le trousseau ; sinon rien ne
    /// change, et la page affiche le repli. Un fichier illisible n'est pas
    /// touché.
    pub fn migrer_vers_le_trousseau(&self) {
        self.locked(|inner, cle_en_memoire| {
            let path = &inner.settings_path;
            let Some(update) = path.exists().then(|| parse_settings_file(path)).flatten() else {
                return;
            };
            imposer_droits_prives(path);
            let settings = apply_fields(&LlmSettings::default(), update);
            let cle = settings.llm_api_key.clone();
            if cle.is_empty() {
                return;
            }
            if let Err(erreur) = ranger(inner.coffre.as_ref(), &cle) {
                logs::ecrire_masque(
                    logs::Niveau::Info,
                    "réglages",
                    &format!(
                        "Trousseau indisponible ({erreur}) : repli sur le fichier, la clé API \
                         reste dans le fichier de réglages, lisible par le seul compte."
                    ),
                    &[&cle],
                );
                return;
            }
            let next = LlmSettings {
                llm_api_key: String::new(),
                cle_dans_le_trousseau: true,
                ..settings
            };
            match write_settings(path, &next) {
                Ok(()) => {
                    *cle_en_memoire = Some(cle);
                    logs::ecrire(
                        logs::Niveau::Info,
                        "réglages",
                        "Clé API déplacée dans le trousseau du système.",
                    );
                }
                Err(erreur) => logs::ecrire(
                    logs::Niveau::Avertissement,
                    "réglages",
                    &format!(
                        "Clé API copiée dans le trousseau, mais le fichier de réglages n'a pas \
                         pu être réécrit ({erreur}) : elle y reste jusqu'au prochain démarrage."
                    ),
                ),
            }
        })
    }

    /// Fichiers présents mais illisibles ou invalides (noms seuls, jamais leur
    /// contenu : `settings.json` porte la clé API). Les valeurs par défaut
    /// s'appliquent alors : `lib.rs` le note au démarrage dans le journal
    /// technique, pour le support, et la vue publique signale un
    /// `settings.json` illisible (`settings_unreadable`) pour que la page
    /// prévienne l'utilisateur.
    pub fn fichiers_illisibles(&self) -> Vec<&'static str> {
        self.locked(|inner, _| {
            let mut fichiers = Vec::new();
            if inner.settings_path.exists() && parse_settings_file(&inner.settings_path).is_none() {
                fichiers.push(SETTINGS_FILE);
            }
            if inner.words_path.exists() && parse_words_file(&inner.words_path).is_none() {
                fichiers.push(VALID_WORDS_FILE);
            }
            fichiers
        })
    }

    /// Mots valides enregistrés (`GET /api/valid-words`).
    pub fn valid_words(&self) -> Vec<String> {
        self.locked(|inner, _| read_words(&inner.words_path))
    }

    /// Ajoute un mot valide (`POST /api/valid-words`) et renvoie la liste.
    pub fn add_valid_word(&self, word: Option<&Value>) -> Result<Vec<String>, String> {
        let word = match word {
            Some(Value::String(word)) => js_trim(word),
            _ => "",
        };
        if word.is_empty() || utf16_len(word) > MAX_WORD_LENGTH || !word_pattern().is_match(word) {
            return Err("Invalid word".into());
        }
        self.locked(|inner, _| {
            let mut words = read_words(&inner.words_path);
            if !words.iter().any(|known| known == word) {
                words.push(word.to_string());
                write_words(&inner.words_path, &words).map_err(|_| "Failed to save word")?;
            }
            Ok(words)
        })
    }
}

fn public_view(exists: bool, settings: &LlmSettings) -> PublicSettings {
    PublicSettings {
        editable: true,
        configured: exists && !settings.llm_target.is_empty(),
        llm_target: settings.llm_target.clone(),
        llm_model_name: settings.llm_model_name.clone(),
        llm_disable_thinking: settings.llm_disable_thinking,
        has_api_key: settings.has_api_key(),
        settings_unreadable: false,
        api_key_storage: settings.api_key_storage(),
    }
}

/// Écrit `cle` dans le trousseau et la relit : réussi seulement si elle y est
/// à l'identique. Une entrée relue différente est retirée.
fn ranger(coffre: &dyn Coffre, cle: &str) -> Result<(), String> {
    coffre.ecrire(cle).map_err(|erreur| erreur.0)?;
    match coffre.lire().map_err(|erreur| erreur.0)? {
        Some(relue) if relue == cle => Ok(()),
        _ => {
            let _ = coffre.effacer();
            Err("la clé relue dans le trousseau diffère de la clé écrite".into())
        }
    }
}

/// Retire l'entrée du trousseau. Un échec est noté : le fichier n'y renvoie
/// plus, la clé ne sera plus lue ni envoyée.
fn effacer(coffre: &dyn Coffre) {
    match coffre.effacer() {
        Ok(()) => logs::ecrire(
            logs::Niveau::Info,
            "réglages",
            "Clé API retirée du trousseau du système.",
        ),
        Err(erreur) => logs::ecrire(
            logs::Niveau::Avertissement,
            "réglages",
            &format!(
                "La clé API n'a pas pu être retirée du trousseau ({erreur}) : elle n'est plus \
                 utilisée ; l'entrée « fr.willisback.grammaria » peut être supprimée depuis \
                 l'outil du système."
            ),
        ),
    }
}

/// Clé du trousseau, gardée en mémoire après la première lecture. Absente ou
/// illisible : chaîne vide (le modèle refusera la requête), et une ligne au
/// journal technique.
fn cle_du_trousseau(coffre: &dyn Coffre, cle_en_memoire: &mut Option<String>) -> String {
    if let Some(cle) = cle_en_memoire {
        return cle.clone();
    }
    let probleme = match coffre.lire() {
        Ok(Some(cle)) => {
            *cle_en_memoire = Some(cle.clone());
            return cle;
        }
        Ok(None) => "Clé API introuvable dans le trousseau du système : elle est à saisir à \
                     nouveau dans Paramètres → IA."
            .to_string(),
        Err(erreur) => {
            format!("Trousseau indisponible ({erreur}) : la clé API n'a pas pu être lue.")
        }
    };
    logs::commande_masquee(logs::Niveau::Avertissement, "trousseau", &probleme, &[]);
    String::new()
}

/// Lisible par le seul propriétaire (0600), au cas où le fichier aurait été
/// copié ou recréé avec des droits plus larges. Windows : les droits suivent
/// le dossier de données de l'utilisateur.
fn imposer_droits_prives(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let Ok(metadata) = fs::metadata(path) else {
            return;
        };
        if metadata.permissions().mode() & 0o777 != 0o600 {
            let message = match fs::set_permissions(path, fs::Permissions::from_mode(0o600)) {
                Ok(()) => format!("{SETTINGS_FILE} : droits ramenés à 0600."),
                Err(erreur) => format!("{SETTINGS_FILE} : droits non modifiables ({erreur})."),
            };
            logs::ecrire(logs::Niveau::Avertissement, "réglages", &message);
        }
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// Espace au sens de JavaScript (`String.prototype.trim`, `\s`) : WhiteSpace
/// et LineTerminator d'ECMAScript. Diffère de `char::is_whitespace` (U+0085
/// n'en est pas, U+FEFF en est).
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

fn js_trim(text: &str) -> &str {
    text.trim_matches(js_space)
}

/// Longueur JavaScript (`String.length`) : unités UTF-16.
fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `/^[\p{L}''\-\s]+$/u` de `server.ts` : lettres, apostrophe, trait d'union
/// et espaces (au sens de JavaScript).
fn word_pattern() -> &'static Regex {
    static PATTERN: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(
            r"^[\p{L}'\-\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]+$",
        )
        .expect("expression valide")
    })
}

/// Refus d'une adresse avec paramètres (`?…`, `#…`) ou identifiants
/// (`utilisateur:mot-de-passe@`) ; même message que `api/reglages.ts`.
pub const TARGET_EXTRAS_ERROR: &str =
    "L'adresse du modèle ne doit contenir ni paramètres ni identifiants.";

/// URL complète en http(s).
fn parse_target(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| {
        "L'adresse du modèle doit être une URL complète (http://… ou https://…).".to_string()
    })?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("L'adresse du modèle doit commencer par http:// ou https://.".into());
    }
    Ok(url)
}

/// Les chemins de l'API (`/v1/…`) sont ajoutés à l'adresse : une requête ou
/// un fragment les casserait, et des identifiants partiraient en clair avec
/// chaque requête (la clé API a son propre champ). Une requête vide (`?` seul)
/// compte aussi, comme dans `normalizeTarget`.
fn check_extras(url: &Url) -> Result<(), String> {
    if url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(TARGET_EXTRAS_ERROR.into());
    }
    Ok(())
}

/// Sans « /v1 » final ni barre oblique.
fn strip_root(url: &Url) -> String {
    let href = url.as_str().trim_end_matches('/');
    href.strip_suffix("/v1").unwrap_or(href).to_string()
}

/// Adresse racine du serveur du modèle : http(s), sans « /v1 » final ni barre
/// oblique, sans paramètres ni identifiants (`normalizeTarget` de
/// `api/reglages.ts`, même analyse WHATWG, mêmes messages).
pub fn normalize_target(value: &str) -> Result<String, String> {
    let url = parse_target(value)?;
    check_extras(&url)?;
    Ok(strip_root(&url))
}

/// Adresse lue dans un `settings.json` existant : les règles d'avant (http(s),
/// normalisation). Une adresse avec paramètres ou identifiants, admise par une
/// version antérieure, est gardée telle quelle pour que le fichier reste lisible
/// (modèle, réglages) ; `endpoint` la refuse à la première requête, avec le
/// message de `TARGET_EXTRAS_ERROR`, et l'utilisateur la corrige dans les réglages.
fn normalize_stored_target(value: &str) -> Result<String, String> {
    parse_target(value).map(|url| strip_root(&url))
}

/// URL d'un chemin de l'API sous l'adresse du modèle, par jointure de segments
/// (`https://hôte/openai` + `["v1", "models"]` → `https://hôte/openai/v1/models`).
pub fn endpoint(target: &str, segments: &[&str]) -> Result<Url, String> {
    let mut url = parse_target(target)?;
    check_extras(&url)?;
    url.path_segments_mut()
        .map_err(|()| TARGET_EXTRAS_ERROR.to_string())?
        .pop_if_empty()
        .extend(segments);
    Ok(url)
}

/// Origine (schéma, hôte, port) d'une adresse enregistrée.
fn origin(target: &str) -> Option<url::Origin> {
    Url::parse(target).ok().map(|url| url.origin())
}

/// Champs d'une mise à jour ou d'un fichier (`parseUpdate` de `settings.ts`).
/// `from_file` : une adresse vide est admise (fichier écrit sans modèle).
fn parse_update(input: &Value, from_file: bool) -> Result<SettingsUpdate, String> {
    let empty = Map::new();
    let raw = match input {
        Value::Object(object) => object,
        // `typeof [] === "object"` : un tableau ne contient aucun réglage.
        Value::Array(_) => &empty,
        _ => return Err("Réglages invalides.".into()),
    };
    let text = |key: &str| -> Result<Option<String>, String> {
        match raw.get(key) {
            None => Ok(None),
            Some(Value::String(value)) if utf16_len(value) <= MAX_FIELD_LENGTH => {
                Ok(Some(js_trim(value).to_string()))
            }
            Some(_) => Err(format!("Réglage invalide : {key}.")),
        }
    };
    let mut update = SettingsUpdate::default();
    if let Some(target) = text("llmTarget")? {
        update.llm_target = Some(if !from_file {
            normalize_target(&target)?
        } else if target.is_empty() {
            target
        } else {
            normalize_stored_target(&target)?
        });
    }
    update.llm_api_key = text("llmApiKey")?;
    update.llm_model_name = text("llmModelName")?;
    if from_file {
        update.cle_dans_le_trousseau = Some(raw.get(KEYRING_FLAG) == Some(&Value::Bool(true)));
    }
    match raw.get("llmDisableThinking") {
        None => {}
        Some(Value::Bool(flag)) => update.llm_disable_thinking = Some(*flag),
        Some(_) => return Err("Réglage invalide : llmDisableThinking.".into()),
    }
    Ok(update)
}

/// `(raw.settingsVersion ?? 1) < SETTINGS_VERSION`, avec la conversion de
/// JavaScript pour les valeurs inattendues.
fn older_than_current(version: Option<&Value>) -> bool {
    let current = f64::from(SETTINGS_VERSION);
    match version {
        None | Some(Value::Null) => 1.0 < current,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|v| v < current),
        Some(Value::Bool(flag)) => f64::from(u8::from(*flag)) < current,
        Some(Value::String(text)) => {
            let text = js_trim(text);
            let number = if text.is_empty() {
                Some(0.0)
            } else {
                text.parse::<f64>().ok()
            };
            number.is_some_and(|v| v < current)
        }
        Some(_) => false,
    }
}

/// Contenu valide de `settings.json`, s'il est lisible : `None` pour un
/// fichier illisible, qui n'est pas du JSON ou dont un réglage est invalide.
fn parse_settings_file(path: &Path) -> Option<SettingsUpdate> {
    let mut raw = fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())?;
    if let Value::Object(object) = &mut raw {
        if older_than_current(object.get("settingsVersion")) {
            object.remove("llmDisableThinking");
        }
    }
    parse_update(&raw, true).ok()
}

/// Lit `settings.json` : (fichier présent, réglages). Un fichier illisible ou
/// invalide donne les valeurs par défaut, comme `settings.ts`.
fn read_settings(path: &Path) -> (bool, LlmSettings) {
    let (exists, _, settings) = read_settings_state(path);
    (exists, settings)
}

/// Comme `read_settings`, avec en plus l'état « fichier présent mais
/// illisible » : (fichier présent, illisible, réglages).
fn read_settings_state(path: &Path) -> (bool, bool, LlmSettings) {
    let defaults = LlmSettings::default();
    if !path.exists() {
        return (false, false, defaults);
    }
    match parse_settings_file(path) {
        Some(update) => (true, false, apply_fields(&defaults, update)),
        None => (true, true, defaults),
    }
}

fn apply_fields(current: &LlmSettings, update: SettingsUpdate) -> LlmSettings {
    LlmSettings {
        llm_target: update
            .llm_target
            .unwrap_or_else(|| current.llm_target.clone()),
        llm_api_key: update
            .llm_api_key
            .unwrap_or_else(|| current.llm_api_key.clone()),
        llm_model_name: update
            .llm_model_name
            .unwrap_or_else(|| current.llm_model_name.clone()),
        llm_disable_thinking: update
            .llm_disable_thinking
            .unwrap_or(current.llm_disable_thinking),
        cle_dans_le_trousseau: update
            .cle_dans_le_trousseau
            .unwrap_or(current.cle_dans_le_trousseau),
    }
}

/// Mise à jour venue de la page. Décision du PO : si l'adresse change de
/// serveur et qu'aucune clé n'est fournie, la clé enregistrée est effacée.
/// Une clé fournie est ici une clé du fichier : `update_settings` la range
/// ensuite dans le trousseau, s'il est disponible.
fn apply_update(current: &LlmSettings, update: SettingsUpdate) -> LlmSettings {
    let key_given = update.llm_api_key.is_some();
    let mut next = apply_fields(current, update);
    if key_given || origin(&next.llm_target) != origin(&current.llm_target) {
        next.cle_dans_le_trousseau = false;
    }
    if !key_given && origin(&next.llm_target) != origin(&current.llm_target) {
        next.llm_api_key.clear();
    }
    next
}

/// Écriture atomique : fichier temporaire (`<nom>.tmp`, comme le serveur),
/// puis renommage. `private` : lisible par le seul propriétaire (0600).
pub(crate) fn write_atomic(path: &Path, content: &str, private: bool) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let mut tmp_name = path.as_os_str().to_owned();
    tmp_name.push(".tmp");
    let tmp = PathBuf::from(tmp_name);
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    if private {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    {
        let mut file = options.open(&tmp)?;
        // Un fichier temporaire laissé par un arrêt brutal garde ses droits :
        // on les resserre avant d'y écrire la clé.
        #[cfg(unix)]
        if private {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o600))?;
        }
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    // Windows : les droits suivent le dossier de données de l'utilisateur.
    #[cfg(unix)]
    if private {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

/// `JSON.stringify(valeur, null, 2)` suivi d'un saut de ligne.
fn pretty_json(value: &impl Serialize) -> String {
    let mut text = serde_json::to_string_pretty(value).expect("JSON sérialisable");
    text.push('\n');
    text
}

fn write_settings(path: &Path, settings: &LlmSettings) -> std::io::Result<()> {
    let content = pretty_json(&SettingsFile {
        settings_version: SETTINGS_VERSION,
        llm_target: &settings.llm_target,
        llm_api_key: &settings.llm_api_key,
        llm_model_name: &settings.llm_model_name,
        llm_disable_thinking: settings.llm_disable_thinking,
        llm_api_key_in_keyring: settings.cle_dans_le_trousseau,
    });
    write_atomic(path, &content, true)
}

/// Mots de `{ "words": [...] }` ; `None` pour un fichier absent, illisible ou
/// d'une autre forme.
fn parse_words_file(path: &Path) -> Option<Vec<String>> {
    let raw = fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())?;
    match raw.get("words") {
        Some(Value::Array(words)) => Some(
            words
                .iter()
                .filter_map(|word| word.as_str().map(str::to_owned))
                .collect(),
        ),
        _ => None,
    }
}

/// `{ "words": [...] }` ; fichier absent ou invalide : liste vide.
fn read_words(path: &Path) -> Vec<String> {
    parse_words_file(path).unwrap_or_default()
}

fn write_words(path: &Path, words: &[String]) -> std::io::Result<()> {
    #[derive(Serialize)]
    struct WordsFile<'a> {
        words: &'a [String],
    }
    write_atomic(path, &pretty_json(&WordsFile { words }), false)
}

/// Réglages du modèle, sans la clé (seulement `hasApiKey` et `apiKeyStorage`).
#[tauri::command]
pub async fn settings_get(store: State<'_, Store>) -> Result<PublicSettings, String> {
    Ok(store.settings())
}

/// Enregistre les réglages ; erreur lisible (en français) si invalides.
#[tauri::command]
pub async fn settings_set(
    store: State<'_, Store>,
    update: Value,
) -> Result<PublicSettings, String> {
    store
        .update_settings(&update)
        .inspect_err(|error| logs::echec_commande("settings_set", error))
}

/// Liste des mots valides.
#[tauri::command]
pub async fn valid_words_get(store: State<'_, Store>) -> Result<Vec<String>, String> {
    Ok(store.valid_words())
}

/// Ajoute un mot valide ; « Invalid word » s'il ne passe pas la validation.
#[tauri::command]
pub async fn valid_words_add(
    store: State<'_, Store>,
    word: Option<Value>,
) -> Result<Vec<String>, String> {
    store
        .add_valid_word(word.as_ref())
        .inspect_err(|error| logs::echec_commande("valid_words_add", error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trousseau::memoire::Memoire;
    use serde_json::json;

    struct Banc {
        dir: tempfile::TempDir,
        store: Store,
        coffre: Arc<Memoire>,
    }

    fn banc_avec(coffre: Memoire) -> Banc {
        let dir = tempfile::tempdir().expect("dossier temporaire");
        let coffre = Arc::new(coffre);
        let store = Store::new(dir.path(), Box::new(coffre.clone()));
        Banc { dir, store, coffre }
    }

    /// Sans trousseau (repli) : la clé est gardée dans le fichier. C'est le
    /// cas des tests du format du fichier et des validations, plus bas.
    fn banc() -> Banc {
        banc_avec(Memoire::indisponible())
    }

    /// Avec un trousseau disponible.
    fn banc_trousseau() -> Banc {
        banc_avec(Memoire::default())
    }

    impl Banc {
        fn octets(&self) -> Vec<u8> {
            fs::read(self.settings_path()).unwrap()
        }

        fn contient(&self, secret: &str) -> bool {
            self.octets()
                .windows(secret.len())
                .any(|fenetre| fenetre == secret.as_bytes())
        }

        #[cfg(unix)]
        fn mode(&self) -> u32 {
            use std::os::unix::fs::PermissionsExt;
            fs::metadata(self.settings_path())
                .unwrap()
                .permissions()
                .mode()
                & 0o777
        }

        fn settings_path(&self) -> PathBuf {
            self.dir.path().join(SETTINGS_FILE)
        }

        fn write_settings(&self, value: Value) {
            fs::write(self.settings_path(), value.to_string()).unwrap();
        }

        fn file(&self) -> Value {
            serde_json::from_str(&fs::read_to_string(self.settings_path()).unwrap()).unwrap()
        }

        fn key(&self) -> String {
            self.file()["llmApiKey"].as_str().unwrap().to_string()
        }
    }

    #[test]
    fn sans_fichier_aucun_modele_n_est_configure() {
        let banc = banc();
        assert_eq!(
            serde_json::to_value(banc.store.settings()).unwrap(),
            json!({
                "editable": true,
                "configured": false,
                "llmTarget": "",
                "llmModelName": "",
                "llmDisableThinking": true,
                "hasApiKey": false,
                "apiKeyStorage": "aucune",
            })
        );
        assert!(banc.store.upstream().is_none());
    }

    #[test]
    fn un_fichier_v1_est_relu_sans_son_choix_de_raisonnement() {
        let banc = banc();
        banc.write_settings(json!({
            "llmTarget": "https://albert.exemple.fr",
            "llmApiKey": "sk-secrete",
            "llmModelName": "modele",
            "llmDisableThinking": false,
        }));
        let settings = banc.store.settings();
        assert!(settings.configured);
        assert_eq!(settings.llm_target, "https://albert.exemple.fr");
        assert_eq!(settings.llm_model_name, "modele");
        assert!(settings.has_api_key);
        // v1 : la valeur n'avait pas été choisie, le défaut (coupé) s'applique.
        assert!(settings.llm_disable_thinking);
    }

    #[test]
    fn un_fichier_v2_est_relu_tel_quel() {
        let banc = banc();
        banc.write_settings(json!({
            "settingsVersion": 2,
            "llmTarget": "http://127.0.0.1:8000",
            "llmApiKey": "",
            "llmModelName": "",
            "llmDisableThinking": false,
        }));
        let settings = banc.store.settings();
        assert_eq!(settings.llm_target, "http://127.0.0.1:8000");
        assert!(!settings.has_api_key);
        assert!(!settings.llm_disable_thinking);
        let upstream = banc.store.upstream().unwrap();
        assert_eq!(upstream.target, "http://127.0.0.1:8000");
        assert_eq!(upstream.api_key, "");
    }

    #[test]
    fn un_fichier_invalide_donne_les_valeurs_par_defaut() {
        let banc = banc();
        for contenu in [
            "pas du json",
            r#"{"settingsVersion":2,"llmTarget":"ftp://x","llmModelName":"m"}"#,
            r#"{"settingsVersion":2,"llmTarget":"http://x","llmModelName":3}"#,
            r#"{"settingsVersion":2,"llmTarget":"http://x","llmDisableThinking":"non"}"#,
            "42",
        ] {
            fs::write(banc.settings_path(), contenu).unwrap();
            let settings = banc.store.settings();
            assert_eq!(settings.llm_target, "", "{contenu}");
            assert_eq!(settings.llm_model_name, "", "{contenu}");
            assert!(!settings.configured, "{contenu}");
        }
    }

    #[test]
    fn un_fichier_de_reglages_illisible_est_signale_jusqu_au_prochain_enregistrement() {
        let banc = banc();
        // Absent (premier lancement) ou valide : rien à signaler, champ absent du JSON.
        assert!(!banc.store.settings().settings_unreadable);
        assert!(serde_json::to_value(banc.store.settings())
            .unwrap()
            .get("settingsUnreadable")
            .is_none());
        banc.write_settings(json!({"settingsVersion": 2, "llmTarget": "http://127.0.0.1:8000"}));
        assert!(!banc.store.settings().settings_unreadable);

        // Tronqué : réglages et clé ignorés, et la page en est prévenue.
        fs::write(
            banc.settings_path(),
            r#"{"settingsVersion":2,"llmApiKey":"sk-secret","llmTar"#,
        )
        .unwrap();
        let vue = banc.store.settings();
        assert!(vue.settings_unreadable);
        assert!(!vue.configured);
        assert!(!vue.has_api_key);
        let json = serde_json::to_value(&vue).unwrap();
        assert_eq!(json["settingsUnreadable"], json!(true));
        assert!(!json.to_string().contains("sk-secret"));

        // Un enregistrement réussi réécrit le fichier : l'avertissement disparaît.
        let enregistre = banc
            .store
            .update_settings(&json!({"llmTarget": "http://127.0.0.1:8000"}))
            .unwrap();
        assert!(!enregistre.settings_unreadable);
        assert!(!banc.store.settings().settings_unreadable);
        assert!(banc.store.settings().configured);
    }

    #[test]
    fn les_fichiers_illisibles_sont_signales_par_leur_nom() {
        let banc = banc();
        let words_path = banc.dir.path().join(VALID_WORDS_FILE);
        // Absents : rien à signaler (premier lancement).
        assert!(banc.store.fichiers_illisibles().is_empty());
        // Valides : rien à signaler.
        banc.write_settings(json!({"settingsVersion": 2, "llmTarget": "http://127.0.0.1:8000"}));
        fs::write(&words_path, r#"{"words":["Grammaria"]}"#).unwrap();
        assert!(banc.store.fichiers_illisibles().is_empty());
        // Tronqués (écriture interrompue, disque plein) ou d'une autre forme.
        fs::write(
            banc.settings_path(),
            r#"{"settingsVersion":2,"llmApiKey":"sk-secret","llmTar"#,
        )
        .unwrap();
        assert_eq!(banc.store.fichiers_illisibles(), [SETTINGS_FILE]);
        fs::write(&words_path, r#"{"words": ["Gramm"#).unwrap();
        assert_eq!(
            banc.store.fichiers_illisibles(),
            [SETTINGS_FILE, VALID_WORDS_FILE]
        );
        fs::write(&words_path, r#"["Grammaria"]"#).unwrap();
        banc.write_settings(json!({"settingsVersion": 2, "llmTarget": "ftp://x"}));
        assert_eq!(
            banc.store.fichiers_illisibles(),
            [SETTINGS_FILE, VALID_WORDS_FILE]
        );
        // Signaler ne modifie rien : le fichier reste tel quel.
        assert_eq!(fs::read_to_string(&words_path).unwrap(), r#"["Grammaria"]"#);
    }

    #[test]
    fn l_ecriture_suit_le_format_du_serveur_en_0600() {
        let banc = banc();
        let view = banc
            .store
            .update_settings(&json!({
                "llmTarget": "  https://api.exemple.fr/v1/  ",
                "llmApiKey": " sk-secrete ",
                "llmDisableThinking": false,
            }))
            .unwrap();
        assert_eq!(
            serde_json::to_value(&view).unwrap(),
            json!({
                "editable": true,
                "configured": true,
                "llmTarget": "https://api.exemple.fr",
                "llmModelName": "",
                "llmDisableThinking": false,
                "hasApiKey": true,
                "apiKeyStorage": "fichier",
            })
        );
        // Repli sans trousseau : octet pour octet ce qu'écrit settings.ts
        // (JSON.stringify(…, null, 2)).
        assert_eq!(
            fs::read_to_string(banc.settings_path()).unwrap(),
            "{\n  \"settingsVersion\": 2,\n  \"llmTarget\": \"https://api.exemple.fr\",\n  \"llmApiKey\": \"sk-secrete\",\n  \"llmModelName\": \"\",\n  \"llmDisableThinking\": false\n}\n"
        );
        assert!(!banc.dir.path().join("settings.json.tmp").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(banc.settings_path())
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn un_fichier_temporaire_ancien_ne_garde_pas_ses_droits() {
        let banc = banc();
        let tmp = banc.dir.path().join("settings.json.tmp");
        fs::write(&tmp, "reste").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&tmp, fs::Permissions::from_mode(0o644)).unwrap();
        }
        banc.store
            .update_settings(&json!({ "llmTarget": "http://x", "llmApiKey": "k" }))
            .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(banc.settings_path())
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn la_cle_n_est_jamais_renvoyee() {
        let banc = banc();
        let view = banc
            .store
            .update_settings(&json!({ "llmTarget": "http://x", "llmApiKey": "sk-tres-secrete" }))
            .unwrap();
        for texte in [
            serde_json::to_string(&view).unwrap(),
            serde_json::to_string(&banc.store.settings()).unwrap(),
            format!("{:?}", banc.store.upstream().unwrap()),
            format!("{:?}", read_settings(&banc.settings_path()).1),
        ] {
            assert!(!texte.contains("sk-tres-secrete"), "{texte}");
            assert!(!texte.contains("llmApiKey"), "{texte}");
        }
        assert!(view.has_api_key);
        // Absente de la mise à jour : conservée. Chaîne vide : effacée.
        banc.store
            .update_settings(&json!({ "llmModelName": "m" }))
            .unwrap();
        assert_eq!(banc.key(), "sk-tres-secrete");
        let view = banc
            .store
            .update_settings(&json!({ "llmApiKey": "" }))
            .unwrap();
        assert!(!view.has_api_key);
        assert_eq!(banc.key(), "");
    }

    #[test]
    fn la_cle_est_effacee_quand_le_serveur_change() {
        let banc = banc();
        banc.store
            .update_settings(
                &json!({ "llmTarget": "https://a.exemple.fr/v1", "llmApiKey": "cle-a" }),
            )
            .unwrap();

        // Même serveur (chemin différent) : la clé reste.
        let view = banc
            .store
            .update_settings(&json!({ "llmTarget": "https://a.exemple.fr/proxy" }))
            .unwrap();
        assert!(view.has_api_key);
        assert_eq!(banc.key(), "cle-a");

        // Autre hôte sans nouvelle clé : effacée, jamais envoyée à b.
        let view = banc
            .store
            .update_settings(&json!({ "llmTarget": "https://b.exemple.fr" }))
            .unwrap();
        assert!(!view.has_api_key);
        assert_eq!(banc.key(), "");
        assert_eq!(banc.store.upstream().unwrap().api_key, "");

        // Autre hôte avec sa clé : la nouvelle clé est retenue.
        banc.store
            .update_settings(&json!({ "llmTarget": "https://c.exemple.fr", "llmApiKey": "cle-c" }))
            .unwrap();
        assert_eq!(banc.key(), "cle-c");

        // Même hôte, autre port ou autre schéma : autre serveur, clé effacée.
        for target in ["https://c.exemple.fr:8443", "http://c.exemple.fr"] {
            banc.store
                .update_settings(
                    &json!({ "llmTarget": "https://c.exemple.fr", "llmApiKey": "cle-c" }),
                )
                .unwrap();
            let view = banc
                .store
                .update_settings(&json!({ "llmTarget": target }))
                .unwrap();
            assert!(!view.has_api_key, "{target}");
        }
        // Le port par défaut écrit en clair ne change pas de serveur.
        banc.store
            .update_settings(&json!({ "llmTarget": "https://c.exemple.fr", "llmApiKey": "cle-c" }))
            .unwrap();
        let view = banc
            .store
            .update_settings(&json!({ "llmTarget": "https://C.exemple.fr:443/" }))
            .unwrap();
        assert!(view.has_api_key);
    }

    #[test]
    fn les_reglages_invalides_sont_refuses_avec_le_message_du_serveur() {
        let banc = banc();
        let cas = [
            (json!(null), "Réglages invalides."),
            (json!("x"), "Réglages invalides."),
            (
                json!({ "llmTarget": null }),
                "Réglage invalide : llmTarget.",
            ),
            (
                json!({ "llmTarget": "" }),
                "L'adresse du modèle doit être une URL complète (http://… ou https://…).",
            ),
            (
                json!({ "llmTarget": "localhost:8000" }),
                "L'adresse du modèle doit commencer par http:// ou https://.",
            ),
            (
                json!({ "llmTarget": "ftp://exemple.fr" }),
                "L'adresse du modèle doit commencer par http:// ou https://.",
            ),
            (json!({ "llmApiKey": 3 }), "Réglage invalide : llmApiKey."),
            (
                json!({ "llmModelName": "m".repeat(2_001) }),
                "Réglage invalide : llmModelName.",
            ),
            (
                json!({ "llmDisableThinking": "true" }),
                "Réglage invalide : llmDisableThinking.",
            ),
        ];
        for (input, message) in cas {
            assert_eq!(
                banc.store.update_settings(&input).unwrap_err(),
                message,
                "{input}"
            );
        }
        assert!(!banc.settings_path().exists());
        // 2 000 unités UTF-16 exactement : accepté ; 1 001 emojis (2 002) : refusé.
        banc.store
            .update_settings(&json!({ "llmModelName": "m".repeat(2_000) }))
            .unwrap();
        assert!(banc
            .store
            .update_settings(&json!({ "llmModelName": "😀".repeat(1_001) }))
            .is_err());
    }

    #[test]
    fn l_adresse_est_normalisee_comme_dans_settings_ts() {
        for (entree, attendu) in [
            ("http://127.0.0.1:30000", "http://127.0.0.1:30000"),
            ("http://127.0.0.1:30000/", "http://127.0.0.1:30000"),
            ("http://127.0.0.1:30000/v1", "http://127.0.0.1:30000"),
            ("https://api.exemple.fr/v1/", "https://api.exemple.fr"),
            ("https://api.exemple.fr/v1//", "https://api.exemple.fr"),
            (
                "https://api.exemple.fr/openai/v1",
                "https://api.exemple.fr/openai",
            ),
            ("https://api.exemple.fr/v1/v1", "https://api.exemple.fr/v1"),
            ("HTTPS://API.Exemple.FR:443/v1", "https://api.exemple.fr"),
            ("http://exemple.fr:80", "http://exemple.fr"),
        ] {
            assert_eq!(normalize_target(entree).unwrap(), attendu, "{entree}");
        }
    }

    /// Mêmes cas que `normalizeTarget` dans `tests/unit/settings.test.ts`.
    #[test]
    fn les_parametres_et_identifiants_sont_refuses() {
        for entree in [
            "http://moi:secret@exemple.fr",
            "http://moi@exemple.fr/v1",
            "http://:secret@exemple.fr",
            "https://api.exemple.fr/v1?cle=1",
            "https://api.exemple.fr/?",
            "https://api.exemple.fr/v1#ancre",
            "https://api.exemple.fr#",
        ] {
            assert_eq!(
                normalize_target(entree).unwrap_err(),
                TARGET_EXTRAS_ERROR,
                "{entree}"
            );
        }
        assert_eq!(
            TARGET_EXTRAS_ERROR,
            "L'adresse du modèle ne doit contenir ni paramètres ni identifiants."
        );
        let banc = banc();
        assert_eq!(
            banc.store
                .update_settings(&json!({ "llmTarget": "https://a:b@exemple.fr" }))
                .unwrap_err(),
            TARGET_EXTRAS_ERROR
        );
        assert!(!banc.settings_path().exists());
    }

    #[test]
    fn les_chemins_de_l_api_sont_joints_a_l_adresse() {
        for (cible, attendu) in [
            ("http://127.0.0.1:8000", "http://127.0.0.1:8000/v1/models"),
            (
                "https://api.exemple.fr/openai",
                "https://api.exemple.fr/openai/v1/models",
            ),
            (
                "https://api.exemple.fr/openai/",
                "https://api.exemple.fr/openai/v1/models",
            ),
        ] {
            assert_eq!(
                endpoint(cible, &["v1", "models"]).unwrap().as_str(),
                attendu
            );
        }
        assert_eq!(
            endpoint("https://exemple.fr/?x=1", &["v1"]).unwrap_err(),
            TARGET_EXTRAS_ERROR
        );
    }

    /// Un fichier écrit par une version qui acceptait ces adresses reste
    /// lisible ; l'erreur apparaît à la première requête du modèle.
    #[test]
    fn un_fichier_ancien_avec_identifiants_reste_lisible() {
        let banc = banc();
        banc.write_settings(json!({
            "settingsVersion": 2,
            "llmTarget": "https://moi:secret@api.exemple.fr/v1?version=2",
            "llmApiKey": "k",
            "llmModelName": "modele",
            "llmDisableThinking": false,
        }));
        let settings = banc.store.settings();
        assert!(settings.configured);
        assert_eq!(settings.llm_model_name, "modele");
        assert!(!settings.llm_disable_thinking);
        let upstream = banc.store.upstream().unwrap();
        assert_eq!(
            endpoint(&upstream.target, &["v1", "models"]).unwrap_err(),
            TARGET_EXTRAS_ERROR
        );
    }

    #[test]
    fn les_mots_valides_gardent_le_format_et_les_validations() {
        let banc = banc();
        assert!(banc.store.valid_words().is_empty());
        let words = banc
            .store
            .add_valid_word(Some(&json!("  aujourd'hui ")))
            .unwrap();
        assert_eq!(words, ["aujourd'hui"]);
        banc.store
            .add_valid_word(Some(&json!("Grammaria")))
            .unwrap();
        // Doublon : pas ajouté deux fois.
        let words = banc
            .store
            .add_valid_word(Some(&json!("Grammaria")))
            .unwrap();
        assert_eq!(words, ["aujourd'hui", "Grammaria"]);
        assert_eq!(
            fs::read_to_string(banc.dir.path().join(VALID_WORDS_FILE)).unwrap(),
            "{\n  \"words\": [\n    \"aujourd'hui\",\n    \"Grammaria\"\n  ]\n}\n"
        );
        assert_eq!(banc.store.valid_words(), ["aujourd'hui", "Grammaria"]);
        banc.store
            .add_valid_word(Some(&json!("porte-monnaie à\u{A0}clé")))
            .unwrap();

        for invalide in [
            json!(""),
            json!("   "),
            json!("mot2"),
            json!("a.b"),
            json!("<script>"),
            json!("m".repeat(101)),
            json!(3),
            Value::Null,
        ] {
            assert_eq!(
                banc.store.add_valid_word(Some(&invalide)).unwrap_err(),
                "Invalid word",
                "{invalide}"
            );
        }
        assert_eq!(banc.store.add_valid_word(None).unwrap_err(), "Invalid word");
        banc.store
            .add_valid_word(Some(&json!("m".repeat(100))))
            .unwrap();
    }

    #[test]
    fn un_fichier_de_mots_existant_est_repris() {
        let banc = banc();
        let path = banc.dir.path().join(VALID_WORDS_FILE);
        fs::write(&path, r#"{"words":["déjà","là"]}"#).unwrap();
        assert_eq!(banc.store.valid_words(), ["déjà", "là"]);
        fs::write(&path, "illisible").unwrap();
        assert!(banc.store.valid_words().is_empty());
    }

    // ─────────────────────────── Trousseau ───────────────────────────

    const SENTINELLE: &str = "sk-sentinelle-trousseau-7f3a";

    /// Fichier d'une version précédente : la clé y est en clair.
    fn fichier_ancien(banc: &Banc) {
        banc.write_settings(json!({
            "settingsVersion": 2,
            "llmTarget": "https://api.exemple.fr",
            "llmApiKey": SENTINELLE,
            "llmModelName": "modele",
            "llmDisableThinking": false,
        }));
    }

    #[test]
    fn avec_trousseau_le_fichier_ne_contient_pas_la_cle() {
        let banc = banc_trousseau();
        let vue = banc
            .store
            .update_settings(
                &json!({ "llmTarget": "https://api.exemple.fr", "llmApiKey": SENTINELLE }),
            )
            .unwrap();
        assert!(vue.has_api_key);
        assert_eq!(vue.api_key_storage, "trousseau");
        assert_eq!(banc.coffre.contenu().as_deref(), Some(SENTINELLE));
        assert!(!banc.contient(SENTINELLE));
        assert_eq!(
            fs::read_to_string(banc.settings_path()).unwrap(),
            "{\n  \"settingsVersion\": 2,\n  \"llmTarget\": \"https://api.exemple.fr\",\n  \"llmApiKey\": \"\",\n  \"llmModelName\": \"\",\n  \"llmDisableThinking\": true,\n  \"llmApiKeyInKeyring\": true\n}\n"
        );
        assert_eq!(banc.store.settings().api_key_storage, "trousseau");
        assert_eq!(banc.store.upstream().unwrap().api_key, SENTINELLE);
        assert_eq!(banc.store.cle_connue(), SENTINELLE);

        // Autre exécution (cache vide) : la clé est relue dans le trousseau.
        let relance = Store::new(banc.dir.path(), Box::new(banc.coffre.clone()));
        assert_eq!(relance.cle_connue(), "");
        assert_eq!(relance.upstream().unwrap().api_key, SENTINELLE);
        assert_eq!(relance.cle_connue(), SENTINELLE);

        // Un autre réglage enregistré garde la clé dans le trousseau.
        banc.store
            .update_settings(&json!({ "llmModelName": "m" }))
            .unwrap();
        assert_eq!(banc.store.settings().api_key_storage, "trousseau");
        assert_eq!(banc.coffre.contenu().as_deref(), Some(SENTINELLE));
        assert!(!banc.contient(SENTINELLE));
    }

    #[test]
    fn settings_get_ne_renvoie_jamais_la_cle() {
        for banc in [banc(), banc_trousseau()] {
            let vue = banc
                .store
                .update_settings(&json!({ "llmTarget": "http://x", "llmApiKey": SENTINELLE }))
                .unwrap();
            for texte in [
                serde_json::to_string(&vue).unwrap(),
                serde_json::to_string(&banc.store.settings()).unwrap(),
                format!("{:?}", banc.store.upstream().unwrap()),
                format!("{:?}", read_settings(&banc.settings_path()).1),
            ] {
                assert!(!texte.contains(SENTINELLE), "{texte}");
                assert!(!texte.contains("llmApiKey"), "{texte}");
            }
        }
    }

    #[test]
    fn une_cle_en_clair_est_deplacee_dans_le_trousseau() {
        let banc = banc_trousseau();
        fichier_ancien(&banc);
        assert_eq!(banc.store.settings().api_key_storage, "fichier");
        banc.store.migrer_vers_le_trousseau();

        assert_eq!(banc.coffre.contenu().as_deref(), Some(SENTINELLE));
        assert!(!banc.contient(SENTINELLE), "clé encore dans le fichier");
        assert!(!banc.dir.path().join("settings.json.tmp").exists());
        let fichier = banc.file();
        assert_eq!(fichier["llmApiKeyInKeyring"], json!(true));
        assert_eq!(fichier["llmApiKey"], json!(""));
        // Le reste des réglages est repris tel quel.
        assert_eq!(fichier["llmTarget"], json!("https://api.exemple.fr"));
        assert_eq!(fichier["llmModelName"], json!("modele"));
        assert_eq!(fichier["llmDisableThinking"], json!(false));
        #[cfg(unix)]
        assert_eq!(banc.mode(), 0o600);
        let vue = banc.store.settings();
        assert!(vue.has_api_key);
        assert_eq!(vue.api_key_storage, "trousseau");
        assert_eq!(banc.store.upstream().unwrap().api_key, SENTINELLE);

        // Une seconde fois : rien à faire, rien ne change.
        let avant = banc.octets();
        banc.store.migrer_vers_le_trousseau();
        assert_eq!(banc.octets(), avant);
    }

    #[test]
    fn sans_trousseau_la_migration_ne_perd_rien() {
        for coffre in [
            Memoire::indisponible(),
            Memoire {
                relecture_fausse: true,
                ..Memoire::default()
            },
        ] {
            let banc = banc_avec(coffre);
            fichier_ancien(&banc);
            let avant = banc.octets();
            banc.store.migrer_vers_le_trousseau();
            assert_eq!(banc.octets(), avant, "fichier modifié");
            // Relecture fausse : l'entrée douteuse est retirée du trousseau.
            assert_eq!(banc.coffre.contenu(), None);
            let vue = banc.store.settings();
            assert!(vue.has_api_key);
            assert_eq!(vue.api_key_storage, "fichier");
            assert_eq!(banc.store.upstream().unwrap().api_key, SENTINELLE);
        }
    }

    #[test]
    fn sans_trousseau_la_cle_reste_dans_un_fichier_en_0600() {
        let banc = banc();
        let vue = banc
            .store
            .update_settings(&json!({ "llmTarget": "http://x", "llmApiKey": SENTINELLE }))
            .unwrap();
        assert_eq!(vue.api_key_storage, "fichier");
        assert!(banc.contient(SENTINELLE));
        assert!(banc.file().get("llmApiKeyInKeyring").is_none());
        #[cfg(unix)]
        assert_eq!(banc.mode(), 0o600);
        assert_eq!(banc.store.upstream().unwrap().api_key, SENTINELLE);
        assert_eq!(banc.store.cle_connue(), SENTINELLE);

        // Un fichier élargi à la main (0644) est ramené à 0600 au démarrage.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(banc.settings_path(), fs::Permissions::from_mode(0o644)).unwrap();
            banc.store.migrer_vers_le_trousseau();
            assert_eq!(banc.mode(), 0o600);
        }
        assert!(banc.contient(SENTINELLE));
    }

    #[test]
    fn effacer_la_cle_vide_le_trousseau() {
        let banc = banc_trousseau();
        banc.store
            .update_settings(
                &json!({ "llmTarget": "https://a.exemple.fr", "llmApiKey": SENTINELLE }),
            )
            .unwrap();
        let vue = banc
            .store
            .update_settings(&json!({ "llmApiKey": "" }))
            .unwrap();
        assert!(!vue.has_api_key);
        assert_eq!(vue.api_key_storage, "aucune");
        assert_eq!(banc.coffre.contenu(), None);
        assert!(banc.file().get("llmApiKeyInKeyring").is_none());
        assert_eq!(banc.store.upstream().unwrap().api_key, "");
        assert_eq!(banc.store.cle_connue(), "");

        // Autre serveur sans nouvelle clé : l'entrée est retirée aussi.
        banc.store
            .update_settings(&json!({ "llmApiKey": SENTINELLE }))
            .unwrap();
        assert_eq!(banc.coffre.contenu().as_deref(), Some(SENTINELLE));
        let vue = banc
            .store
            .update_settings(&json!({ "llmTarget": "https://b.exemple.fr" }))
            .unwrap();
        assert!(!vue.has_api_key);
        assert_eq!(banc.coffre.contenu(), None);
        assert_eq!(banc.store.upstream().unwrap().api_key, "");
    }

    #[test]
    fn une_entree_disparue_du_trousseau_donne_une_cle_vide() {
        let banc = banc_trousseau();
        banc.store
            .update_settings(&json!({ "llmTarget": "http://x", "llmApiKey": SENTINELLE }))
            .unwrap();
        banc.coffre.effacer().unwrap();
        let relance = Store::new(banc.dir.path(), Box::new(banc.coffre.clone()));
        assert_eq!(relance.upstream().unwrap().api_key, "");
        // L'indicateur reste : l'utilisateur voit une clé enregistrée et la
        // saisit à nouveau.
        assert_eq!(relance.settings().api_key_storage, "trousseau");
    }

    /// La page ne peut pas poser l'indicateur elle-même.
    #[test]
    fn la_page_ne_peut_pas_poser_l_indicateur() {
        let banc = banc();
        let vue = banc
            .store
            .update_settings(&json!({ "llmTarget": "http://x", "llmApiKeyInKeyring": true }))
            .unwrap();
        assert!(!vue.has_api_key);
        assert_eq!(vue.api_key_storage, "aucune");
    }
}
