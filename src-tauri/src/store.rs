//! Réglages du modèle (`settings.json`) et mots valides (`valid-words.json`).
//!
//! Même format et mêmes validations que le serveur Bun (`settings.ts`, route
//! `/api/valid-words` de `server.ts`) : les fichiers existants sont repris
//! tels quels, et les messages d'erreur sont les mêmes.
//!
//! La clé API ne sort jamais de Rust : la page ne voit que `hasApiKey`. Elle
//! n'est lue que par le relais du modèle (`llm.rs`), qui l'envoie au seul
//! serveur enregistré avec elle. Quand l'adresse du modèle change de serveur
//! (origine : schéma, hôte, port) sans qu'une nouvelle clé soit fournie, la
//! clé enregistrée est effacée : elle ne doit jamais partir ailleurs.
//!
//! Les fichiers sont relus à chaque appel (ils font quelques centaines
//! d'octets) : tant que le serveur Bun tourne encore à côté, Rust voit
//! toujours ce qu'il a écrit.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::logs;
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
    pub llm_api_key: String,
    pub llm_model_name: String,
    pub llm_disable_thinking: bool,
}

/// Sans la clé, pour qu'un `{:?}` ne la fasse jamais apparaître.
impl std::fmt::Debug for LlmSettings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LlmSettings")
            .field("llm_target", &self.llm_target)
            .field("has_api_key", &!self.llm_api_key.is_empty())
            .field("llm_model_name", &self.llm_model_name)
            .field("llm_disable_thinking", &self.llm_disable_thinking)
            .finish()
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
}

/// Champs fournis par une mise à jour (absents : inchangés).
#[derive(Default)]
struct SettingsUpdate {
    llm_target: Option<String>,
    llm_api_key: Option<String>,
    llm_model_name: Option<String>,
    llm_disable_thinking: Option<bool>,
}

/// Accès aux deux fichiers. Le verrou sérialise les lectures-écritures.
pub struct Store(Arc<StoreInner>);

struct StoreInner {
    settings_path: PathBuf,
    words_path: PathBuf,
    lock: Mutex<()>,
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
    /// Fichiers `settings.json` et `valid-words.json` de `data_dir`.
    pub fn new(data_dir: &Path) -> Self {
        Store(Arc::new(StoreInner {
            settings_path: data_dir.join(SETTINGS_FILE),
            words_path: data_dir.join(VALID_WORDS_FILE),
            lock: Mutex::new(()),
        }))
    }

    fn locked<T>(&self, work: impl FnOnce(&StoreInner) -> T) -> T {
        let _guard = self
            .0
            .lock
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        work(&self.0)
    }

    /// Réglages publics (sans la clé).
    pub fn settings(&self) -> PublicSettings {
        self.locked(|inner| {
            let (exists, settings) = read_settings(&inner.settings_path);
            public_view(exists, &settings)
        })
    }

    /// Valide, applique et enregistre une mise à jour (`PUT /api/settings`).
    pub fn update_settings(&self, input: &Value) -> Result<PublicSettings, String> {
        self.locked(|inner| {
            let update = parse_update(input, false)?;
            let (_, current) = read_settings(&inner.settings_path);
            let next = apply_update(&current, update);
            write_settings(&inner.settings_path, &next)
                .map_err(|error| format!("Enregistrement des réglages impossible : {error}"))?;
            Ok(public_view(true, &next))
        })
    }

    /// Adresse et clé du modèle, pour le relais. `None` sans modèle configuré.
    pub fn upstream(&self) -> Option<Upstream> {
        self.locked(|inner| {
            let (exists, settings) = read_settings(&inner.settings_path);
            (exists && !settings.llm_target.is_empty()).then_some(Upstream {
                target: settings.llm_target,
                api_key: settings.llm_api_key,
            })
        })
    }

    /// Mots valides enregistrés (`GET /api/valid-words`).
    pub fn valid_words(&self) -> Vec<String> {
        self.locked(|inner| read_words(&inner.words_path))
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
        self.locked(|inner| {
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
        has_api_key: !settings.llm_api_key.is_empty(),
    }
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

/// Adresse racine du serveur du modèle : http(s), sans « /v1 » final ni barre
/// oblique (`normalizeTarget` de `settings.ts`, même analyse WHATWG).
pub fn normalize_target(value: &str) -> Result<String, String> {
    let url = Url::parse(value).map_err(|_| {
        "L'adresse du modèle doit être une URL complète (http://… ou https://…).".to_string()
    })?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("L'adresse du modèle doit commencer par http:// ou https://.".into());
    }
    let href = url.as_str().trim_end_matches('/');
    Ok(href.strip_suffix("/v1").unwrap_or(href).to_string())
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
        update.llm_target = Some(if from_file && target.is_empty() {
            target
        } else {
            normalize_target(&target)?
        });
    }
    update.llm_api_key = text("llmApiKey")?;
    update.llm_model_name = text("llmModelName")?;
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

/// Lit `settings.json` : (fichier présent, réglages). Un fichier illisible ou
/// invalide donne les valeurs par défaut, comme `settings.ts`.
fn read_settings(path: &Path) -> (bool, LlmSettings) {
    let defaults = LlmSettings::default();
    if !path.exists() {
        return (false, defaults);
    }
    let parsed = fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok());
    let update = parsed.and_then(|mut raw| {
        if let Value::Object(object) = &mut raw {
            if older_than_current(object.get("settingsVersion")) {
                object.remove("llmDisableThinking");
            }
        }
        parse_update(&raw, true).ok()
    });
    let settings = match update {
        Some(update) => apply_fields(&defaults, update),
        None => defaults,
    };
    (true, settings)
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
    }
}

/// Mise à jour venue de la page. Décision du PO : si l'adresse change de
/// serveur et qu'aucune clé n'est fournie, la clé enregistrée est effacée.
fn apply_update(current: &LlmSettings, update: SettingsUpdate) -> LlmSettings {
    let key_given = update.llm_api_key.is_some();
    let mut next = apply_fields(current, update);
    if !key_given && origin(&next.llm_target) != origin(&current.llm_target) {
        next.llm_api_key.clear();
    }
    next
}

/// Écriture atomique : fichier temporaire (`<nom>.tmp`, comme le serveur),
/// puis renommage. `private` : lisible par le seul propriétaire (0600).
fn write_atomic(path: &Path, content: &str, private: bool) -> std::io::Result<()> {
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
    });
    write_atomic(path, &content, true)
}

/// `{ "words": [...] }` ; fichier absent ou invalide : liste vide.
fn read_words(path: &Path) -> Vec<String> {
    let Some(raw) = fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
    else {
        return Vec::new();
    };
    match raw.get("words") {
        Some(Value::Array(words)) => words
            .iter()
            .filter_map(|word| word.as_str().map(str::to_owned))
            .collect(),
        _ => Vec::new(),
    }
}

fn write_words(path: &Path, words: &[String]) -> std::io::Result<()> {
    #[derive(Serialize)]
    struct WordsFile<'a> {
        words: &'a [String],
    }
    write_atomic(path, &pretty_json(&WordsFile { words }), false)
}

/// Réglages du modèle, sans la clé (seulement `hasApiKey`).
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
    use serde_json::json;

    struct Banc {
        dir: tempfile::TempDir,
        store: Store,
    }

    fn banc() -> Banc {
        let dir = tempfile::tempdir().expect("dossier temporaire");
        let store = Store::new(dir.path());
        Banc { dir, store }
    }

    impl Banc {
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
            })
        );
        // Octet pour octet ce qu'écrit settings.ts (JSON.stringify(…, null, 2)).
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
}
