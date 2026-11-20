fn main() {
    // Les commandes de l'application passent par la liste d'accès de Tauri :
    // une page ne peut appeler que celles qu'une capability lui autorise. La
    // page embarquée les a toutes, une par une (capabilities/default.json),
    // et rien d'autre. Les deux commandes d'autotest ne sont autorisées par
    // aucune capability du dossier : voir src/autotest.rs.
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
            "log_page",
            "correcteur_prechauffer",
            "correcteur_controler",
            "autotest_config",
            "autotest_terminer",
        ]));
    tauri_build::try_build(attributes).expect("échec de tauri-build");
}
