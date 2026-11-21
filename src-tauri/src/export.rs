//! Export anonyme de la bêta (issue #34) : écrit le fichier préparé par la page
//! (`src/analysis/progression/export.ts`) dans le dossier Téléchargements de
//! l'utilisateur, et renvoie son chemin.
//!
//! La page ne reçoit aucun accès au système de fichiers : elle ne choisit ni le
//! dossier (fixé au démarrage, ici), ni le nom du fichier (construit ici à partir
//! de l'identifiant du participant, contrôlé). Le contenu est revérifié avant
//! d'être écrit : taille bornée, JSON valide, format `grammaria-beta` version 1,
//! et une forme générale stricte (objets à clés alphabétiques, chaînes courtes
//! sans caractère de contrôle, nombres entiers positifs, profondeur et listes
//! bornées). La validation complète, champ par champ, est celle de la page
//! (`validerExport`), qui a déjà refusé tout le reste.

use std::path::PathBuf;

use serde_json::Value;
use tauri::State;

use crate::logs;

/// Taille maximale du fichier (même borne que `LIMITES_EXPORT.octets`).
const OCTETS_MAX: usize = 2_000_000;
const PROFONDEUR_MAX: usize = 6;
const LISTE_MAX: usize = 1000;
const CHAINE_MAX: usize = 100;
const CLE_MAX: usize = 40;

/// Dossier où l'export est écrit : Téléchargements de l'utilisateur ; en mode
/// autotest, un dossier à côté des données isolées.
pub struct DossierExport(pub Option<PathBuf>);

/// Forme générale d'une valeur de l'export.
fn forme_valide(valeur: &Value, profondeur: usize) -> bool {
    if profondeur > PROFONDEUR_MAX {
        return false;
    }
    match valeur {
        Value::Null | Value::Bool(_) => true,
        Value::Number(n) => n.as_u64().is_some(),
        Value::String(s) => s.chars().count() <= CHAINE_MAX && !s.chars().any(char::is_control),
        Value::Array(liste) => {
            liste.len() <= LISTE_MAX && liste.iter().all(|v| forme_valide(v, profondeur + 1))
        }
        Value::Object(champs) => champs.iter().all(|(cle, v)| {
            !cle.is_empty()
                && cle.len() <= CLE_MAX
                && cle.chars().all(|c| c.is_ascii_alphabetic())
                && forme_valide(v, profondeur + 1)
        }),
    }
}

/// Vérifie le contenu ; renvoie le nom du fichier, construit à partir du participant.
pub fn verifier(contenu: &str) -> Result<String, String> {
    if contenu.len() > OCTETS_MAX {
        return Err("Le fichier d'export est trop gros.".into());
    }
    let valeur: Value =
        serde_json::from_str(contenu).map_err(|_| "Le fichier d'export n'est pas du JSON.")?;
    let format_ok = valeur.get("format").and_then(Value::as_str) == Some("grammaria-beta")
        && valeur.get("version").and_then(Value::as_u64) == Some(1);
    let participant = valeur
        .get("participant")
        .and_then(Value::as_str)
        .filter(|p| p.len() == 32 && p.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')));
    match participant {
        Some(p) if format_ok && valeur.is_object() && forme_valide(&valeur, 0) => {
            Ok(format!("grammaria-beta-{}.json", &p[..8]))
        }
        _ => Err("Le contenu n'est pas un export de la bêta de Grammaria.".into()),
    }
}

/// Écrit `contenu` sous son nom dans `dossier` ; renvoie le chemin du fichier.
pub fn enregistrer(dossier: &std::path::Path, contenu: &str) -> Result<PathBuf, String> {
    let nom = verifier(contenu)?;
    let chemin = dossier.join(nom);
    crate::store::write_atomic(&chemin, contenu, false)
        .map_err(|error| format!("Écriture impossible dans {} : {error}", dossier.display()))?;
    Ok(chemin)
}

/// Enregistre l'export de la bêta dans le dossier Téléchargements ; renvoie le chemin.
#[tauri::command]
pub async fn export_beta_enregistrer(
    dossier: State<'_, DossierExport>,
    contenu: String,
) -> Result<String, String> {
    let Some(dossier) = dossier.0.as_deref() else {
        return Err("Dossier Téléchargements introuvable sur cet ordinateur.".into());
    };
    match enregistrer(dossier, &contenu) {
        Ok(chemin) => {
            logs::ecrire(
                logs::Niveau::Info,
                "export",
                "Export de la bêta enregistré dans le dossier Téléchargements.",
            );
            Ok(chemin.display().to_string())
        }
        Err(error) => {
            logs::echec_commande("export_beta_enregistrer", &error);
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PARTICIPANT: &str = "0123456789abcdef0123456789abcdef";

    fn export(extra: &str) -> String {
        format!(
            r#"{{
  "format": "grammaria-beta",
  "version": 1,
  "application": "0.5.0",
  "plateforme": "bureau",
  "participant": "{PARTICIPANT}",
  "semaines": [{{ "semaine": 0, "textes": 2, "mots": 300, "fautes": 1 }}],
  "regles": [{{ "regle": "PAIRE:c'est/s'est", "etat": null, "suffisant": true }}]{extra}
}}
"#
        )
    }

    #[test]
    fn un_export_valide_est_ecrit_tel_quel_sous_un_nom_fixe() {
        let dossier = tempfile::tempdir().unwrap();
        let contenu = export("");
        let chemin = enregistrer(dossier.path(), &contenu).unwrap();
        assert_eq!(chemin, dossier.path().join("grammaria-beta-01234567.json"));
        assert_eq!(std::fs::read_to_string(&chemin).unwrap(), contenu);
        // Un second export du même participant remplace le premier.
        enregistrer(dossier.path(), &contenu).unwrap();
        assert_eq!(std::fs::read_dir(dossier.path()).unwrap().count(), 1);
    }

    #[test]
    fn le_contenu_ne_choisit_ni_le_dossier_ni_le_nom() {
        let dossier = tempfile::tempdir().unwrap();
        let refuses = [
            "pas du JSON".to_string(),
            "[1, 2]".to_string(),
            export("").replace("grammaria-beta\"", "autre\""),
            export("").replace("\"version\": 1", "\"version\": 2"),
            export("").replace(PARTICIPANT, "../../../../etc/passwd"),
            export("").replace(PARTICIPANT, &PARTICIPANT.to_uppercase()),
            export(r#", "chemin": "/home/alice/.bashrc\u0000""#),
            export(r#", "Clé avec espace": 1"#),
            export(r#", "note": -1"#),
            export(r#", "note": 1.5"#),
            export(&format!(r#", "texte": "{}""#, "x".repeat(CHAINE_MAX + 1))),
            export(&format!(
                r#", "liste": [{}]"#,
                vec!["0"; LISTE_MAX + 1].join(",")
            )),
            export(r#", "a": {"b": {"c": {"d": {"e": {"f": {"g": 1}}}}}}"#),
            format!("{}{}", export(""), " ".repeat(OCTETS_MAX)),
        ];
        for contenu in &refuses {
            assert!(
                enregistrer(dossier.path(), contenu).is_err(),
                "accepté : {contenu:.80}"
            );
        }
        assert_eq!(std::fs::read_dir(dossier.path()).unwrap().count(), 0);
    }
}
