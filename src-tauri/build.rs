fn main() {
    // Declared so each command has a permission a capability can grant: the desktop page is
    // served over http by the local server, and Tauri answers a remote origin only the commands
    // a capability names (`capabilities/`).
    let commands = tauri_build::AppManifest::new().commands(&[
        "api",
        "server_origin",
        "set_server_origin",
        "ui_scale",
        "set_ui_scale",
        "display_is_hdr",
        "events_following",
        "pick_export_folder",
        "export_to_folder",
        "open_original_with",
        "open_folder",
        "reveal_file",
        "reveal_original",
        "app_data_dir",
        "open_app_data_dir",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(commands)).expect("tauri-build failed");
}
