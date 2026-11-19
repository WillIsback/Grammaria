//! Application de bureau Grammaria.
//!
//! La fenêtre n'embarque aucune logique : elle lance le serveur Grammaria
//! compilé (sidecar `grammaria-server`) sur un port local libre, attend qu'il
//! réponde, puis affiche son interface. Le serveur est le même que la version
//! web : correcteur grammatical intégré, journal SQLite, relais vers le LLM.
//! Seule la mise à jour de l'application vit ici (module `update`).

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent, Url, WebviewWindow};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

mod update;

/// Délai maximal de démarrage du serveur (chargement des règles compris).
const STARTUP_TIMEOUT: Duration = Duration::from_secs(60);

/// Processus du serveur, arrêté à la fermeture de l'application.
struct Sidecar(Mutex<Option<CommandChild>>);

/// Arrête le serveur embarqué (fermeture, redémarrage, mise à jour).
pub(crate) fn stop_server(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<Sidecar>() {
        if let Some(child) = state.0.lock().ok().and_then(|mut c| c.take()) {
            let _ = child.kill();
        }
    }
}

/// Faux une fois le serveur embarqué arrêté par `stop_server`.
pub(crate) fn server_running(app: &tauri::AppHandle) -> bool {
    app.try_state::<Sidecar>()
        .is_some_and(|state| state.0.lock().map(|c| c.is_some()).unwrap_or(false))
}

/// Port TCP libre sur 127.0.0.1, choisi par le système.
fn free_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    Ok(listener.local_addr()?.port())
}

/// Vrai quand le serveur répond à GET /api/settings.
fn server_ready(port: u16) -> bool {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(500)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let request = format!(
        "GET /api/settings HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut head = [0u8; 12];
    stream.read_exact(&mut head).is_ok() && head.starts_with(b"HTTP/1.1 200")
}

/// Remplace le contenu de la fenêtre par un message d'erreur lisible.
fn show_error(window: &WebviewWindow, message: &str, log: &Path) {
    let text = format!("{message} Le journal technique est ici : {}", log.display());
    let script = format!(
        "document.body.innerHTML = '';\
         const p = document.createElement('p');\
         p.style.cssText = 'font:15px system-ui,sans-serif;max-width:36rem;margin:20vh auto;padding:0 1rem;color:#b91c1c;line-height:1.5';\
         p.textContent = {};\
         document.body.appendChild(p);",
        serde_json_string(&text)
    );
    let _ = window.eval(&script);
}

/// Chaîne JavaScript littérale (échappement JSON minimal, sans dépendance).
fn serde_json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn start_server(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    let window = app
        .get_webview_window("main")
        .ok_or("fenêtre principale introuvable")?;

    let data_dir = app.path().app_data_dir()?;
    let log_dir = app.path().app_log_dir()?;
    let resources = app.path().resource_dir()?;
    fs::create_dir_all(&data_dir)?;
    fs::create_dir_all(&log_dir)?;
    let log_path = log_dir.join("server.log");

    let port = free_port()?;
    let path = |p: PathBuf| p.to_string_lossy().into_owned();
    let envs: HashMap<&str, String> = HashMap::from([
        ("GRAMMARIA_DESKTOP", "1".into()),
        // Le serveur s'arrête quand l'entrée standard (tube tenu par
        // l'application) se ferme : pas de processus orphelin après un plantage.
        ("GRAMMARIA_EXIT_WITH_PARENT", "1".into()),
        ("HOST", "127.0.0.1".into()),
        ("PORT", port.to_string()),
        ("GRAMMARIA_DIST_DIR", path(resources.join("dist"))),
        ("GRAMMARIA_LT_RESOURCES", path(resources.join("lt"))),
        ("JOURNAL_PATH", path(data_dir.join("grammaria.db"))),
        (
            "GRAMMARIA_SETTINGS_PATH",
            path(data_dir.join("settings.json")),
        ),
        (
            "GRAMMARIA_VALID_WORDS_PATH",
            path(data_dir.join("valid-words.json")),
        ),
        // Aucun LLM par défaut : l'utilisateur le choisit dans les réglages.
        // Le raisonnement du modèle reste coupé par défaut (LLM_DISABLE_THINKING
        // non défini) : le serveur relance sans ce paramètre si une API le refuse.
        ("LLM_TARGET", String::new()),
    ]);

    let (mut events, child) = handle
        .shell()
        .sidecar("grammaria-server")?
        .envs(envs)
        .spawn()?;
    app.manage(Sidecar(Mutex::new(Some(child))));

    // Sortie du serveur → server.log, pour le support.
    let log_for_events = log_path.clone();
    let window_for_events = window.clone();
    let app_for_events = handle.clone();
    tauri::async_runtime::spawn(async move {
        let mut log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_for_events)
            .ok();
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                    if let Some(file) = log.as_mut() {
                        let _ = file.write_all(&line);
                        if !line.ends_with(b"\n") {
                            let _ = file.write_all(b"\n");
                        }
                    }
                }
                CommandEvent::Terminated(status) => {
                    if let Some(file) = log.as_mut() {
                        let _ = writeln!(file, "[grammaria] serveur arrêté : {status:?}");
                    }
                    // Arrêt voulu (fermeture, mise à jour) : pas de message
                    // d'erreur par-dessus l'interface.
                    if server_running(&app_for_events) {
                        show_error(
                            &window_for_events,
                            "Le moteur de Grammaria s'est arrêté. Relancez l'application.",
                            &log_for_events,
                        );
                    }
                    break;
                }
                _ => {}
            }
        }
    });

    // Attente du serveur, puis affichage de son interface.
    std::thread::spawn(move || {
        let started = Instant::now();
        while started.elapsed() < STARTUP_TIMEOUT {
            if server_ready(port) {
                let url =
                    Url::parse(&format!("http://127.0.0.1:{port}/")).expect("URL locale valide");
                let _ = window.navigate(url);
                return;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        show_error(
            &window,
            "Le moteur de Grammaria n'a pas démarré à temps.",
            &log_path,
        );
    });

    Ok(())
}

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
        .plugin(tauri_plugin_shell::init())
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
        ])
        .setup(|app| {
            app.manage(update::UpdateState::new(app));
            start_server(app)
        })
        .build(tauri::generate_context!())
        .expect("impossible de démarrer Grammaria")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                stop_server(app);
            }
        });
}
