fn main() {
    // Les commandes de mise à jour passent par la liste d'accès de Tauri : la
    // page servie par le serveur local (origine « distante » pour Tauri) ne
    // peut appeler que celles que capabilities/mise-a-jour.json autorise.
    let attributes =
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "update_status",
            "update_check",
            "update_install",
            "update_open_release_page",
        ]));
    tauri_build::try_build(attributes).expect("échec de tauri-build");
}
