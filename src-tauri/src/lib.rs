//! Application de bureau Grammaria.
//!
//! L'interface est embarquée (`frontendDist` : `dist/bureau`, servie par Tauri sous
//! `tauri://localhost`) : ni serveur local, ni port ouvert. La logique métier reste en
//! TypeScript, dans la page : le gestionnaire d'API partagé avec le serveur web
//! (`api/handler.ts`) y reçoit les `fetch("/api/…")` de l'interface.
//!
//! Rust fournit ce que la page ne peut pas faire seule, par des commandes que seule la
//! capability locale `capabilities/default.json` autorise : accès SQLite au journal (`db`),
//! réglages, clé API et mots valides (`store`), relais du modèle en streaming (`llm`), mise à
//! jour de l'application (`update`), journal technique `grammaria.log` (`logs`), et le
//! correcteur grammatical (`correcteur` : moteur Rust grammaria-rc). Les
//! fichiers du dossier de données sont ceux de la version 0.2 : les données sont reprises
//! telles quelles.

use std::fs;

use tauri::webview::NewWindowResponse;
use tauri::{Manager, Url, WebviewWindowBuilder};

mod autotest;
mod correcteur;
mod db;
mod llm;
mod logs;
mod store;
mod update;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Un second lancement remet la fenêtre existante au premier plan.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        // Le plugin ne sert qu'à ouvrir la page de téléchargement depuis Rust.
        // Son script de page, qui intercepte les liens `target="_blank"` pour
        // les ouvrir par une commande que l'interface n'a pas le droit
        // d'appeler, est désactivé : les liens gardent leur comportement normal.
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        // Mise à jour : seule une version stable plus récente est proposée.
        .plugin(
            tauri_plugin_updater::Builder::new()
                .default_version_comparator(|current, release| {
                    update::is_stable_upgrade(&current, &release.version)
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            update::update_status,
            update::update_check,
            update::update_install,
            update::update_open_release_page,
            db::db_read,
            db::db_read_many,
            db::db_batch,
            store::settings_get,
            store::settings_set,
            store::valid_words_get,
            store::valid_words_add,
            llm::llm_models,
            llm::llm_chat,
            llm::llm_cancel,
            logs::log_page,
            correcteur::correcteur_prechauffer,
            correcteur::correcteur_controler,
            // Inertes sans GRAMMARIA_AUTOTEST_OUT (voir autotest.rs).
            autotest::autotest_config,
            autotest::autotest_terminer,
        ])
        .setup(|app| {
            app.manage(update::UpdateState::new(app));
            let autotest = autotest::Autotest::depuis_env();
            // Mêmes fichiers que l'ancienne version : les données sont reprises
            // telles quelles. La base n'est ouverte qu'au premier appel de `db_*`.
            // Autotest : dossier neuf, jamais celui de l'utilisateur.
            let data_dir = match &autotest {
                Some(autotest) => autotest.preparer_dossier_donnees()?,
                None => app.path().app_data_dir()?,
            };
            // Journal technique (`grammaria.log`) : dossier de journaux de
            // l'application, celui de l'ancien `server.log`. Autotest : à côté
            // des données isolées.
            let log_dir = match &autotest {
                Some(_) => data_dir.join("logs"),
                None => app.path().app_log_dir()?,
            };
            logs::initialiser(&log_dir, &app.package_info().version.to_string());
            installer_journal_des_paniques();
            if autotest.is_some() {
                logs::ecrire(logs::Niveau::Info, "application", "Mode autotest.");
            }
            fs::create_dir_all(&data_dir)?;
            app.manage(db::Db::new(data_dir.join(db::JOURNAL_FILE)));
            let store = store::Store::new(&data_dir);
            // Un fichier de réglages abîmé est ignoré (valeurs par défaut) et
            // remplacé au prochain enregistrement : le support doit le savoir.
            for fichier in store.fichiers_illisibles() {
                logs::ecrire(
                    logs::Niveau::Avertissement,
                    "réglages",
                    &format!(
                        "{fichier} est illisible ou invalide : valeurs par défaut utilisées, \
                         le fichier sera remplacé au prochain enregistrement."
                    ),
                );
            }
            app.manage(store);
            app.manage(llm::Llm::new()?);
            // Correcteur grammatical : données dans les ressources de l'application,
            // chargées à la première demande de la page (préchauffage).
            app.manage(correcteur::Correcteur::new(
                app.path()
                    .resource_dir()?
                    .join(correcteur::DOSSIER_RESSOURCES),
            ));

            // La fenêtre est créée ici (`create: false` dans tauri.conf.json)
            // pour n'ajouter le drapeau d'autotest qu'en mode autotest.
            let config = app
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == "main")
                .ok_or("fenêtre principale absente de tauri.conf.json")?
                .clone();
            let mut fenetre = WebviewWindowBuilder::from_config(app, &config)?
                // La fenêtre n'affiche que la page embarquée : un lien ou un
                // script ne peut pas la faire naviguer ailleurs (la page
                // garderait l'accès aux commandes), ni ouvrir une autre fenêtre.
                // La page de téléchargement s'ouvre dans le navigateur du
                // système par une commande Rust (`update_open_release_page`).
                .on_navigation(|url| {
                    let autorisee = navigation_autorisee(url);
                    if !autorisee {
                        logs::commande_masquee(
                            logs::Niveau::Avertissement,
                            "fenêtre",
                            &format!("Navigation refusée vers {}.", origine(url)),
                            &[],
                        );
                    }
                    autorisee
                })
                .on_new_window(|url, _| {
                    logs::commande_masquee(
                        logs::Niveau::Avertissement,
                        "fenêtre",
                        &format!("Nouvelle fenêtre refusée ({}).", origine(&url)),
                        &[],
                    );
                    NewWindowResponse::Deny
                });
            if let Some(autotest) = autotest {
                app.add_capability(autotest::CAPABILITY)?;
                app.manage(autotest);
                autotest::Autotest::surveiller(app.handle());
                fenetre = fenetre
                    .initialization_script(autotest::SCRIPT_INITIALISATION)
                    // Stockage de la WebView (localStorage, cache) isolé lui aussi.
                    .data_directory(data_dir.join("webview"));
            }
            fenetre.build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("impossible de démarrer Grammaria")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                // Décompte d'erreurs répétées encore en attente, puis fermeture.
                logs::vider();
                logs::ecrire(logs::Niveau::Info, "application", "Fermeture.");
            }
        });
}

/// Vrai si la fenêtre peut afficher `url` : seulement l'origine de la page
/// embarquée, que Tauri sert par son protocole (`tauri://localhost` sous Linux
/// et macOS, `http://tauri.localhost` sous Windows, `https://tauri.localhost`
/// avec `useHttpsScheme`). Sans `devUrl` dans tauri.conf.json, le
/// développement utilise les mêmes adresses.
fn navigation_autorisee(url: &Url) -> bool {
    match (url.scheme(), url.host_str()) {
        ("tauri", Some("localhost")) => url.port().is_none(),
        ("http" | "https", Some("tauri.localhost")) => url.port().is_none(),
        _ => false,
    }
}

/// Origine d'une adresse, pour le journal (ni chemin ni paramètres).
fn origine(url: &Url) -> String {
    match url.host_str() {
        Some(hote) => format!("{}://{hote}", url.scheme()),
        None => format!("{}:", url.scheme()),
    }
}

/// Une panique est notée dans le journal technique avant le comportement
/// habituel (message sur la sortie d'erreur, arrêt du fil).
fn installer_journal_des_paniques() {
    let precedent = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        logs::ecrire(logs::Niveau::Erreur, "panique", &info.to_string());
        precedent(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::{navigation_autorisee, origine};
    use serde_json::Value;

    #[test]
    fn seule_la_page_embarquee_peut_etre_affichee() {
        let url = |texte: &str| tauri::Url::parse(texte).expect("URL valide");
        for permise in [
            "tauri://localhost",
            "tauri://localhost/index.html",
            "tauri://localhost/progression?jours=7#haut",
            "http://tauri.localhost/",
            "https://tauri.localhost/index.html",
        ] {
            assert!(navigation_autorisee(&url(permise)), "{permise}");
        }
        for refusee in [
            "https://exemple.fr/",
            "http://localhost:1420/",
            "http://127.0.0.1:25000/",
            "tauri://localhost.exemple.fr/",
            "tauri://autre/",
            "http://tauri.localhost:8080/",
            "http://tauri.localhost.exemple.fr/",
            "file:///etc/passwd",
            "data:text/html,<script>alert(1)</script>",
            "javascript:alert(1)",
            "about:blank",
            "blob:tauri://localhost/1234",
        ] {
            assert!(!navigation_autorisee(&url(refusee)), "{refusee}");
        }
        assert_eq!(
            origine(&url("https://exemple.fr/chemin?secret=1")),
            "https://exemple.fr"
        );
        assert_eq!(origine(&url("data:text/html,x")), "data:");
    }

    /// Texte entre `start` et la première occurrence de `end` qui suit.
    fn between<'a>(text: &'a str, start: &str, end: &str) -> &'a str {
        let from = text.find(start).expect("début trouvé") + start.len();
        let to = from + text[from..].find(end).expect("fin trouvée");
        &text[from..to]
    }

    fn commandes_enregistrees() -> Vec<&'static str> {
        let lib = include_str!("lib.rs");
        let mut registered: Vec<&str> = between(lib, "generate_handler![", "]")
            .split(',')
            .filter_map(|path| path.trim().rsplit("::").next())
            .filter(|name| !name.is_empty())
            .collect();
        registered.sort_unstable();
        registered
    }

    /// Une commande enregistrée mais absente de la liste de `build.rs` serait
    /// refusée à toute page ; une commande listée mais pas enregistrée
    /// produirait une permission vide. Les deux listes doivent coïncider.
    #[test]
    fn les_commandes_enregistrees_sont_celles_declarees_dans_build_rs() {
        let build = include_str!("../build.rs");
        let mut declared: Vec<&str> = between(build, "commands(&[", "]")
            .split(',')
            .map(|name| name.trim().trim_matches('"'))
            .filter(|name| !name.is_empty())
            .collect();
        declared.sort_unstable();
        assert_eq!(declared, commandes_enregistrees());
        assert_eq!(declared.len(), 19);
    }

    fn json(text: &str) -> Value {
        serde_json::from_str(text).expect("JSON valide")
    }

    /// La page embarquée est la seule origine : la capability est locale, pour
    /// la seule fenêtre `main`, et n'autorise que les commandes de
    /// l'application, une par une. Ni `core:default` ni commande de plugin.
    #[test]
    fn la_capability_est_locale_et_n_autorise_que_les_commandes_de_l_application() {
        let capability = json(include_str!("../capabilities/default.json"));
        assert_eq!(capability["identifier"], "default");
        assert_eq!(capability["windows"], serde_json::json!(["main"]));
        // `local` vaut vrai par défaut ; `remote` absent : aucune origine distante.
        assert_ne!(capability["local"], false);
        assert!(capability.get("remote").is_none());
        assert!(capability.get("webviews").is_none());

        let mut permissions: Vec<String> = capability["permissions"]
            .as_array()
            .expect("liste de permissions")
            .iter()
            .map(|p| p.as_str().expect("chaîne").to_string())
            .collect();
        permissions.sort_unstable();
        // Toutes les commandes, sauf celles de l'autotest (capability ajoutée
        // à l'exécution, en mode autotest seulement).
        let mut attendues: Vec<String> = commandes_enregistrees()
            .iter()
            .filter(|commande| !commande.starts_with("autotest_"))
            .map(|commande| format!("allow-{}", commande.replace('_', "-")))
            .collect();
        attendues.sort_unstable();
        assert_eq!(permissions, attendues);
        assert_eq!(permissions.len(), 17);
    }

    /// Une seule capability, déclarée explicitement : un fichier ajouté au
    /// dossier `capabilities/` ne serait pas pris en compte en silence.
    #[test]
    fn seule_la_capability_locale_est_active() {
        let conf = json(include_str!("../tauri.conf.json"));
        assert_eq!(
            conf["app"]["security"]["capabilities"],
            serde_json::json!(["default"])
        );
    }

    /// La fenêtre est créée par `setup` (drapeau d'autotest éventuel) : la
    /// configuration ne doit pas la créer une seconde fois.
    #[test]
    fn la_fenetre_principale_est_creee_par_setup() {
        let conf = json(include_str!("../tauri.conf.json"));
        let fenetres = conf["app"]["windows"].as_array().expect("fenêtres");
        assert_eq!(fenetres.len(), 1);
        assert_eq!(fenetres[0]["label"], "main");
        assert_eq!(fenetres[0]["create"], false);
    }

    /// La politique de sécurité de la page : rien que l'application elle-même
    /// (et l'IPC de Tauri), ni `unsafe-eval` ni `wasm-unsafe-eval`, ni
    /// ressource distante. La page ne joint jamais le modèle elle-même.
    #[test]
    fn la_politique_de_securite_n_autorise_que_l_application() {
        let conf = json(include_str!("../tauri.conf.json"));
        let csp = conf["app"]["security"]["csp"]
            .as_object()
            .expect("CSP en objet");
        let directive = |nom: &str| csp[nom].as_str().expect("directive présente").to_string();
        assert_eq!(directive("default-src"), "'self'");
        assert_eq!(directive("script-src"), "'self'");
        assert_eq!(directive("worker-src"), "'self'");
        assert_eq!(directive("connect-src"), "'self' ipc: http://ipc.localhost");
        assert_eq!(directive("object-src"), "'none'");
        assert_eq!(directive("frame-ancestors"), "'none'");
        for (nom, valeur) in csp {
            let valeur = valeur.as_str().expect("chaîne");
            assert!(!valeur.contains("unsafe-eval"), "{nom} : {valeur}");
            assert!(!valeur.contains("http://127.0.0.1"), "{nom} : {valeur}");
            assert!(!valeur.contains("https:"), "{nom} : {valeur}");
            assert!(!valeur.contains('*'), "{nom} : {valeur}");
        }
        assert_eq!(conf["build"]["frontendDist"], "../dist/bureau");
        assert!(conf["bundle"].get("externalBin").is_none());
        // Seules ressources : les données du moteur grammatical (lues par
        // `correcteur.rs`), aucun exécutable.
        let mut ressources: Vec<&str> = conf["bundle"]["resources"]
            .as_object()
            .expect("ressources en objet")
            .values()
            .map(|cible| cible.as_str().expect("chaîne"))
            .collect();
        ressources.sort_unstable();
        assert_eq!(ressources, ["moteur/grammaria/", "moteur/lt/"]);
    }
}
