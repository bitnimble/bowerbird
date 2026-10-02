// The shell: the desktop app and the mobile one.
//
// The page is served by the Bowerbird server this app starts, and reaches it by URL as a browser
// tab reaches a container; the shell adds only what a page cannot do itself - a folder picker, a
// file manager, the app chooser.

#[cfg(target_os = "android")]
mod android;
mod app_log;
mod caption;
mod config;
mod display;
/// Renders the page asks for and this app writes to a folder, rather than answers.
mod export;
mod export_paths;
mod open_with;
mod reveal;
/// The Bowerbird server this app carries, so the library is local and works offline.
mod server;
mod update;

// `#[default_runtime(crate::Wry, wry)]` only defaults `AppHandle`'s generic while the `wry`
// feature is on, so every `AppHandle` names the runtime rather than relying on the default -
// which is what lets a platform draw with something else without touching any of them.
//
// Linux drew with CEF and is paused (§23.7); `Cargo.toml` says what that pause is made of.
//
// #[cfg(target_os = "linux")]
// pub type Runtime = tauri::Cef;
pub type Runtime = tauri::Wry;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .setup(|app| {
            config::load(app.handle());
            if let Err(err) = open_window(app.handle()) {
                server::stop();
                return Err(err.into());
            }
            if let Err(why) = config::apply_ui_scale(app.handle()) {
                app_log::error(why);
            }
            #[cfg(target_os = "macos")]
            {
                use tauri::Manager;
                app.manage(open_with::Offered::default());
                app.on_menu_event(open_with::chosen);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            config::ui_scale,
            config::set_ui_scale,
            app_log::app_logs,
            caption::set_caption_buttons,
            display::display_is_hdr,
            export::pick_export_folder,
            export::export_to_folder,
            open_with::open_original_with,
            reveal::open_folder,
            reveal::reveal_file,
            reveal::reveal_original,
            server::app_data_dir,
            server::open_app_data_dir
        ]);
    // The server outlives the window otherwise, holding the catalogue against the next start and
    // leaving a process nobody can see. Not on Android, where a back press destroys the window and
    // the same process brings it back wanting its server; the platform ends the server with the
    // app's process group.
    #[cfg(desktop)]
    let builder = builder.on_window_event(|window, event| {
        if matches!(
            event,
            tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
        ) && window.label() == "main"
        {
            use tauri::Manager;
            server::stop();
            window.app_handle().exit(0);
        }
    });
    #[cfg(target_os = "macos")]
    let builder = builder.on_web_content_process_terminate(server::recover);
    builder
        .build(tauri::generate_context!())
        .expect("error while building the Bowerbird shell")
        .run(|_, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                server::stop();
            }
        });
}

/// The local server, then the window on it, signed in.
///
/// After rather than beside: the page is the server's, so there is nothing to show until it
/// answers. One that will not start is the end of the app.
fn open_window(app: &tauri::AppHandle<Runtime>) -> tauri::Result<()> {
    match server::start(app) {
        Ok(signed_in) => main_window(app, tauri::WebviewUrl::External(signed_in)),
        Err(why) => {
            app_log::error(format!("could not start the local server: {why}"));
            #[cfg(desktop)]
            rfd::MessageDialog::new()
                .set_level(rfd::MessageLevel::Error)
                .set_title("Bowerbird")
                .set_description(format!("We couldn't open your library.\n\n{why}"))
                .show();
            std::process::exit(1);
        }
    }
}

fn main_window(app: &tauri::AppHandle<Runtime>, url: tauri::WebviewUrl) -> tauri::Result<()> {
    let mut config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .expect("tauri.conf.json declares the main window");
    config.url = url;
    // Windows has no overlay title bar, so the page draws its own caption buttons.
    if cfg!(target_os = "windows") {
        config.decorations = false;
    }
    let window = tauri::WebviewWindowBuilder::from_config(app, &config)?.build()?;
    if let Err(why) = caption::attach(&window) {
        app_log::error(why);
    }
    Ok(())
}
