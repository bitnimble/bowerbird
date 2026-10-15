//! The device's own photo library, where the platform guards it: leave to read it, for the page,
//! and leave to change photos other apps own, for the server (`write_grants.ts`).

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoAccess {
    /// `all`, `selected` or `none`.
    photos: String,
    /// Whether the platform has a setting that lets changes through without asking each time.
    manageable: bool,
    managed: bool,
    camera_folder: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PhotoAsk {
    Read,
    Management,
    Settings,
}

#[tauri::command]
pub async fn photo_access(
    app: tauri::AppHandle<crate::Runtime>,
) -> Result<Option<PhotoAccess>, String> {
    platform::run(&app, "access").await
}

/// Resolves once the reader has answered, with what they allowed.
#[tauri::command]
pub async fn ask_photo_access(
    app: tauri::AppHandle<crate::Runtime>,
    ask: PhotoAsk,
) -> Result<Option<PhotoAccess>, String> {
    let command = match ask {
        PhotoAsk::Read => "requestAccess",
        PhotoAsk::Management => "requestManagement",
        PhotoAsk::Settings => "openSettings",
    };
    platform::run(&app, command).await
}

#[cfg(target_os = "android")]
pub(crate) use platform::{plugin, serve_write_grants};

#[cfg(target_os = "android")]
mod platform {
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::Path;
    use std::sync::{Mutex, OnceLock, mpsc};
    use std::time::Duration;

    use tauri::Manager;
    use tauri::plugin::PluginHandle;
    use tauri::plugin::mobile::PluginInvokeError;

    use crate::Runtime;

    struct Photos(PluginHandle<Runtime>);

    pub(crate) fn plugin() -> tauri::plugin::TauriPlugin<Runtime> {
        tauri::plugin::Builder::new("photos")
            .setup(|app, api| {
                let package = app.config().identifier.replace('-', "_");
                let handle = api.register_android_plugin(&package, "PhotosPlugin")?;
                app.manage(Photos(handle));
                Ok(())
            })
            .build()
    }

    pub(super) async fn run<T: serde::de::DeserializeOwned>(
        app: &tauri::AppHandle<Runtime>,
        command: &str,
    ) -> Result<Option<T>, String> {
        let photos = app.state::<Photos>();
        photos
            .0
            .run_mobile_plugin_async(command, ())
            .await
            .map(Some)
            .map_err(|err| format!("could not ask about the device's photos: {err}"))
    }

    #[derive(serde::Deserialize)]
    struct GrantRequest {
        grant_writes: Vec<String>,
    }

    #[derive(serde::Serialize)]
    struct GrantReply {
        granted: bool,
        reason: Option<String>,
    }

    static SERVING: OnceLock<Result<(), String>> = OnceLock::new();
    // Tauri's plugin manager holds one pending activity result, so a second request launched
    // before the first answers would leave the first waiting forever.
    static GRANTING: Mutex<()> = Mutex::new(());
    const PROMPT_PATIENCE: Duration = Duration::from_secs(300);
    /// `PhotosPlugin.kt`'s code for a reader who said no.
    const DECLINED: &str = "declined";

    pub(crate) fn serve_write_grants(
        app: &tauri::AppHandle<Runtime>,
        socket: &Path,
    ) -> Result<(), String> {
        SERVING
            .get_or_init(|| {
                let _ = std::fs::remove_file(socket);
                let listener = UnixListener::bind(socket)
                    .map_err(|err| format!("could not listen on {}: {err}", socket.display()))?;
                let app = app.clone();
                std::thread::spawn(move || {
                    for connection in listener.incoming() {
                        let Ok(connection) = connection else {
                            // Out of descriptors, say: accept fails at once until some close.
                            std::thread::sleep(Duration::from_millis(100));
                            continue;
                        };
                        let app = app.clone();
                        std::thread::spawn(move || answer(&app, connection));
                    }
                });
                Ok(())
            })
            .clone()
    }

    fn answer(app: &tauri::AppHandle<Runtime>, connection: UnixStream) {
        let mut line = String::new();
        let reply = match BufReader::new(&connection).read_line(&mut line) {
            Ok(_) => match serde_json::from_str::<GrantRequest>(&line) {
                Ok(request) => grant(app, request.grant_writes),
                Err(err) => refused(format!("could not read the request: {err}")),
            },
            Err(err) => refused(format!("could not read the request: {err}")),
        };
        let mut connection = connection;
        if let Ok(reply) = serde_json::to_string(&reply) {
            let _ = writeln!(connection, "{reply}");
        }
    }

    fn grant(app: &tauri::AppHandle<Runtime>, paths: Vec<String>) -> GrantReply {
        let (answered, answer) = mpsc::channel();
        let app = app.clone();
        // The lock is the thread's, and only the server waits with a deadline: a request that times
        // out still holds the next one back until Android answers it.
        std::thread::spawn(move || {
            let _one_at_a_time = GRANTING
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let _ = answered.send(
                app.state::<Photos>()
                    .0
                    .run_mobile_plugin::<serde_json::Value>(
                        "grantWrites",
                        serde_json::json!({ "paths": paths }),
                    ),
            );
        });
        match answer.recv_timeout(PROMPT_PATIENCE) {
            Ok(Ok(_)) => GrantReply {
                granted: true,
                reason: None,
            },
            Ok(Err(PluginInvokeError::InvokeRejected(rejection)))
                if rejection.code.as_deref() == Some(DECLINED) =>
            {
                GrantReply {
                    granted: false,
                    reason: None,
                }
            }
            Ok(Err(PluginInvokeError::InvokeRejected(rejection))) => refused(
                rejection
                    .message
                    .unwrap_or_else(|| "Android refused".into()),
            ),
            Ok(Err(err)) => refused(err.to_string()),
            Err(_) => refused("Android did not answer the request to change these photos".into()),
        }
    }

    fn refused(reason: String) -> GrantReply {
        GrantReply {
            granted: false,
            reason: Some(reason),
        }
    }
}

#[cfg(not(target_os = "android"))]
mod platform {
    pub(super) async fn run<T>(
        _app: &tauri::AppHandle<crate::Runtime>,
        _command: &str,
    ) -> Result<Option<T>, String> {
        Ok(None)
    }
}
