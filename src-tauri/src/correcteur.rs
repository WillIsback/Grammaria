//! Correcteur grammatical : le moteur Rust grammaria-rc (règles françaises de
//! LanguageTool réimplémentées en natif), lié à l'application.
//!
//! Version expérimentale : remplace le portage JavaScript de LanguageTool, qui
//! tournait dans un Worker de la WebView avec une archive de règles. Ici, la
//! page appelle deux commandes :
//!
//! - `correcteur_prechauffer` charge les données (lexique, règles) une fois,
//!   pendant que l'utilisateur tape, et rend les mesures du chargement ;
//! - `correcteur_controler` rend les détections d'un texte, au format de la
//!   réponse de POST /api/check (tableau `matches`, positions en unités
//!   UTF-16 comme en JavaScript).
//!
//! Les données (`fr.lex`, `fr.words`, `fr.rules`, `fr.disambig.xml`) sont des
//! ressources de l'application (`bundle.resources` de tauri.conf.json, dossier
//! `moteur/`), produites par `scripts/moteur/construire.sh`.
//!
//! Le chargement et chaque contrôle tournent hors du fil principal
//! (`spawn_blocking`) : la fenêtre reste fluide. Un chargement en échec (données
//! absentes ou abîmées) est retenté à la demande suivante.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use grammaria_rc::api::{Engine, OffsetUnit};
use serde::Serialize;
use serde_json::value::RawValue;
use tauri::State;

use crate::logs;

/// Dossier des données du moteur dans les ressources de l'application.
pub const DOSSIER_RESSOURCES: &str = "moteur";

/// Fichiers attendus dans le dossier des données.
const FICHIERS: [&str; 4] = ["fr.lex", "fr.words", "fr.rules", "fr.disambig.xml"];

/// Longueur maximale d'un texte, en unités UTF-16 (`MAX_ANALYZE_LENGTH` du
/// gestionnaire d'API, api/handler.ts).
const LONGUEUR_MAX: usize = 20_000;

/// Mesures du chargement des données, rendues à la page (journal technique,
/// autotest).
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MesuresChargement {
    /// Taille des données du moteur sur le disque.
    pub donnees_octets: u64,
    /// Durée du chargement (lexique, listes de mots, règles).
    pub chargement_ms: f64,
}

struct Charge {
    moteur: Arc<Engine>,
    mesures: MesuresChargement,
}

struct Interne {
    dossier: PathBuf,
    /// Verrou tenu pendant le chargement : les demandes concurrentes attendent
    /// le même chargement au lieu d'en lancer un second.
    charge: Mutex<Option<Charge>>,
}

/// État géré par Tauri (`app.manage`).
pub struct Correcteur {
    interne: Arc<Interne>,
}

impl Correcteur {
    pub fn new(dossier: PathBuf) -> Self {
        Self {
            interne: Arc::new(Interne {
                dossier,
                charge: Mutex::new(None),
            }),
        }
    }
}

impl Interne {
    /// Le moteur, chargé au premier appel.
    fn moteur(&self) -> Result<(Arc<Engine>, MesuresChargement), String> {
        // Un panic pendant un chargement précédent n'a rien laissé d'incohérent :
        // `charge` est resté à `None`.
        let mut charge = self.charge.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(charge) = charge.as_ref() {
            return Ok((charge.moteur.clone(), charge.mesures));
        }
        let debut = Instant::now();
        let donnees_octets = taille_donnees(&self.dossier)?;
        let moteur = Engine::load(&self.dossier).map_err(|e| {
            format!("Le correcteur grammatical n'a pas pu charger ses données : {e}")
        })?;
        let mesures = MesuresChargement {
            donnees_octets,
            chargement_ms: debut.elapsed().as_secs_f64() * 1000.0,
        };
        logs::ecrire(
            logs::Niveau::Info,
            "correcteur",
            &format!(
                "Moteur chargé en {:.0} ms ({} octets de données).",
                mesures.chargement_ms, mesures.donnees_octets
            ),
        );
        let moteur = Arc::new(moteur);
        *charge = Some(Charge {
            moteur: moteur.clone(),
            mesures,
        });
        Ok((moteur, mesures))
    }
}

/// Taille totale des données ; erreur lisible si un fichier manque.
fn taille_donnees(dossier: &Path) -> Result<u64, String> {
    let mut total = 0;
    for nom in FICHIERS {
        let meta = std::fs::metadata(dossier.join(nom)).map_err(|_| {
            format!(
                "Le correcteur grammatical n'a pas pu charger ses données : \
                 fichier {nom} introuvable. Réinstallez Grammaria."
            )
        })?;
        total += meta.len();
    }
    Ok(total)
}

/// Détections de `texte`, en JSON (tableau `matches`).
fn controler(interne: &Interne, texte: &str) -> Result<String, String> {
    if texte.encode_utf16().count() > LONGUEUR_MAX {
        return Err("Texte trop long pour le correcteur grammatical.".into());
    }
    let (moteur, _) = interne.moteur()?;
    Ok(moteur.check_json(texte, false, OffsetUnit::Utf16))
}

/// Exécute `tache` hors du fil principal ; un panic du moteur devient une erreur.
async fn hors_fil<T: Send + 'static>(
    interne: Arc<Interne>,
    tache: impl FnOnce(&Interne) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || tache(&interne))
        .await
        .map_err(|_| "Le correcteur grammatical s'est arrêté pendant l'analyse.".to_string())?
}

/// Charge le moteur (sans effet s'il l'est déjà) et rend les mesures du chargement.
#[tauri::command]
pub async fn correcteur_prechauffer(
    etat: State<'_, Correcteur>,
) -> Result<MesuresChargement, String> {
    hors_fil(etat.interne.clone(), |interne| {
        interne.moteur().map(|(_, mesures)| mesures)
    })
    .await
}

/// Détections de `texte` au format de POST /api/check.
#[tauri::command]
pub async fn correcteur_controler(
    etat: State<'_, Correcteur>,
    texte: String,
) -> Result<Box<RawValue>, String> {
    let json = hors_fil(etat.interne.clone(), move |interne| {
        controler(interne, &texte)
    })
    .await?;
    RawValue::from_string(json).map_err(|e| format!("Réponse du correcteur illisible : {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Données du moteur : `moteur/data` du dépôt (scripts/moteur/construire.sh),
    /// ou GRAMMARIA_MOTEUR_DONNEES. Absentes : les tests du moteur sont sautés.
    fn donnees() -> Option<PathBuf> {
        let dossier = std::env::var_os("GRAMMARIA_MOTEUR_DONNEES")
            .map(PathBuf::from)
            .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../moteur/data"));
        FICHIERS
            .iter()
            .all(|f| dossier.join(f).exists())
            .then_some(dossier)
    }

    #[test]
    fn donnees_absentes_message_lisible_et_nouvel_essai() {
        let vide = tempfile::tempdir().unwrap();
        let interne = Interne {
            dossier: vide.path().to_path_buf(),
            charge: Mutex::new(None),
        };
        let erreur = controler(&interne, "Bonjour.").unwrap_err();
        assert!(erreur.contains("fr.lex introuvable"), "{erreur}");
        // Rien n'est retenu : la demande suivante retente le chargement.
        assert!(interne.charge.lock().unwrap().is_none());
        assert!(controler(&interne, "Bonjour.").is_err());
    }

    #[test]
    fn texte_trop_long_refuse_sans_charger_le_moteur() {
        let vide = tempfile::tempdir().unwrap();
        let interne = Interne {
            dossier: vide.path().to_path_buf(),
            charge: Mutex::new(None),
        };
        let erreur = controler(&interne, &"a".repeat(LONGUEUR_MAX + 1)).unwrap_err();
        assert!(erreur.contains("trop long"), "{erreur}");
    }

    #[test]
    fn detections_au_format_de_l_api_positions_utf16() {
        let Some(dossier) = donnees() else {
            eprintln!("données du moteur absentes : test sauté");
            return;
        };
        let interne = Interne {
            dossier,
            charge: Mutex::new(None),
        };
        // « 😀 » compte pour deux unités UTF-16, « é » pour une.
        let texte = "Génial 😀 ! Je mange un pomme.";
        let json = controler(&interne, texte).unwrap();
        let matches: serde_json::Value = serde_json::from_str(&json).unwrap();
        let accord = matches
            .as_array()
            .unwrap()
            .iter()
            .find(|m| {
                let debut = m["offset"].as_u64().unwrap() as usize;
                let longueur = m["length"].as_u64().unwrap() as usize;
                let unites: Vec<u16> = texte.encode_utf16().collect();
                String::from_utf16_lossy(&unites[debut..debut + longueur]).contains("pomme")
            })
            .unwrap_or_else(|| panic!("« un pomme » non détecté : {json}"));
        assert!(accord["rule"]["id"].is_string());
        assert!(accord["replacements"].is_array());

        // Second appel : le moteur chargé est réutilisé.
        let (_, mesures) = interne.moteur().unwrap();
        assert!(mesures.donnees_octets > 1_000_000);
        assert_eq!(controler(&interne, "").unwrap(), "[]");
    }
}
