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

/// Temps laissé pour lire le message avant un redémarrage de secours.
const RESTART_DELAY: Duration = Duration::from_secs(6);

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
    /// Aucun manifeste publié : pas de mise à jour disponible pour le moment.
    NoRelease,
    Error,
}

/// Étape qui a échoué (phase `Error`) : « Réessayer » relance celle-là.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Step {
    Check,
    Install,
}

/// Issue d'une recherche.
#[derive(Debug)]
enum CheckOutcome {
    Found {
        version: String,
        notes: Option<String>,
    },
    UpToDate,
    /// Le manifeste n'existe pas (encore) sur la dernière release.
    NoRelease,
    Failed(String),
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
    /// Étape en échec quand `phase` vaut `Error`.
    failed_step: Option<Step>,
    release_page: &'static str,
}

impl Status {
    fn new(current_version: String, mode: Mode) -> Self {
        Self {
            current_version,
            mode,
            phase: Phase::Idle,
            version: None,
            notes: None,
            downloaded: 0,
            total: None,
            error: None,
            error_detail: None,
            failed_step: None,
            release_page: RELEASE_PAGE,
        }
    }

    fn clear_error(&mut self) {
        self.error = None;
        self.error_detail = None;
        self.failed_step = None;
    }

    fn fail(&mut self, step: Step, message: &str, detail: String) {
        self.phase = Phase::Error;
        self.error = Some(message.to_string());
        self.error_detail = Some(detail);
        self.failed_step = Some(step);
    }

    /// Vrai pendant une recherche, un téléchargement ou une installation.
    fn busy(&self) -> bool {
        matches!(
            self.phase,
            Phase::Checking | Phase::Downloading | Phase::Installing
        )
    }

    /// Démarre une recherche, sauf si une étape est déjà en cours.
    fn begin_check(&mut self) -> bool {
        if self.mode == Mode::Inactive || self.busy() {
            return false;
        }
        self.phase = Phase::Checking;
        self.clear_error();
        true
    }

    /// Enregistre l'issue d'une recherche. Renvoie faux, sans rien changer, si
    /// l'état n'est plus « recherche en cours » : une recherche qui se termine
    /// ne doit jamais écraser un téléchargement ou une installation.
    fn finish_check(&mut self, outcome: CheckOutcome) -> bool {
        if self.phase != Phase::Checking {
            return false;
        }
        let (phase, version, notes) = match outcome {
            CheckOutcome::Found { version, notes } => (
                Phase::Available,
                Some(version),
                notes.filter(|notes| !notes.trim().is_empty()),
            ),
            CheckOutcome::UpToDate => (Phase::UpToDate, None, None),
            CheckOutcome::NoRelease => (Phase::NoRelease, None, None),
            // La version trouvée auparavant, s'il y en a une, reste proposée.
            CheckOutcome::Failed(detail) => {
                self.fail(
                    Step::Check,
                    "Impossible de vérifier les mises à jour. Vérifiez votre connexion à Internet, puis réessayez.",
                    detail,
                );
                return true;
            }
        };
        (self.phase, self.version, self.notes) = (phase, version, notes);
        true
    }

    /// Démarre l'installation : seulement en mode automatique, avec une mise à
    /// jour trouvée, et jamais pendant une recherche ou une installation.
    fn begin_install(&mut self, has_pending: bool) -> bool {
        if self.mode != Mode::Auto || self.busy() || !has_pending {
            return false;
        }
        self.phase = Phase::Downloading;
        self.downloaded = 0;
        self.total = None;
        self.clear_error();
        true
    }
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
            status: Status::new(
                app.package_info().version.to_string(),
                mode_for(bundle_type(), pubkey),
            ),
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

/// État courant, sans rien déclencher.
#[tauri::command]
pub fn update_status(state: State<'_, UpdateState>) -> Status {
    state.status()
}

/// Recherche une version stable plus récente. Ne télécharge rien.
#[tauri::command]
pub async fn update_check(app: AppHandle, state: State<'_, UpdateState>) -> Result<Status, String> {
    if !state.update(|inner| inner.status.begin_check()) {
        return Ok(state.status());
    }

    // Sous Windows, l'installeur remplace le serveur embarqué : on l'arrête
    // juste avant, sinon son exécutable est encore verrouillé.
    let app_for_exit = app.clone();
    let found = async {
        app.updater_builder()
            .timeout(CHECK_TIMEOUT)
            .on_before_exit(move || {
                crate::stop_server(&app_for_exit);
                app_for_exit.cleanup_before_exit();
            })
            .build()?
            .check()
            .await
    }
    .await;

    Ok(state.update(|inner| {
        let (outcome, update) = match found {
            Ok(Some(update)) => (
                CheckOutcome::Found {
                    version: update.version.clone(),
                    notes: update.body.clone(),
                },
                Some(update),
            ),
            Ok(None) => (CheckOutcome::UpToDate, None),
            // Aucun manifeste sur la dernière release (404) : ce n'est pas une
            // panne de connexion, il n'y a simplement rien à proposer.
            Err(tauri_plugin_updater::Error::ReleaseNotFound) => (CheckOutcome::NoRelease, None),
            Err(error) => (CheckOutcome::Failed(error.to_string()), None),
        };
        let failed = matches!(outcome, CheckOutcome::Failed(_));
        if inner.status.finish_check(outcome) && !failed {
            inner.pending = update;
        }
        inner.status.clone()
    }))
}

/// Télécharge la mise à jour trouvée, vérifie sa signature, l'installe et
/// redémarre l'application. Appelée uniquement sur action de l'utilisateur.
/// Rend la main tout de suite : l'interface suit l'avancement par `update_status`.
#[tauri::command]
pub fn update_install(app: AppHandle, state: State<'_, UpdateState>) -> Status {
    let Some(update) = state.update(|inner| {
        if inner.status.begin_install(inner.pending.is_some()) {
            inner.pending.clone()
        } else {
            None
        }
    }) else {
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
            Err(error) => {
                // Windows : le serveur embarqué est arrêté juste avant de lancer
                // l'installeur. Si ce lancement échoue, l'application n'a plus
                // de serveur : on prévient, puis on la redémarre.
                let server_stopped = !crate::server_running(&app);
                app.state::<UpdateState>().update(|inner| {
                    inner.status.fail(
                        Step::Install,
                        if server_stopped {
                            "La mise à jour n'a pas pu être installée. Votre version actuelle est conservée ; Grammaria redémarre dans quelques secondes."
                        } else {
                            "La mise à jour n'a pas pu être installée. Votre version actuelle est conservée."
                        },
                        error.to_string(),
                    );
                });
                if server_stopped {
                    std::thread::spawn(move || {
                        std::thread::sleep(RESTART_DELAY);
                        app.request_restart();
                    });
                }
            }
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
        let mut status = Status::new("0.3.0".into(), Mode::Auto);
        status.phase = Phase::UpToDate;
        let json = serde_json::to_value(&status).expect("sérialisable");
        assert_eq!(json["currentVersion"], "0.3.0");
        assert_eq!(json["mode"], "auto");
        assert_eq!(json["phase"], "upToDate");
        assert_eq!(json["releasePage"], RELEASE_PAGE);
        assert!(json["errorDetail"].is_null());
        assert!(json["failedStep"].is_null());
        status.fail(Step::Check, "message", "détail".into());
        let json = serde_json::to_value(&status).expect("sérialisable");
        assert_eq!(json["phase"], "error");
        assert_eq!(json["failedStep"], "check");
        status.phase = Phase::NoRelease;
        assert_eq!(
            serde_json::to_value(&status).expect("sérialisable")["phase"],
            "noRelease"
        );
    }

    fn found(version: &str) -> CheckOutcome {
        CheckOutcome::Found {
            version: version.into(),
            notes: Some("  ".into()),
        }
    }

    #[test]
    fn une_recherche_ne_demarre_pas_pendant_une_autre_etape() {
        for phase in [Phase::Checking, Phase::Downloading, Phase::Installing] {
            let mut status = Status::new("0.3.0".into(), Mode::Auto);
            status.phase = phase;
            assert!(!status.begin_check());
            assert_eq!(status.phase, phase);
        }
        let mut inactive = Status::new("0.3.0".into(), Mode::Inactive);
        assert!(!inactive.begin_check());
        assert_eq!(inactive.phase, Phase::Idle);
    }

    #[test]
    fn l_installation_est_refusee_pendant_une_recherche() {
        let mut status = Status::new("0.3.0".into(), Mode::Auto);
        assert!(status.begin_check());
        // Une mise à jour trouvée plus tôt ne suffit pas : la recherche est en cours.
        assert!(!status.begin_install(true));
        assert_eq!(status.phase, Phase::Checking);

        assert!(status.finish_check(found("0.3.1")));
        assert_eq!(status.phase, Phase::Available);
        assert_eq!(status.notes, None);
        assert!(!status.begin_install(false));
        assert!(status.begin_install(true));
        assert_eq!(status.phase, Phase::Downloading);
        // Pas de second téléchargement en parallèle.
        assert!(!status.begin_install(true));

        let mut manual = Status::new("0.3.0".into(), Mode::Manual);
        manual.phase = Phase::Available;
        assert!(!manual.begin_install(true));
    }

    #[test]
    fn la_fin_d_une_recherche_n_ecrase_pas_une_installation() {
        for phase in [Phase::Downloading, Phase::Installing] {
            let mut status = Status::new("0.3.0".into(), Mode::Auto);
            status.phase = phase;
            status.version = Some("0.3.1".into());
            assert!(!status.finish_check(CheckOutcome::UpToDate));
            assert!(!status.finish_check(CheckOutcome::Failed("réseau".into())));
            assert_eq!(status.phase, phase);
            assert_eq!(status.version.as_deref(), Some("0.3.1"));
            assert_eq!(status.error, None);
        }
    }

    #[test]
    fn l_etape_en_echec_est_connue_et_la_version_trouvee_reste_proposee() {
        let mut status = Status::new("0.3.0".into(), Mode::Auto);
        status.begin_check();
        status.finish_check(found("0.3.1"));
        // Nouvelle recherche, qui échoue : c'est la recherche qu'il faut relancer.
        assert!(status.begin_check());
        assert!(status.finish_check(CheckOutcome::Failed("réseau".into())));
        assert_eq!(status.phase, Phase::Error);
        assert_eq!(status.failed_step, Some(Step::Check));
        assert_eq!(status.version.as_deref(), Some("0.3.1"));

        // Installation en échec : c'est l'installation qu'il faut relancer.
        assert!(status.begin_install(true));
        assert_eq!(status.failed_step, None);
        status.fail(Step::Install, "message", "signature".into());
        assert_eq!(status.failed_step, Some(Step::Install));
        assert!(status.begin_install(true));
    }

    #[test]
    fn un_manifeste_introuvable_n_est_pas_une_panne_de_connexion() {
        let mut status = Status::new("0.3.0".into(), Mode::Auto);
        status.begin_check();
        assert!(status.finish_check(CheckOutcome::NoRelease));
        assert_eq!(status.phase, Phase::NoRelease);
        assert_eq!(status.error, None);
        assert_eq!(status.failed_step, None);
    }

    fn capability() -> serde_json::Value {
        serde_json::from_str(include_str!("../capabilities/mise-a-jour.json")).expect("JSON valide")
    }

    /// La capability ne doit s'appliquer qu'au serveur local, quel que soit
    /// son port, et à aucune autre origine.
    #[test]
    fn la_capability_ne_couvre_que_le_serveur_local() {
        let capability = capability();
        assert_eq!(capability["local"], false);
        let urls = capability["remote"]["urls"]
            .as_array()
            .expect("liste d'URL");
        assert_eq!(urls.len(), 1);
        let pattern =
            RemoteUrlPattern::from_str(urls[0].as_str().expect("chaîne")).expect("motif valide");
        let matches = |url: &str| pattern.test(&tauri::Url::parse(url).expect("URL valide"));

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
        let capability = capability();
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
