//! Journal technique de l'application : `grammaria.log`, pour le support.
//!
//! Le fichier est dans le dossier de journaux de l'application (`app_log_dir` :
//! `%LOCALAPPDATA%\fr.willisback.grammaria\logs\` sous Windows,
//! `~/.local/share/fr.willisback.grammaria/logs/` sous Linux), là où l'ancienne
//! version écrivait `server.log`. Il reçoit le démarrage (version, système), les
//! erreurs des commandes (base, réglages, relais du modèle), les étapes de la mise
//! à jour et les messages de la page (`log_page` : erreurs JavaScript, correcteur,
//! ligne de fin de correction).
//!
//! Ce qui n'y entre JAMAIS : la clé API, les en-têtes d'authentification, le texte
//! de l'utilisateur ni le contenu des corrections. Les appelants n'écrivent que des
//! statuts, des durées et des messages d'erreur ; chaque ligne passe en plus par
//! `masquer`, qui remplace la clé connue et tout ce qui ressemble à un secret.
//!
//! Rotation simple : au-delà de `TAILLE_MAX` octets, le fichier devient
//! `grammaria.log.1` (le précédent `.1` est remplacé) et un nouveau commence.
//! Bibliothèque standard seulement : `tauri-plugin-log` apporterait `log`, `fern`,
//! une API JavaScript et des permissions de plugin, sans borner le débit de la page.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use regex::Regex;
use tauri::State;

use crate::store::Store;

/// Nom du fichier, dans le dossier de journaux.
pub const FICHIER: &str = "grammaria.log";
/// Taille au-delà de laquelle le fichier est remplacé (1 Mio, `.1` compris : 2 Mio).
const TAILLE_MAX: u64 = 1024 * 1024;
/// Message d'une commande Rust conservé (caractères).
const MESSAGE_MAX: usize = 1_000;
/// Message de la page conservé (caractères).
const MESSAGE_PAGE_MAX: usize = 2_000;
/// Débit de la page : réserve de messages, et délai pour en regagner un. Les
/// erreurs de commandes ont leur propre réserve, aux mêmes valeurs.
const RESERVE_PAGE: u32 = 20;
const RECHARGE_PAGE: Duration = Duration::from_secs(2);
/// Une erreur de commande identique à la précédente n'est pas réécrite mais
/// comptée ; le décompte (« … répété N fois ») est écrit à la ligne suivante,
/// à la fermeture, ou si elle revient après ce délai.
const REGROUPEMENT: Duration = Duration::from_secs(60);

/// Gravité d'une ligne.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Niveau {
    Info,
    Avertissement,
    Erreur,
}

impl Niveau {
    fn etiquette(self) -> &'static str {
        match self {
            Niveau::Info => "INFO",
            Niveau::Avertissement => "AVERT",
            Niveau::Erreur => "ERREUR",
        }
    }

    fn depuis_page(niveau: &str) -> Option<Self> {
        match niveau {
            "info" => Some(Niveau::Info),
            "avertissement" => Some(Niveau::Avertissement),
            "erreur" => Some(Niveau::Erreur),
            _ => None,
        }
    }
}

/// Réserve de messages de la page (seau à jetons).
struct Debit {
    jetons: u32,
    depuis: Instant,
    ignores: u64,
}

impl Debit {
    fn new(maintenant: Instant) -> Self {
        Debit {
            jetons: RESERVE_PAGE,
            depuis: maintenant,
            ignores: 0,
        }
    }

    /// Vrai si un message peut être écrit maintenant (un jeton est pris).
    fn prendre(&mut self, maintenant: Instant) -> bool {
        let regagnes = maintenant
            .saturating_duration_since(self.depuis)
            .as_millis()
            / RECHARGE_PAGE.as_millis();
        if regagnes > 0 {
            let regagnes = u32::try_from(regagnes).unwrap_or(u32::MAX);
            self.jetons = self.jetons.saturating_add(regagnes).min(RESERVE_PAGE);
            self.depuis = maintenant;
        }
        if self.jetons == 0 {
            self.ignores += 1;
            return false;
        }
        self.jetons -= 1;
        true
    }
}

/// Dernière erreur de commande écrite, et ses répétitions depuis.
struct Repetition {
    niveau: Niveau,
    source: String,
    texte: String,
    compte: u64,
    depuis: Instant,
}

struct Etat {
    fichier: Option<File>,
    taille: u64,
    debit: Debit,
    debit_commandes: Debit,
    derniere: Option<Repetition>,
}

/// Le journal technique : un fichier, sa rotation et le débit de la page.
pub struct Journal {
    chemin: PathBuf,
    taille_max: u64,
    etat: Mutex<Etat>,
}

impl Journal {
    /// Journal `grammaria.log` dans `dossier` (créé au besoin). Ne lève jamais
    /// d'erreur : sans fichier accessible, les lignes sont simplement perdues.
    pub fn new(dossier: &Path) -> Self {
        Self::avec_taille(dossier, TAILLE_MAX)
    }

    fn avec_taille(dossier: &Path, taille_max: u64) -> Self {
        let chemin = dossier.join(FICHIER);
        let _ = fs::create_dir_all(dossier);
        let (fichier, taille) = ouvrir(&chemin);
        Journal {
            chemin,
            taille_max,
            etat: Mutex::new(Etat {
                fichier,
                taille,
                debit: Debit::new(Instant::now()),
                debit_commandes: Debit::new(Instant::now()),
                derniere: None,
            }),
        }
    }

    #[cfg(test)]
    fn chemin(&self) -> &Path {
        &self.chemin
    }

    /// Écrit une ligne, masquée (`masquer`) et tronquée à `MESSAGE_MAX` caractères.
    pub fn ecrire(&self, niveau: Niveau, source: &str, message: &str, secrets: &[&str]) {
        self.ecrire_borne(niveau, source, message, secrets, MESSAGE_MAX);
    }

    fn ecrire_borne(
        &self,
        niveau: Niveau,
        source: &str,
        message: &str,
        secrets: &[&str],
        max: usize,
    ) {
        let ligne = format!(
            "{} {} [{}] {}\n",
            horodatage(SystemTime::now()),
            niveau.etiquette(),
            source,
            tronquer(&masquer(message, secrets), max)
        );
        let mut etat = self.etat.lock().unwrap_or_else(|p| p.into_inner());
        self.vider_repetition(&mut etat);
        self.ajouter(&mut etat, &ligne);
    }

    /// Erreur d'une commande : débit limité (réserve propre), et une erreur
    /// identique à la précédente est comptée au lieu d'être réécrite. Une
    /// rafale (page qui boucle sur une commande en échec) ne fait donc pas
    /// tourner le fichier et n'efface pas les lignes utiles. Renvoie faux si
    /// rien n'a été écrit.
    fn ecrire_commande(
        &self,
        niveau: Niveau,
        source: &str,
        message: &str,
        secrets: &[&str],
        maintenant: Instant,
    ) -> bool {
        let texte = tronquer(&masquer(message, secrets), MESSAGE_MAX);
        let mut etat = self.etat.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(derniere) = etat.derniere.as_mut() {
            if derniere.source == source
                && derniere.texte == texte
                && maintenant.saturating_duration_since(derniere.depuis) < REGROUPEMENT
            {
                derniere.compte += 1;
                return false;
            }
        }
        self.vider_repetition(&mut etat);
        let ignores_avant = etat.debit_commandes.ignores;
        if !etat.debit_commandes.prendre(maintenant) {
            return false;
        }
        let horodatage = horodatage(SystemTime::now());
        if ignores_avant > 0 {
            etat.debit_commandes.ignores = 0;
            let ligne = format!(
                "{horodatage} AVERT [commandes] {ignores_avant} erreur(s) de commande ignorée(s) : débit dépassé.\n"
            );
            self.ajouter(&mut etat, &ligne);
        }
        let ligne = format!("{horodatage} {} [{source}] {texte}\n", niveau.etiquette());
        self.ajouter(&mut etat, &ligne);
        etat.derniere = Some(Repetition {
            niveau,
            source: source.to_string(),
            texte,
            compte: 0,
            depuis: maintenant,
        });
        true
    }

    /// Écrit le décompte des répétitions de la dernière erreur de commande.
    fn vider_repetition(&self, etat: &mut Etat) {
        let Some(derniere) = etat.derniere.take() else {
            return;
        };
        if derniere.compte > 0 {
            let ligne = format!(
                "{} {} [{}] … répété {} fois.\n",
                horodatage(SystemTime::now()),
                derniere.niveau.etiquette(),
                derniere.source,
                derniere.compte
            );
            self.ajouter(etat, &ligne);
        }
    }

    /// Écrit ce qui reste en attente (décompte des répétitions), à la fermeture.
    pub fn vider(&self) {
        let mut etat = self.etat.lock().unwrap_or_else(|p| p.into_inner());
        self.vider_repetition(&mut etat);
    }

    /// Message de la page : niveau connu, débit limité, taille bornée. Renvoie
    /// faux si le message a été ignoré (débit dépassé).
    fn ecrire_page(
        &self,
        niveau: Niveau,
        message: &str,
        secrets: &[&str],
        maintenant: Instant,
    ) -> bool {
        let mut etat = self.etat.lock().unwrap_or_else(|p| p.into_inner());
        self.vider_repetition(&mut etat);
        let ignores_avant = etat.debit.ignores;
        if !etat.debit.prendre(maintenant) {
            return false;
        }
        let horodatage = horodatage(SystemTime::now());
        if ignores_avant > 0 {
            etat.debit.ignores = 0;
            let ligne = format!(
                "{horodatage} AVERT [page] {ignores_avant} message(s) de la page ignoré(s) : débit dépassé.\n"
            );
            self.ajouter(&mut etat, &ligne);
        }
        let ligne = format!(
            "{horodatage} {} [page] {}\n",
            niveau.etiquette(),
            tronquer(&masquer(message, secrets), MESSAGE_PAGE_MAX)
        );
        self.ajouter(&mut etat, &ligne);
        true
    }

    /// Ajoute la ligne, après rotation si elle ferait dépasser la taille maximale.
    fn ajouter(&self, etat: &mut Etat, ligne: &str) {
        let octets = ligne.len() as u64;
        if etat.taille > 0 && etat.taille + octets > self.taille_max {
            etat.fichier = None;
            let precedent = self.chemin.with_extension("log.1");
            // Sous Windows, `rename` refuse de remplacer un fichier existant.
            let _ = fs::remove_file(&precedent);
            let _ = fs::rename(&self.chemin, &precedent);
            // Si le fichier n'a pas pu être déplacé, il est vidé : la taille reste bornée.
            etat.fichier = OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(&self.chemin)
                .ok();
            etat.taille = 0;
        }
        if etat.fichier.is_none() {
            (etat.fichier, etat.taille) = ouvrir(&self.chemin);
        }
        if let Some(fichier) = etat.fichier.as_mut() {
            if fichier.write_all(ligne.as_bytes()).is_ok() {
                etat.taille += octets;
            }
        }
    }
}

fn ouvrir(chemin: &Path) -> (Option<File>, u64) {
    match OpenOptions::new().create(true).append(true).open(chemin) {
        Ok(fichier) => {
            let taille = fichier.metadata().map_or(0, |m| m.len());
            (Some(fichier), taille)
        }
        Err(_) => (None, 0),
    }
}

/// Coupe à `max` caractères, sur une seule ligne (fins de ligne et caractères de
/// contrôle remplacés) : une ligne du fichier est une entrée du journal.
fn tronquer(message: &str, max: usize) -> String {
    let mut sortie = String::with_capacity(message.len().min(max * 4));
    for (index, c) in message.trim().chars().enumerate() {
        if index == max {
            sortie.push('…');
            break;
        }
        match c {
            '\n' => sortie.push_str(" | "),
            c if c.is_control() => sortie.push(' '),
            c => sortie.push(c),
        }
    }
    sortie
}

fn motifs_secrets() -> &'static [(Regex, &'static str)] {
    static MOTIFS: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    MOTIFS.get_or_init(|| {
        let motif = |re: &str| Regex::new(re).expect("motif valide");
        vec![
            // En-tête ou valeur « Bearer … » / « Basic … ».
            (motif(r"(?i)\b(bearer|basic)\s+[^\s,;]+"), "$1 [masqué]"),
            // `Authorization: …`, `api_key=…`, `"token": "…"`, `password=…`.
            (
                motif(
                    r#"(?i)\b(authorization|proxy-authorization|x-api-key|api[-_]?key|access[-_]?token|token|secret|password)(["']?\s*[:=]\s*["']?)[^\s"',;}]+"#,
                ),
                "$1$2[masqué]",
            ),
            // Clés au format OpenAI et compatibles (sk-…, sk-proj-…).
            (motif(r"\bsk-[A-Za-z0-9_\-]{6,}"), "[clé masquée]"),
            // Identifiants dans une adresse : http://utilisateur:mot-de-passe@hôte.
            (motif(r"(?i)\b(https?://)[^/\s:@]+:[^/\s@]+@"), "$1[masqué]@"),
        ]
    })
}

/// Remplace les secrets connus (la clé API des réglages) et tout ce qui
/// ressemble à un secret : `Bearer …`, `Authorization: …`, `api_key=…`, `sk-…`,
/// identifiants dans une adresse.
pub fn masquer(message: &str, secrets: &[&str]) -> String {
    let mut sortie = message.to_string();
    for secret in secrets {
        let secret = secret.trim();
        // Une « clé » d'un ou deux caractères masquerait n'importe quoi.
        if secret.chars().count() >= 4 {
            sortie = sortie.replace(secret, "[clé masquée]");
        }
    }
    for (motif, remplacement) in motifs_secrets() {
        sortie = motif.replace_all(&sortie, *remplacement).into_owned();
    }
    sortie
}

/// Date et heure UTC au format ISO 8601, à la milliseconde.
fn horodatage(instant: SystemTime) -> String {
    let duree = instant.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secondes = duree.as_secs();
    let (jours, reste) = (secondes / 86_400, secondes % 86_400);
    // Jours depuis 1970 → date civile (algorithme de H. Hinnant).
    let z = jours as i64 + 719_468;
    let ere = z.div_euclid(146_097);
    let jour_ere = z.rem_euclid(146_097);
    let annee_ere = (jour_ere - jour_ere / 1_460 + jour_ere / 36_524 - jour_ere / 146_096) / 365;
    let jour_annee = jour_ere - (365 * annee_ere + annee_ere / 4 - annee_ere / 100);
    let mp = (5 * jour_annee + 2) / 153;
    let jour = jour_annee - (153 * mp + 2) / 5 + 1;
    let mois = if mp < 10 { mp + 3 } else { mp - 9 };
    let annee = annee_ere + ere * 400 + i64::from(mois <= 2);
    format!(
        "{annee:04}-{mois:02}-{jour:02}T{:02}:{:02}:{:02}.{:03}Z",
        reste / 3_600,
        reste % 3_600 / 60,
        reste % 60,
        duree.subsec_millis()
    )
}

static JOURNAL: OnceLock<Journal> = OnceLock::new();

/// Ouvre le journal de l'application (une seule fois) et y note le démarrage.
pub fn initialiser(dossier: &Path, version: &str) -> &'static Journal {
    let journal = JOURNAL.get_or_init(|| Journal::new(dossier));
    journal.ecrire(
        Niveau::Info,
        "application",
        &format!("Démarrage de Grammaria {version} ({}).", systeme()),
        &[],
    );
    journal
}

/// Système, architecture et, sous Linux, nom de la distribution.
fn systeme() -> String {
    let mut texte = format!("{} {}", std::env::consts::OS, std::env::consts::ARCH);
    if cfg!(target_os = "linux") {
        let distribution = fs::read_to_string("/etc/os-release")
            .ok()
            .and_then(|contenu| {
                contenu.lines().find_map(|ligne| {
                    ligne
                        .strip_prefix("PRETTY_NAME=")
                        .map(|v| v.trim_matches('"').to_string())
                })
            });
        if let Some(distribution) = distribution {
            texte.push_str(", ");
            texte.push_str(&distribution);
        }
    }
    texte
}

/// Écrit dans le journal de l'application ; sans effet avant `initialiser`
/// (tests unitaires des autres modules).
pub fn ecrire(niveau: Niveau, source: &str, message: &str) {
    ecrire_masque(niveau, source, message, &[]);
}

/// Même chose, en masquant aussi `secrets` (la clé API, par exemple).
pub fn ecrire_masque(niveau: Niveau, source: &str, message: &str, secrets: &[&str]) {
    if let Some(journal) = JOURNAL.get() {
        journal.ecrire(niveau, source, message, secrets);
    }
}

/// Erreur d'une commande. Un conflit du journal (`Conflit : …`, modification
/// concurrente détectée et rejouée par la page) n'est qu'un avertissement.
/// Débit limité et répétitions regroupées (voir `Journal::ecrire_commande`).
pub fn echec_commande(commande: &str, message: &str) {
    let niveau = if message.starts_with("Conflit") {
        Niveau::Avertissement
    } else {
        Niveau::Erreur
    };
    commande_masquee(niveau, commande, message, &[]);
}

/// Ligne due à une commande appelée par la page (erreur du relais du modèle,
/// par exemple) : même débit limité et même regroupement des répétitions que
/// `echec_commande`, en masquant aussi `secrets`.
pub fn commande_masquee(niveau: Niveau, commande: &str, message: &str, secrets: &[&str]) {
    if let Some(journal) = JOURNAL.get() {
        journal.ecrire_commande(niveau, commande, message, secrets, Instant::now());
    }
}

/// Écrit ce qui est en attente (décompte des répétitions) ; à la fermeture.
pub fn vider() {
    if let Some(journal) = JOURNAL.get() {
        journal.vider();
    }
}

/// Message de la page (erreur JavaScript, correcteur, fin de correction).
/// Débit limité et taille bornée ; la clé API des réglages est masquée.
#[tauri::command]
pub async fn log_page(
    store: State<'_, Store>,
    niveau: String,
    message: String,
) -> Result<(), String> {
    let niveau = Niveau::depuis_page(&niveau).ok_or("Niveau de journal inconnu.")?;
    let Some(journal) = JOURNAL.get() else {
        return Ok(());
    };
    // Clé du fichier ou déjà lue dans le trousseau : la page ne peut en
    // connaître aucune autre, et le trousseau n'est pas interrogé ici.
    let cle = store.cle_connue();
    journal.ecrire_page(niveau, &message, &[&cle], Instant::now());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lire(journal: &Journal) -> String {
        fs::read_to_string(journal.chemin()).unwrap_or_default()
    }

    #[test]
    fn le_fichier_est_cree_et_reprend_le_contenu_existant() {
        let dossier = tempfile::tempdir().unwrap();
        let sous_dossier = dossier.path().join("logs");
        let journal = Journal::new(&sous_dossier);
        journal.ecrire(Niveau::Info, "application", "Démarrage.", &[]);
        drop(journal);
        let journal = Journal::new(&sous_dossier);
        journal.ecrire(Niveau::Erreur, "db_read", "base verrouillée", &[]);
        let contenu = lire(&journal);
        let lignes: Vec<&str> = contenu.lines().collect();
        assert_eq!(lignes.len(), 2);
        assert!(lignes[0].ends_with(" INFO [application] Démarrage."));
        assert!(lignes[1].ends_with(" ERREUR [db_read] base verrouillée"));
        assert_eq!(sous_dossier.join(FICHIER), journal.chemin());
    }

    #[test]
    fn la_rotation_garde_un_seul_fichier_precedent() {
        let dossier = tempfile::tempdir().unwrap();
        let journal = Journal::avec_taille(dossier.path(), 200);
        for numero in 0..20 {
            journal.ecrire(
                Niveau::Info,
                "test",
                &format!("ligne {numero:02} {}", "x".repeat(40)),
                &[],
            );
        }
        let courant = fs::metadata(journal.chemin()).unwrap().len();
        let precedent_chemin = dossier.path().join("grammaria.log.1");
        let precedent = fs::read_to_string(&precedent_chemin).unwrap();
        assert!(courant <= 200, "{courant}");
        assert!(precedent.len() <= 200, "{}", precedent.len());
        // Seuls le fichier courant et `.1` existent ; la dernière ligne est dans le courant.
        let noms: Vec<String> = fs::read_dir(dossier.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(noms.len(), 2, "{noms:?}");
        assert!(lire(&journal).contains("ligne 19"));
        assert!(!precedent.contains("ligne 19"));
        assert!(!lire(&journal).contains("ligne 00") && !precedent.contains("ligne 00"));
    }

    #[test]
    fn un_message_est_borne_et_tient_sur_une_ligne() {
        let dossier = tempfile::tempdir().unwrap();
        let journal = Journal::new(dossier.path());
        journal.ecrire(
            Niveau::Erreur,
            "test",
            &format!("a\nb\r\tc{}", "é".repeat(5_000)),
            &[],
        );
        let contenu = lire(&journal);
        assert_eq!(contenu.lines().count(), 1);
        assert!(contenu.contains("a | b  c"));
        assert!(contenu.trim_end().ends_with('…'));
        assert!(contenu.chars().filter(|c| *c == 'é').count() <= MESSAGE_MAX);

        let maintenant = Instant::now();
        assert!(journal.ecrire_page(Niveau::Erreur, &"x".repeat(100_000), &[], maintenant));
        let page = lire(&journal).lines().last().unwrap().to_string();
        assert!(page.chars().filter(|c| *c == 'x').count() == MESSAGE_PAGE_MAX);
    }

    #[test]
    fn le_debit_de_la_page_est_limite_puis_repart() {
        let dossier = tempfile::tempdir().unwrap();
        let journal = Journal::new(dossier.path());
        let debut = Instant::now();
        let ecrits = (0..100)
            .filter(|n| journal.ecrire_page(Niveau::Erreur, &format!("erreur {n}"), &[], debut))
            .count();
        assert_eq!(ecrits, RESERVE_PAGE as usize);
        // Plus tard, un jeton est revenu : le message passe, précédé du décompte des ignorés.
        assert!(journal.ecrire_page(Niveau::Info, "reprise", &[], debut + RECHARGE_PAGE));
        let contenu = lire(&journal);
        assert!(contenu.contains("80 message(s) de la page ignoré(s)"));
        assert!(contenu.trim_end().ends_with("INFO [page] reprise"));
        assert_eq!(contenu.lines().count(), RESERVE_PAGE as usize + 2);
    }

    #[test]
    fn une_rafale_d_erreurs_identiques_est_regroupee() {
        let dossier = tempfile::tempdir().unwrap();
        let journal = Journal::new(dossier.path());
        let debut = Instant::now();
        journal.ecrire(Niveau::Info, "application", "Démarrage.", &[]);
        for n in 0..1_000 {
            let ecrit = journal.ecrire_commande(
                Niveau::Erreur,
                "db_read",
                "base verrouillée",
                &[],
                debut + Duration::from_millis(n),
            );
            assert_eq!(ecrit, n == 0);
        }
        // Une autre erreur : le décompte de la précédente, puis elle.
        assert!(journal.ecrire_commande(
            Niveau::Erreur,
            "db_batch",
            "disque plein",
            &[],
            debut + Duration::from_secs(2)
        ));
        let contenu = lire(&journal);
        let lignes: Vec<&str> = contenu.lines().collect();
        assert_eq!(lignes.len(), 4, "{contenu}");
        assert!(lignes[0].ends_with("INFO [application] Démarrage."));
        assert!(lignes[1].ends_with("ERREUR [db_read] base verrouillée"));
        assert!(lignes[2].ends_with("ERREUR [db_read] … répété 999 fois."));
        assert!(lignes[3].ends_with("ERREUR [db_batch] disque plein"));

        // Répétée, puis une ligne ordinaire : le décompte passe avant elle.
        journal.ecrire_commande(
            Niveau::Erreur,
            "db_batch",
            "disque plein",
            &[],
            debut + Duration::from_secs(3),
        );
        journal.ecrire(Niveau::Info, "mise à jour", "Recherche.", &[]);
        let contenu = lire(&journal);
        let fin: Vec<&str> = contenu.lines().rev().take(2).collect();
        assert!(fin[1].ends_with("ERREUR [db_batch] … répété 1 fois."));
        assert!(fin[0].ends_with("INFO [mise à jour] Recherche."));

        // Au-delà du délai de regroupement, la même erreur est réécrite.
        let plus_tard = debut + Duration::from_secs(10);
        assert!(journal.ecrire_commande(Niveau::Erreur, "db_read", "x", &[], plus_tard));
        assert!(!journal.ecrire_commande(Niveau::Erreur, "db_read", "x", &[], plus_tard));
        assert!(journal.ecrire_commande(
            Niveau::Erreur,
            "db_read",
            "x",
            &[],
            plus_tard + REGROUPEMENT
        ));
        assert!(lire(&journal).contains("[db_read] … répété 1 fois."));
        // À la fermeture, le décompte en attente est écrit.
        journal.ecrire_commande(
            Niveau::Erreur,
            "db_read",
            "x",
            &[],
            plus_tard + REGROUPEMENT,
        );
        journal.vider();
        assert!(lire(&journal)
            .trim_end()
            .ends_with("[db_read] … répété 1 fois."));
    }

    #[test]
    fn le_debit_des_erreurs_de_commandes_est_limite() {
        let dossier = tempfile::tempdir().unwrap();
        let journal = Journal::new(dossier.path());
        let debut = Instant::now();
        let ecrites = (0..100)
            .filter(|n| {
                journal.ecrire_commande(
                    Niveau::Erreur,
                    "db_read",
                    &format!("erreur {n}"),
                    &["secret-123"],
                    debut,
                )
            })
            .count();
        assert_eq!(ecrites, RESERVE_PAGE as usize);
        // La réserve de la page est distincte : ses messages passent encore.
        assert!(journal.ecrire_page(Niveau::Erreur, "page", &[], debut));
        assert!(journal.ecrire_commande(
            Niveau::Erreur,
            "db_read",
            "reprise secret-123",
            &["secret-123"],
            debut + RECHARGE_PAGE
        ));
        let contenu = lire(&journal);
        assert!(contenu.contains("80 erreur(s) de commande ignorée(s) : débit dépassé."));
        assert!(contenu
            .trim_end()
            .ends_with("[db_read] reprise [clé masquée]"));
        assert!(!contenu.contains("secret-123"));
        // Le fichier reste petit : la rafale ne l'a pas fait tourner.
        assert!(!dossier.path().join("grammaria.log.1").exists());
    }

    #[test]
    fn aucune_cle_ni_en_tete_sensible_n_est_ecrit() {
        let dossier = tempfile::tempdir().unwrap();
        let journal = Journal::new(dossier.path());
        let cle = "ma-cle-perso-123456";
        journal.ecrire(
            Niveau::Erreur,
            "llm_chat",
            &format!("HTTP 401 : clé {cle} refusée ; Authorization: Bearer {cle}"),
            &[cle],
        );
        journal.ecrire(
            Niveau::Erreur,
            "llm_chat",
            "{\"error\":{\"message\":\"Incorrect API key provided: sk-proj-abcdef123456\"}} api_key=xyz987 \"token\": \"tok-42\"",
            &[],
        );
        journal.ecrire(
            Niveau::Erreur,
            "llm_models",
            "x-api-key: zzz-111 http://moi:secret@exemple.fr/v1",
            &[],
        );
        journal.ecrire_page(
            Niveau::Erreur,
            &format!("Erreur : Bearer {cle}"),
            &[cle],
            Instant::now(),
        );
        let contenu = lire(&journal);
        for interdit in [
            cle,
            "sk-proj-abcdef123456",
            "xyz987",
            "tok-42",
            "zzz-111",
            "secret@",
        ] {
            assert!(!contenu.contains(interdit), "{interdit} écrit : {contenu}");
        }
        assert!(contenu.contains("HTTP 401"));
        assert!(contenu.contains("[clé masquée]"));
        assert!(contenu.contains("Bearer [masqué]"));
        // Une « clé » trop courte ne masque pas le reste du message.
        assert_eq!(masquer("statut 500", &["5"]), "statut 500");
    }

    #[test]
    fn le_niveau_de_la_page_est_controle() {
        assert_eq!(Niveau::depuis_page("erreur"), Some(Niveau::Erreur));
        assert_eq!(Niveau::depuis_page("info"), Some(Niveau::Info));
        assert_eq!(
            Niveau::depuis_page("avertissement"),
            Some(Niveau::Avertissement)
        );
        assert_eq!(Niveau::depuis_page("ERREUR\n2026 INFO faux"), None);
    }

    #[test]
    fn l_horodatage_est_en_utc_iso() {
        assert_eq!(horodatage(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        let instant = UNIX_EPOCH + Duration::from_millis(1_795_132_800_123);
        assert_eq!(horodatage(instant), "2026-11-20T00:00:00.123Z");
        let bissextile = UNIX_EPOCH + Duration::from_secs(951_782_400);
        assert_eq!(horodatage(bissextile), "2000-02-29T00:00:00.000Z");
    }
}
