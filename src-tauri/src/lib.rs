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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    #[cfg(feature = "wdio")]
    let builder = builder
        .plugin(tauri_plugin_wdio::init())
        .plugin(tauri_plugin_wdio_webdriver::init());

    builder
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
