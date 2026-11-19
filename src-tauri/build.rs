fn main() {
    // Les commandes de l'application passent par la liste d'accès de Tauri :
    // une page ne peut appeler que celles qu'une capability lui autorise.
    // Aujourd'hui, la page servie par le serveur local (origine « distante »
    // pour Tauri) n'a droit qu'aux commandes de mise à jour
    // (capabilities/mise-a-jour.json). Les commandes du journal, des réglages
    // et du modèle sont prêtes pour la page embarquée qui remplacera le
    // serveur ; aucune capability ne les autorise encore.
    let attributes =
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "update_status",
            "update_check",
            "update_install",
            "update_open_release_page",
            "db_read",
            "db_read_many",
            "db_batch",
            "settings_get",
            "settings_set",
            "valid_words_get",
            "valid_words_add",
            "llm_models",
            "llm_chat",
            "llm_cancel",
        ]));
    tauri_build::try_build(attributes).expect("échec de tauri-build");
}
