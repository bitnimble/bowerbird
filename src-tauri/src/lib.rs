// The desktop shell.
//
// A transport, not a second application. The page calls `api` instead of `fetch` and loads
// its images from `bowerbird://`, and both land in `api.rs`, which forwards them to the
// hosted Bowerbird server. What that buys today is that the page holds no origin and no
// credentials; what it buys later is offline mode, which becomes a `match` on the command
// name in one file rather than a second client in the page.

mod api;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    #[cfg(feature = "wdio")]
    let builder = builder
        .plugin(tauri_plugin_wdio::init())
        .plugin(tauri_plugin_wdio_webdriver::init());

    builder
        .register_uri_scheme_protocol("bowerbird", |_app, request| api::asset(request))
        .invoke_handler(tauri::generate_handler![api::api])
        .run(tauri::generate_context!())
        .expect("error while running the Bowerbird shell");
}
