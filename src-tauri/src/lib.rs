// The desktop shell.
//
// One command that matters: the editor's open, run natively in this process rather than in
// the page. That is the whole reason the shell exists for this feature - the open is the
// only stage left that wants threads, measured at 3.2x between one and twelve
// (`native/rawshim/examples/open_threads.rs`), and the tick after it is the GPU's.
//
// The browser client reaches the same code over HTTP (`GET /image/:id/prepared`). Same
// `edit::prepare`, same bytes, two transports.

mod edit;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    #[cfg(feature = "wdio")]
    let builder = builder
        .plugin(tauri_plugin_wdio::init())
        .plugin(tauri_plugin_wdio_webdriver::init());

    builder
        .invoke_handler(tauri::generate_handler![edit::prepare_edit])
        .run(tauri::generate_context!())
        .expect("error while running the Bowerbird shell");
}
