//! Autotest de l'application, pour la CI : lancée avec la variable
//! d'environnement `GRAMMARIA_AUTOTEST_OUT=<fichier>`, l'application exécute
//! dans sa vraie WebView la page d'autotest (`src/desktop/autotest.ts`), écrit
//! le JSON de résultats dans ce fichier et se ferme avec le code 0 (tous les
//! critères tenus) ou 1.
//!
//! Sans la variable, rien de tout cela n'est accessible :
//! - l'état `Autotest` n'est pas créé : les deux commandes répondent « inactif » ;
//! - aucune capability ne les autorise : la capability `autotest` n'existe pas
//!   dans `capabilities/` (seule `default` est active, voir tauri.conf.json) et
//!   n'est ajoutée qu'à l'exécution, en mode autotest ;
//! - le drapeau `window.__GRAMMARIA_AUTOTEST__` n'est posé que par le script
//!   d'initialisation de la fenêtre en mode autotest : sans lui, l'amorce ne
//!   charge même pas la page d'autotest.
//!
//! En mode autotest, les données (journal, réglages, mots valides) vont dans un
//! dossier neuf à côté du fichier de résultats, jamais dans celui de
//! l'utilisateur, et un délai maximal ferme l'application (code 1) si la page
//! ne rend pas ses résultats : une page blanche ne bloque pas la CI.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

/// Fichier de résultats : sa présence active l'autotest.
pub const VARIABLE_SORTIE: &str = "GRAMMARIA_AUTOTEST_OUT";
/// Adresse du faux serveur du modèle (défaut : `ADRESSE_MODELE`).
const VARIABLE_MODELE: &str = "GRAMMARIA_AUTOTEST_MODELE";
/// Délai maximal en secondes (défaut : `DELAI_DEFAUT`).
const VARIABLE_DELAI: &str = "GRAMMARIA_AUTOTEST_DELAI";

const ADRESSE_MODELE: &str = "http://127.0.0.1:31977";
/// Clé attendue par `scripts/desktop/faux-modele.mjs` (FAUX_MODELE_CLE).
const CLE_MODELE: &str = "sk-autotest-cle";
const DELAI_DEFAUT: Duration = Duration::from_secs(170);

/// Script d'initialisation de la fenêtre, en mode autotest seulement.
pub const SCRIPT_INITIALISATION: &str = "window.__GRAMMARIA_AUTOTEST__ = true;";

/// Capability ajoutée à l'exécution, en mode autotest seulement.
pub const CAPABILITY: &str = include_str!("../autotest/capability.json");

/// Mode autotest actif (géré par Tauri seulement dans ce cas).
pub struct Autotest {
    sortie: PathBuf,
    modele: String,
    delai: Duration,
    termine: AtomicBool,
}

#[derive(Serialize)]
pub struct Config {
    modele: String,
    cle: &'static str,
}

impl Autotest {
    /// Mode autotest demandé par l'environnement ; `None` sinon.
    pub fn depuis_env() -> Option<Self> {
        Self::depuis(|nom| std::env::var(nom).ok())
    }

    fn depuis(lire: impl Fn(&str) -> Option<String>) -> Option<Self> {
        let sortie = lire(VARIABLE_SORTIE).filter(|s| !s.trim().is_empty())?;
        let delai = lire(VARIABLE_DELAI)
            .and_then(|s| s.trim().parse::<u64>().ok())
            .filter(|&s| s > 0)
            .map_or(DELAI_DEFAUT, Duration::from_secs);
        Some(Self {
            sortie: PathBuf::from(sortie),
            modele: lire(VARIABLE_MODELE)
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| ADRESSE_MODELE.into()),
            delai,
            termine: AtomicBool::new(false),
        })
    }

    /// Dossier de données de l'autotest, neuf : `<sortie>.donnees/`.
    pub fn preparer_dossier_donnees(&self) -> std::io::Result<PathBuf> {
        let mut nom = self.sortie.as_os_str().to_owned();
        nom.push(".donnees");
        let dossier = PathBuf::from(nom);
        if dossier.exists() {
            fs::remove_dir_all(&dossier)?;
        }
        fs::create_dir_all(&dossier)?;
        Ok(dossier)
    }

    /// Écrit les résultats (fichier temporaire puis renommage) une seule fois.
    fn ecrire(&self, resultat: &Value) -> Result<bool, String> {
        if self.termine.swap(true, Ordering::SeqCst) {
            return Ok(false);
        }
        ecrire_json(&self.sortie, resultat).map_err(|e| e.to_string())?;
        Ok(true)
    }

    /// Ferme l'application en échec si la page n'a rien rendu à temps.
    pub fn surveiller(app: &AppHandle) {
        let app = app.clone();
        std::thread::spawn(move || {
            let Some(delai) = app.try_state::<Autotest>().map(|a| a.delai) else {
                return;
            };
            std::thread::sleep(delai);
            let autotest = app.state::<Autotest>();
            let resultat = json!({
                "version": 1,
                "termine": false,
                "reussi": false,
                "erreurs": [format!(
                    "La page n'a rendu aucun résultat en {} s (page blanche, script en échec ?).",
                    delai.as_secs()
                )],
            });
            if let Ok(true) = autotest.ecrire(&resultat) {
                app.exit(1);
            }
        });
    }
}

fn ecrire_json(chemin: &Path, valeur: &Value) -> std::io::Result<()> {
    if let Some(parent) = chemin.parent().filter(|p| !p.as_os_str().is_empty()) {
        fs::create_dir_all(parent)?;
    }
    let mut temporaire = chemin.as_os_str().to_owned();
    temporaire.push(".tmp");
    let temporaire = PathBuf::from(temporaire);
    let texte = serde_json::to_string_pretty(valeur).map_err(std::io::Error::other)?;
    fs::write(&temporaire, texte + "\n")?;
    fs::rename(&temporaire, chemin)
}

/// Configuration de l'autotest pour la page ; refusée hors de ce mode.
#[tauri::command]
pub fn autotest_config(app: AppHandle) -> Result<Config, String> {
    let autotest = app.try_state::<Autotest>().ok_or("Autotest inactif.")?;
    Ok(Config {
        modele: autotest.modele.clone(),
        cle: CLE_MODELE,
    })
}

/// Écrit les résultats et ferme l'application (0 : réussi, 1 : échec).
#[tauri::command]
pub fn autotest_terminer(app: AppHandle, resultat: Value, reussi: bool) -> Result<(), String> {
    let autotest = app.try_state::<Autotest>().ok_or("Autotest inactif.")?;
    if autotest.ecrire(&resultat)? {
        app.exit(if reussi { 0 } else { 1 });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(paires: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = paires
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |nom| map.get(nom).cloned()
    }

    #[test]
    fn sans_la_variable_l_autotest_est_inactif() {
        assert!(Autotest::depuis(env(&[])).is_none());
        assert!(Autotest::depuis(env(&[(VARIABLE_SORTIE, "  ")])).is_none());
        // Les autres variables seules ne suffisent pas.
        assert!(
            Autotest::depuis(env(&[(VARIABLE_MODELE, "http://x"), (VARIABLE_DELAI, "5")]))
                .is_none()
        );
    }

    #[test]
    fn la_variable_fixe_la_sortie_le_modele_et_le_delai() {
        let a = Autotest::depuis(env(&[(VARIABLE_SORTIE, "/tmp/a.json")])).unwrap();
        assert_eq!(a.sortie, PathBuf::from("/tmp/a.json"));
        assert_eq!(a.modele, ADRESSE_MODELE);
        assert_eq!(a.delai, DELAI_DEFAUT);
        let b = Autotest::depuis(env(&[
            (VARIABLE_SORTIE, "r.json"),
            (VARIABLE_MODELE, "http://127.0.0.1:4000"),
            (VARIABLE_DELAI, "30"),
        ]))
        .unwrap();
        assert_eq!(b.modele, "http://127.0.0.1:4000");
        assert_eq!(b.delai, Duration::from_secs(30));
    }

    #[test]
    fn les_donnees_vont_dans_un_dossier_neuf_a_cote_des_resultats() {
        let racine = tempfile::tempdir().unwrap();
        let sortie = racine.path().join("res").join("autotest.json");
        let a = Autotest::depuis(env(&[(VARIABLE_SORTIE, sortie.to_str().unwrap())])).unwrap();
        let dossier = a.preparer_dossier_donnees().unwrap();
        assert_eq!(
            dossier,
            racine.path().join("res").join("autotest.json.donnees")
        );
        fs::write(dossier.join("grammaria.db"), b"ancien").unwrap();
        let encore = a.preparer_dossier_donnees().unwrap();
        assert!(fs::read_dir(encore).unwrap().next().is_none());
    }

    #[test]
    fn les_resultats_ne_sont_ecrits_qu_une_fois() {
        let racine = tempfile::tempdir().unwrap();
        let sortie = racine.path().join("autotest.json");
        let a = Autotest::depuis(env(&[(VARIABLE_SORTIE, sortie.to_str().unwrap())])).unwrap();
        assert_eq!(a.ecrire(&json!({"reussi": true})), Ok(true));
        assert_eq!(a.ecrire(&json!({"reussi": false})), Ok(false));
        let lu: Value = serde_json::from_str(&fs::read_to_string(&sortie).unwrap()).unwrap();
        assert_eq!(lu["reussi"], true);
    }

    /// La capability d'autotest : seulement les deux commandes d'autotest,
    /// fenêtre `main`, page locale.
    #[test]
    fn la_capability_d_autotest_n_autorise_que_ses_deux_commandes() {
        let capability: Value = serde_json::from_str(CAPABILITY).unwrap();
        assert_eq!(capability["identifier"], "autotest");
        assert_eq!(capability["windows"], json!(["main"]));
        assert!(capability.get("remote").is_none());
        assert_eq!(
            capability["permissions"],
            json!(["allow-autotest-config", "allow-autotest-terminer"])
        );
    }
}
