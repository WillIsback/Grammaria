//! Trousseau du système, où est rangée la clé API du modèle.
//!
//! - Windows : Gestionnaire d'identification (identifiant générique, conservé
//!   sur cet ordinateur seulement, sans itinérance).
//! - Linux : service de secrets freedesktop (GNOME Keyring, KWallet…), joint
//!   par D-Bus en Rust pur (zbus, déjà dans l'application) : aucune
//!   bibliothèque système de plus.
//! - Ailleurs : pas de trousseau pris en charge (repli sur le fichier).
//!
//! Une seule entrée : service `fr.willisback.grammaria` (identifiant de
//! l'application), compte `cle-api-modele`. L'autotest utilise un autre compte
//! (`COMPTE_AUTOTEST`) et le vide avant et après : il n'écrit jamais dans
//! l'entrée d'un utilisateur.
//!
//! Le reste de l'application ne voit que le trait `Coffre` : `store.rs` est
//! testé avec un coffre en mémoire. Les erreurs ne portent jamais la clé : une
//! description courte, pour le journal technique.

use std::sync::mpsc;
use std::time::Duration;

/// Service de l'entrée : l'identifiant de l'application (tauri.conf.json).
pub const SERVICE: &str = "fr.willisback.grammaria";
/// Compte de l'entrée de l'utilisateur.
pub const COMPTE: &str = "cle-api-modele";
/// Compte de l'autotest, distinct de celui de l'utilisateur.
pub const COMPTE_AUTOTEST: &str = "cle-api-modele-autotest";

/// Au-delà, l'opération est tenue pour un échec (repli sur le fichier) : un
/// service de secrets qui attend une fenêtre de déverrouillage que personne
/// ne voit (session sans écran) ne doit pas bloquer l'application.
const DELAI: Duration = Duration::from_secs(30);

/// Échec d'une opération du trousseau : description sans secret.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ErreurCoffre(pub String);

impl std::fmt::Display for ErreurCoffre {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Accès à l'entrée de la clé dans un trousseau.
pub trait Coffre: Send + Sync {
    /// La clé enregistrée, `None` si l'entrée n'existe pas.
    fn lire(&self) -> Result<Option<String>, ErreurCoffre>;
    /// Crée ou remplace l'entrée.
    fn ecrire(&self, cle: &str) -> Result<(), ErreurCoffre>;
    /// Supprime l'entrée ; une entrée absente n'est pas une erreur.
    fn effacer(&self) -> Result<(), ErreurCoffre>;
}

/// Le trousseau du système.
pub struct Systeme {
    compte: &'static str,
}

impl Systeme {
    pub fn new(compte: &'static str) -> Self {
        Self { compte }
    }

    /// Exécute `travail` sur l'entrée, dans un fil à part borné par `DELAI`.
    /// Le fil abandonné finit seul ; son résultat est ignoré.
    fn avec_entree<T: Send + 'static>(
        &self,
        travail: impl FnOnce(keyring_core::Entry) -> keyring_core::Result<T> + Send + 'static,
    ) -> Result<T, ErreurCoffre> {
        let compte = self.compte;
        let (envoi, reception) = mpsc::channel();
        std::thread::Builder::new()
            .name("trousseau".into())
            .spawn(move || {
                let _ = envoi.send(entree(compte).and_then(travail).map_err(|e| decrire(&e)));
            })
            .map_err(|_| ErreurCoffre("fil du trousseau impossible à lancer".into()))?;
        match reception.recv_timeout(DELAI) {
            Ok(resultat) => resultat,
            Err(mpsc::RecvTimeoutError::Timeout) => Err(ErreurCoffre(format!(
                "pas de réponse du trousseau en {} s",
                DELAI.as_secs()
            ))),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err(ErreurCoffre("le trousseau s'est arrêté en erreur".into()))
            }
        }
    }
}

impl Coffre for Systeme {
    fn lire(&self) -> Result<Option<String>, ErreurCoffre> {
        self.avec_entree(|entree| match entree.get_password() {
            Ok(cle) => Ok(Some(cle)),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(erreur) => Err(erreur),
        })
    }

    fn ecrire(&self, cle: &str) -> Result<(), ErreurCoffre> {
        let cle = cle.to_owned();
        self.avec_entree(move |entree| entree.set_password(&cle))
    }

    fn effacer(&self) -> Result<(), ErreurCoffre> {
        self.avec_entree(|entree| match entree.delete_credential() {
            Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
            Err(erreur) => Err(erreur),
        })
    }
}

/// Entrée du trousseau de Windows : identifiant générique
/// `cle-api-modele.fr.willisback.grammaria`, persistance locale (reste sur cet
/// ordinateur, ne suit pas un profil itinérant).
#[cfg(windows)]
fn entree(compte: &str) -> keyring_core::Result<keyring_core::Entry> {
    use keyring_core::api::CredentialStoreApi;
    let options = std::collections::HashMap::from([("persistence", "Local")]);
    windows_native_keyring_store::Store::new()?.build(SERVICE, compte, Some(&options))
}

/// Entrée du service de secrets (collection par défaut, celle de la session),
/// avec un libellé lisible dans les outils du système (Seahorse, KWalletManager).
#[cfg(target_os = "linux")]
fn entree(compte: &str) -> keyring_core::Result<keyring_core::Entry> {
    use keyring_core::api::CredentialStoreApi;
    let options =
        std::collections::HashMap::from([("label", "Grammaria : clé API du modèle de langage")]);
    zbus_secret_service_keyring_store::Store::new()?.build(SERVICE, compte, Some(&options))
}

#[cfg(not(any(windows, target_os = "linux")))]
fn entree(_compte: &str) -> keyring_core::Result<keyring_core::Entry> {
    Err(keyring_core::Error::NoDefaultStore)
}

/// Description d'une erreur du trousseau, pour le journal. Jamais le contenu
/// d'un secret : `BadEncoding` porte les octets lus, il n'est pas affiché.
fn decrire(erreur: &keyring_core::Error) -> ErreurCoffre {
    use keyring_core::Error;
    ErreurCoffre(match erreur {
        Error::PlatformFailure(cause) => format!("service du trousseau en échec ({cause})"),
        Error::NoStorageAccess(cause) => {
            format!("trousseau verrouillé ou accès refusé ({cause})")
        }
        Error::NoDefaultStore => "aucun trousseau pris en charge sur ce système".into(),
        Error::Ambiguous(_) => "plusieurs entrées correspondent dans le trousseau".into(),
        Error::TooLong(..) => "clé trop longue pour le trousseau".into(),
        Error::BadEncoding(_) | Error::BadDataFormat(..) | Error::BadStoreFormat(_) => {
            "entrée du trousseau illisible".into()
        }
        _ => "erreur du trousseau".into(),
    })
}

/// Coffre en mémoire, pour les tests : disponible ou non, et qui peut relire
/// autre chose que ce qui a été écrit (trousseau défaillant).
#[cfg(test)]
pub mod memoire {
    use super::{Coffre, ErreurCoffre};
    use std::sync::{Arc, Mutex};

    /// Le test garde une poignée sur le coffre confié au `Store`.
    impl<T: Coffre> Coffre for Arc<T> {
        fn lire(&self) -> Result<Option<String>, ErreurCoffre> {
            (**self).lire()
        }
        fn ecrire(&self, cle: &str) -> Result<(), ErreurCoffre> {
            (**self).ecrire(cle)
        }
        fn effacer(&self) -> Result<(), ErreurCoffre> {
            (**self).effacer()
        }
    }

    #[derive(Default)]
    pub struct Memoire {
        pub cle: Mutex<Option<String>>,
        /// Toutes les opérations échouent (pas de service de secrets).
        pub indisponible: bool,
        /// L'écriture « réussit » mais la relecture rend autre chose.
        pub relecture_fausse: bool,
    }

    impl Memoire {
        pub fn indisponible() -> Self {
            Self {
                indisponible: true,
                ..Self::default()
            }
        }

        pub fn contenu(&self) -> Option<String> {
            self.cle.lock().unwrap().clone()
        }

        fn verifier(&self) -> Result<(), ErreurCoffre> {
            if self.indisponible {
                Err(ErreurCoffre("aucun service de secrets".into()))
            } else {
                Ok(())
            }
        }
    }

    impl Coffre for Memoire {
        fn lire(&self) -> Result<Option<String>, ErreurCoffre> {
            self.verifier()?;
            let cle = self.contenu();
            Ok(if self.relecture_fausse {
                cle.map(|c| format!("{c}-abimee"))
            } else {
                cle
            })
        }

        fn ecrire(&self, cle: &str) -> Result<(), ErreurCoffre> {
            self.verifier()?;
            *self.cle.lock().unwrap() = Some(cle.to_owned());
            Ok(())
        }

        fn effacer(&self) -> Result<(), ErreurCoffre> {
            self.verifier()?;
            *self.cle.lock().unwrap() = None;
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// L'entrée porte l'identifiant de l'application (tauri.conf.json).
    #[test]
    fn le_service_est_l_identifiant_de_l_application() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], SERVICE);
        assert_ne!(COMPTE, COMPTE_AUTOTEST);
    }

    #[test]
    fn les_erreurs_ne_montrent_pas_les_octets_lus() {
        let erreur = decrire(&keyring_core::Error::BadEncoding(b"sk-secrete".to_vec()));
        assert!(!erreur.0.contains("sk-secrete"));
        assert_eq!(erreur.0, "entrée du trousseau illisible");
    }
}
