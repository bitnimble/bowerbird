// The shell: the desktop app and the Android one.
//
// On the desktop the page is served by the Bowerbird server this app starts, and reaches it by
// URL as a browser tab reaches a container; the shell adds only what a page cannot do itself - a
// folder picker, a file manager, the app chooser. On Android the page is the bundled one, calls
// `api` instead of `fetch` and loads its images from `bowerbird://`, and `api.rs` forwards both
// to the server the reader names.

mod api;
mod display;
/// The one call that is not request/response, and so cannot go through `api.rs`. Android's.
#[cfg_attr(desktop, allow(dead_code))]
mod events;
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
    tauri::Builder::default()
        .setup(|app| {
            api::load_config(app.handle());
            open_window(app.handle())?;
            if let Err(why) = api::apply_ui_scale(app.handle()) {
                eprintln!("[bowerbird] {why}");
            }
            #[cfg(target_os = "macos")]
            {
                use tauri::Manager;
                app.manage(open_with::Offered::default());
                app.on_menu_event(open_with::chosen);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // The server outlives the window otherwise, holding the catalogue against
            // the next start and leaving a process nobody can see.
            if matches!(event, tauri::WindowEvent::Destroyed) && window.label() == "main" {
                server::stop();
            }
        })
        .register_asynchronous_uri_scheme_protocol("bowerbird", |_app, request, responder| {
            api::asset(request, responder)
        })
        .invoke_handler(tauri::generate_handler![
            api::api,
            api::server_origin,
            api::set_server_origin,
            api::ui_scale,
            api::set_ui_scale,
            display::display_is_hdr,
            events::events_following,
            export::pick_export_folder,
            export::export_to_folder,
            open_with::open_original_with,
            reveal::open_folder,
            reveal::reveal_file,
            reveal::reveal_original,
            server::app_data_dir,
            server::open_app_data_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Bowerbird shell");
}

/// The local server, then the window on it, signed in.
///
/// After rather than beside: the page is the server's, so there is nothing to show until it
/// answers. One that will not start is the end of the app, said in a dialog, since there is no
/// page to say it in.
#[cfg(desktop)]
fn open_window(app: &tauri::AppHandle<Runtime>) -> tauri::Result<()> {
    match server::start(app) {
        Ok(signed_in) => main_window(app, tauri::WebviewUrl::External(signed_in)),
        Err(why) => {
            eprintln!("[bowerbird] could not start the local server: {why}");
            rfd::MessageDialog::new()
                .set_level(rfd::MessageLevel::Error)
                .set_title("Bowerbird")
                .set_description(format!("We couldn't open your library.\n\n{why}"))
                .show();
            std::process::exit(1);
        }
    }
}

/// The bundled page, which reaches whichever server the reader named through the shell.
#[cfg(mobile)]
fn open_window(app: &tauri::AppHandle<Runtime>) -> tauri::Result<()> {
    if api::configured_origin().is_none() {
        if let Err(why) = server::start(app) {
            eprintln!("[bowerbird] could not start the local server: {why}");
        }
    }
    events::follow(app);
    main_window(app, tauri::WebviewUrl::default())
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
    tauri::WebviewWindowBuilder::from_config(app, &config)?.build()?;
    Ok(())
}
