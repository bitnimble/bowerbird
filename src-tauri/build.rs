fn main() {
    // Declared so each command has a permission a capability can grant: the page is served over
    // http by the local server, and Tauri answers a remote origin only the commands
    // a capability names (`capabilities/`).
    let commands = tauri_build::AppManifest::new().commands(&[
        "set_ui_scale",
        "app_logs",
        "server_log_file",
        "set_caption_buttons",
        "read_device_file",
        "write_device_file",
        "display_range",
        "pick_export_folder",
        "export_to_folder",
        "open_original_with",
        "photo_access",
        "ask_photo_access",
        "open_folder",
        "reveal_file",
        "reveal_original",
        "app_data_dir",
        "open_app_data_dir",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(commands))
        .expect("tauri-build failed");
}
