// The desktop shell.
//
// A transport, not a second application. The page calls `api` instead of `fetch` and loads
// its images from `bowerbird://`, and both land in `api.rs`, which forwards them to the
// hosted Bowerbird server. What that buys today is that the page holds no origin and no
// credentials; what it buys later is offline mode, which becomes a `match` on the command
// name in one file rather than a second client in the page.

mod api;
/// The one call that is not request/response, and so cannot go through `api.rs`.
mod events;
/// Renders the page asks for and this app writes to a folder, rather than answers.
mod export;
mod open_with;
mod reveal;
/// The Bowerbird server this app carries, so the library is local and works offline.
mod server;

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
            // Before the stream, which reads the address it was told about.
            api::load_config(app.handle());
            if let Err(why) = api::apply_ui_scale(app.handle()) {
                eprintln!("[bowerbird] {why}");
            }
            // A desktop Bowerbird holds a library of its own, so it starts a server
            // for itself. One pointed at another server - `BOWERBIRD_SERVER`, or the
            // address Android's settings name - pays nothing for a second it is not using.
            if api::configured_origin().is_none() {
                match server::start(app.handle()) {
                    Ok(origin) => eprintln!("[bowerbird] serving this library locally on {origin}"),
                    Err(why) => eprintln!("[bowerbird] could not start the local server: {why}"),
                }
            }
            events::follow(app.handle());
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
