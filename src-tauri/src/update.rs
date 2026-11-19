//! Mise à jour automatique de l'application de bureau.
//!
//! Toute la logique est ici, côté Rust, au-dessus du plugin officiel
//! `tauri-plugin-updater` : recherche de la dernière version stable,
//! téléchargement, vérification de la signature, installation, redémarrage.
//! L'interface (servie par le serveur local) ne fait que déclencher ces étapes
//! par quatre commandes, autorisées dans `capabilities/mise-a-jour.json`.
//!
//! Rien n'est installé sans une action de l'utilisateur : `update_check` ne
//! fait que regarder, seule `update_install` télécharge et installe.

use std::sync::Mutex;
use std::time::Duration;

use semver::Version;
use serde::Serialize;
use tauri::utils::config::BundleType;
use tauri::utils::platform::bundle_type;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::{Update, UpdaterExt};

/// Page de la dernière version stable, pour un téléchargement à la main.
const RELEASE_PAGE: &str = "https://github.com/WillIsback/Grammaria/releases/latest";

/// Délai maximal de la recherche d'une mise à jour.
const CHECK_TIMEOUT: Duration = Duration::from_secs(20);

/// Ce que cette installation sait faire.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    /// Installeur Windows (NSIS) ou AppImage : téléchargement et installation.
    Auto,
    /// Paquet .deb, MSI ou build de développement : l'application signale la
    /// nouvelle version et renvoie vers la page de téléchargement.
    Manual,
    /// Clé publique absente de tauri.conf.json : aucune recherche.
    Inactive,
}

/// Étape en cours.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Idle,
    Checking,
    UpToDate,
    Available,
    Downloading,
    Installing,
    Error,
}

/// État transmis à l'interface.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    current_version: String,
    mode: Mode,
    phase: Phase,
    /// Version proposée, quand il y en a une.
    version: Option<String>,
    /// Notes de version publiées avec la mise à jour.
    notes: Option<String>,
    /// Octets téléchargés et taille totale (si le serveur l'annonce).
    downloaded: u64,
    total: Option<u64>,
    /// Message d'erreur en français, et détail technique pour le support.
    error: Option<String>,
    error_detail: Option<String>,
    release_page: &'static str,
}

struct Inner {
    status: Status,
    /// Mise à jour trouvée par la dernière recherche, en attente d'accord.
    pending: Option<Update>,
}

/// État partagé de la mise à jour.
pub struct UpdateState(Mutex<Inner>);

impl UpdateState {
    pub fn new(app: &tauri::App) -> Self {
        let pubkey = app
            .config()
            .plugins
            .0
            .get("updater")
            .and_then(|updater| updater.get("pubkey"))
            .and_then(|pubkey| pubkey.as_str())
            .unwrap_or_default();
        Self(Mutex::new(Inner {
            status: Status {
                current_version: app.package_info().version.to_string(),
                mode: mode_for(bundle_type(), pubkey),
                phase: Phase::Idle,
                version: None,
                notes: None,
                downloaded: 0,
                total: None,
                error: None,
                error_detail: None,
                release_page: RELEASE_PAGE,
            },
            pending: None,
        }))
    }

    /// Modifie l'état et renvoie sa copie. Un verrou empoisonné (panique
    /// ailleurs) ne doit pas bloquer l'interface : on reprend la valeur.
    fn update<T>(&self, change: impl FnOnce(&mut Inner) -> T) -> T {
        let mut inner = self.0.lock().unwrap_or_else(|poison| poison.into_inner());
        change(&mut inner)
    }

    fn status(&self) -> Status {
        self.update(|inner| inner.status.clone())
    }
}

/// Mode de mise à jour selon le paquet installé et la clé publique.
///
/// Le manifeste publié ne décrit que l'installeur NSIS et l'AppImage. Une
/// installation MSI ou .deb y trouverait donc l'entrée générique de sa
/// plateforme et installerait un paquet d'un autre type : on ne le permet pas.
fn mode_for(bundle: Option<BundleType>, pubkey: &str) -> Mode {
    if pubkey.trim().is_empty() {
        return Mode::Inactive;
    }
    match bundle {
        Some(BundleType::Nsis | BundleType::AppImage) => Mode::Auto,
        _ => Mode::Manual,
    }
}

/// Vrai quand `candidate` est une version stable plus récente que `current`.
/// Une pré-version (0.4.0-rc.1, 0.4.0-1) n'est jamais proposée, même si un
/// manifeste en annonçait une par erreur.
pub fn is_stable_upgrade(current: &Version, candidate: &Version) -> bool {
    candidate.pre.is_empty() && candidate > current
}

fn fail(inner: &mut Inner, message: &str, detail: String) {
    inner.status.phase = Phase::Error;
    inner.status.error = Some(message.to_string());
    inner.status.error_detail = Some(detail);
}

/// État courant, sans rien déclencher.
#[tauri::command]
pub fn update_status(state: State<'_, UpdateState>) -> Status {
    state.status()
}

/// Recherche une version stable plus récente. Ne télécharge rien.
#[tauri::command]
pub async fn update_check(app: AppHandle, state: State<'_, UpdateState>) -> Result<Status, String> {
    let start = state.update(|inner| {
        let busy = matches!(
            inner.status.phase,
            Phase::Checking | Phase::Downloading | Phase::Installing
        );
        if inner.status.mode == Mode::Inactive || busy {
            return false;
        }
        inner.status.phase = Phase::Checking;
        inner.status.error = None;
        inner.status.error_detail = None;
        true
    });
    if !start {
        return Ok(state.status());
    }

    // Sous Windows, l'installeur remplace le serveur embarqué : on l'arrête
    // juste avant, sinon son exécutable est encore verrouillé.
    let app_for_exit = app.clone();
    let found = match app
        .updater_builder()
        .timeout(CHECK_TIMEOUT)
        .on_before_exit(move || {
            crate::stop_server(&app_for_exit);
            app_for_exit.cleanup_before_exit();
        })
        .build()
    {
        Ok(updater) => updater.check().await,
        Err(error) => Err(error),
    };

    Ok(state.update(|inner| {
        match found {
            Ok(Some(update)) => {
                inner.status.phase = Phase::Available;
                inner.status.version = Some(update.version.clone());
                inner.status.notes = update.body.clone().filter(|notes| !notes.trim().is_empty());
                inner.pending = Some(update);
            }
            Ok(None) => {
                inner.status.phase = Phase::UpToDate;
                inner.status.version = None;
                inner.status.notes = None;
                inner.pending = None;
            }
            Err(error) => fail(
                inner,
                "Impossible de vérifier les mises à jour. Vérifiez votre connexion à Internet, puis réessayez.",
                error.to_string(),
            ),
        }
        inner.status.clone()
    }))
}

/// Télécharge la mise à jour trouvée, vérifie sa signature, l'installe et
/// redémarre l'application. Appelée uniquement sur action de l'utilisateur.
/// Rend la main tout de suite : l'interface suit l'avancement par `update_status`.
#[tauri::command]
pub fn update_install(app: AppHandle, state: State<'_, UpdateState>) -> Status {
    let update = state.update(|inner| {
        if inner.status.mode != Mode::Auto
            || matches!(inner.status.phase, Phase::Downloading | Phase::Installing)
        {
            return None;
        }
        let update = inner.pending.clone()?;
        inner.status.phase = Phase::Downloading;
        inner.status.downloaded = 0;
        inner.status.total = None;
        inner.status.error = None;
        inner.status.error_detail = None;
        Some(update)
    });
    let Some(update) = update else {
        return state.status();
    };

    tauri::async_runtime::spawn(async move {
        let progress = app.clone();
        let finished = app.clone();
        let result = update
            .download_and_install(
                move |chunk, total| {
                    progress.state::<UpdateState>().update(|inner| {
                        inner.status.downloaded += chunk as u64;
                        inner.status.total = total;
                    });
                },
                move || {
                    finished
                        .state::<UpdateState>()
                        .update(|inner| inner.status.phase = Phase::Installing);
                },
            )
            .await;
        match result {
            // Windows : l'installeur a déjà quitté l'application et la relance
            // lui-même. Linux : l'AppImage est remplacée, on redémarre dessus.
            Ok(()) => {
                crate::stop_server(&app);
                app.request_restart();
            }
            // Signature invalide, téléchargement coupé, dossier non modifiable… :
            // rien n'a été installé, la mise à jour reste proposée.
            Err(error) => app.state::<UpdateState>().update(|inner| {
                fail(
                    inner,
                    "La mise à jour n'a pas pu être installée. Votre version actuelle est conservée.",
                    error.to_string(),
                );
            }),
        }
    });

    state.status()
}

/// Ouvre la page de téléchargement dans le navigateur. L'adresse est fixe :
/// l'interface ne peut pas faire ouvrir autre chose.
#[tauri::command]
pub fn update_open_release_page(app: AppHandle) -> Result<(), String> {
    app.opener()
        .open_url(RELEASE_PAGE, None::<&str>)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;
    use tauri::utils::acl::RemoteUrlPattern;

    const PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IGV4ZW1wbGU=";

    fn version(text: &str) -> Version {
        Version::parse(text).expect("version valide")
    }

    #[test]
    fn sans_cle_publique_rien_n_est_actif() {
        assert_eq!(mode_for(Some(BundleType::Nsis), ""), Mode::Inactive);
        assert_eq!(mode_for(Some(BundleType::AppImage), "  "), Mode::Inactive);
        assert_eq!(mode_for(None, ""), Mode::Inactive);
    }

    #[test]
    fn seuls_nsis_et_appimage_s_installent_seuls() {
        assert_eq!(mode_for(Some(BundleType::Nsis), PUBKEY), Mode::Auto);
        assert_eq!(mode_for(Some(BundleType::AppImage), PUBKEY), Mode::Auto);
        assert_eq!(mode_for(Some(BundleType::Msi), PUBKEY), Mode::Manual);
        assert_eq!(mode_for(Some(BundleType::Deb), PUBKEY), Mode::Manual);
        assert_eq!(mode_for(None, PUBKEY), Mode::Manual);
    }

    #[test]
    fn seule_une_version_stable_plus_recente_est_proposee() {
        let current = version("0.3.0");
        assert!(is_stable_upgrade(&current, &version("0.3.1")));
        assert!(is_stable_upgrade(&current, &version("1.0.0")));
        assert!(!is_stable_upgrade(&current, &version("0.3.0")));
        assert!(!is_stable_upgrade(&current, &version("0.2.9")));
        // Pré-versions : jamais proposées.
        assert!(!is_stable_upgrade(&current, &version("0.4.0-rc.1")));
        assert!(!is_stable_upgrade(&current, &version("0.4.0-1")));
        // Une alpha reçoit la version stable correspondante.
        assert!(is_stable_upgrade(&version("0.3.0-2"), &version("0.3.0")));
    }

    #[test]
    fn l_etat_est_serialise_en_camel_case() {
        let status = Status {
            current_version: "0.3.0".into(),
            mode: Mode::Auto,
            phase: Phase::UpToDate,
            version: None,
            notes: None,
            downloaded: 0,
            total: None,
            error: None,
            error_detail: None,
            release_page: RELEASE_PAGE,
        };
        let json = serde_json::to_value(&status).expect("sérialisable");
        assert_eq!(json["currentVersion"], "0.3.0");
        assert_eq!(json["mode"], "auto");
        assert_eq!(json["phase"], "upToDate");
        assert_eq!(json["releasePage"], RELEASE_PAGE);
        assert!(json["errorDetail"].is_null());
    }

    /// La capability ne doit s'appliquer qu'au serveur local, quel que soit
    /// son port, et à aucune autre origine.
    #[test]
    fn la_capability_ne_couvre_que_le_serveur_local() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/mise-a-jour.json"))
                .expect("JSON valide");
        assert_eq!(capability["local"], false);
        let urls = capability["remote"]["urls"]
            .as_array()
            .expect("liste d'URL");
        assert_eq!(urls.len(), 1);
        let pattern =
            RemoteUrlPattern::from_str(urls[0].as_str().expect("chaîne")).expect("motif valide");
        let matches = |url: &str| pattern.test(&url::Url::parse(url).expect("URL valide"));

        assert!(matches("http://127.0.0.1:25000/"));
        assert!(matches("http://127.0.0.1:49152/index.html?x=1#y"));
        assert!(!matches("https://127.0.0.1:25000/"));
        assert!(!matches("http://localhost:25000/"));
        assert!(!matches("http://127.0.0.1.exemple.com:25000/"));
        assert!(!matches("http://exemple.com/"));
        assert!(!matches("http://192.168.1.10:25000/"));
    }

    /// Les permissions de la capability sont exactement les commandes
    /// enregistrées : pas de commande de plugin, pas de `core:default`.
    #[test]
    fn la_capability_n_autorise_que_les_commandes_de_mise_a_jour() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/mise-a-jour.json"))
                .expect("JSON valide");
        let permissions: Vec<&str> = capability["permissions"]
            .as_array()
            .expect("liste de permissions")
            .iter()
            .map(|permission| permission.as_str().expect("chaîne"))
            .collect();
        assert_eq!(
            permissions,
            [
                "allow-update-status",
                "allow-update-check",
                "allow-update-install",
                "allow-update-open-release-page",
            ]
        );
    }
}
