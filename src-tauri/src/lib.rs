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

// `#[default_runtime(crate::Wry, wry)]` only defaults `AppHandle`'s generic while the `wry`
// feature is on, and the Linux build turns it off to get CEF - so every `AppHandle` has to
// name the runtime rather than rely on the default.
#[cfg(target_os = "linux")]
pub type Runtime = tauri::Cef;
#[cfg(not(target_os = "linux"))]
pub type Runtime = tauri::Wry;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Before the stream, which reads the address it was told about.
            api::load_config(app.handle());
            events::follow(app.handle());
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol("bowerbird", |_app, request, responder| {
            api::asset(request, responder)
        })
        .invoke_handler(tauri::generate_handler![
            api::api,
            api::server_origin,
            api::set_server_origin,
            events::events_following
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Bowerbird shell");
}
