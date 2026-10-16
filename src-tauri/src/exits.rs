//! Why the previous run ended, logged at the start of this one: a crash takes the logs with it.

use tauri::Manager;
use tauri::plugin::PluginHandle;

use crate::Runtime;

struct Exits(PluginHandle<Runtime>);

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LastExit {
    exits: Vec<String>,
    crash: Option<String>,
    crash_file: String,
}

pub(crate) fn plugin() -> tauri::plugin::TauriPlugin<Runtime> {
    tauri::plugin::Builder::new("exits")
        .setup(|app, api| {
            let package = app.config().identifier.replace('-', "_");
            let handle = api.register_android_plugin(&package, "ExitsPlugin")?;
            app.manage(Exits(handle));
            Ok(())
        })
        .build()
}

/// Logs the previous run's end, then has a panic in this one written where the next run reads it.
pub(crate) fn report(app: &tauri::AppHandle<Runtime>) {
    let app = app.clone();
    // Off the setup thread: the plugin answers on Android's main thread, which setup holds.
    std::thread::spawn(move || {
        let last = match app
            .state::<Exits>()
            .0
            .run_mobile_plugin::<LastExit>("lastExit", ())
        {
            Ok(last) => last,
            Err(err) => {
                crate::app_log::warn(format!("could not ask how the last run ended: {err}"));
                return;
            }
        };
        for exit in last.exits {
            crate::app_log::info(format!("an earlier run ended: {exit}"));
        }
        if let Some(crash) = last.crash {
            crate::app_log::error(format!("the last run crashed: {crash}"));
        }
        record_panics(last.crash_file);
    });
}

fn record_panics(crash_file: String) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let message = format!(
            "{}: {info}\n{}",
            thread.name().unwrap_or("unnamed thread"),
            std::backtrace::Backtrace::force_capture()
        );
        crate::app_log::error(&message);
        let _ = std::fs::write(&crash_file, &message);
        previous(info);
    }));
}
