//! The system's own printer options, and Android's print dialog over the page.

#[tauri::command]
pub fn open_printer_settings(id: String, name: String) -> Result<(), String> {
    settings(&id, &name).map_err(|e| format!("could not open the settings for {name}: {e}"))
}

#[cfg(target_os = "windows")]
fn settings(_id: &str, name: &str) -> std::io::Result<()> {
    // rundll32 splits its own command line, so a quote would end the name early.
    if name.contains('"') {
        return Err(std::io::Error::other("the printer's name holds a quote"));
    }
    // Printing preferences: the per-user defaults a job then prints with.
    std::process::Command::new("rundll32")
        .args(["printui.dll,PrintUIEntry", "/e", "/n", name])
        .spawn()
        .map(|_| ())
}

#[cfg(target_os = "macos")]
fn settings(_id: &str, _name: &str) -> std::io::Result<()> {
    std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.Print-Scanner-Settings.extension")
        .spawn()
        .map(reap)
}

#[cfg(all(
    unix,
    not(any(target_os = "macos", target_os = "android", target_os = "ios"))
))]
fn settings(id: &str, name: &str) -> std::io::Result<()> {
    let queue = id.strip_prefix("cups:").unwrap_or(name);
    std::process::Command::new("xdg-open")
        .arg(format!(
            "http://localhost:631/printers/{}",
            percent_encoded(queue)
        ))
        .spawn()
        .map(reap)
}

#[cfg(all(
    unix,
    not(any(target_os = "macos", target_os = "android", target_os = "ios"))
))]
fn percent_encoded(segment: &str) -> String {
    segment
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                char::from(byte).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

#[cfg(all(unix, not(any(target_os = "android", target_os = "ios"))))]
fn reap(mut child: std::process::Child) {
    std::thread::spawn(move || {
        let _ = child.wait();
    });
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn settings(_id: &str, _name: &str) -> std::io::Result<()> {
    Err(std::io::Error::other(
        "this device has no printer settings to open",
    ))
}

/// Opens the system print dialog over the page as its print styles lay it out.
#[tauri::command]
pub async fn print_page(
    window: tauri::WebviewWindow<crate::Runtime>,
    job_name: String,
) -> Result<(), String> {
    print(window, job_name).await
}

#[cfg(target_os = "android")]
const PRINT_DIALOG_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

#[cfg(target_os = "android")]
async fn print(
    window: tauri::WebviewWindow<crate::Runtime>,
    job_name: String,
) -> Result<(), String> {
    let (answer, mut answered) = tokio::sync::mpsc::channel(2);
    let timeout = answer.clone();
    std::thread::spawn(move || {
        std::thread::sleep(PRINT_DIALOG_TIMEOUT);
        let _ = timeout.try_send(Err(format!(
            "the print dialog did not open in {} s",
            PRINT_DIALOG_TIMEOUT.as_secs()
        )));
    });
    window
        .with_webview(move |webview| {
            webview.jni_handle().exec(move |env, activity, webview| {
                let printed = env.new_string("print").and_then(|service| {
                    let manager = env
                        .call_method(
                            activity,
                            "getSystemService",
                            "(Ljava/lang/String;)Ljava/lang/Object;",
                            &[(&service).into()],
                        )?
                        .l()?;
                    let name = env.new_string(&job_name)?;
                    let adapter = env
                        .call_method(
                            webview,
                            "createPrintDocumentAdapter",
                            "(Ljava/lang/String;)Landroid/print/PrintDocumentAdapter;",
                            &[(&name).into()],
                        )?
                        .l()?;
                    let builder = env.new_object("android/print/PrintAttributes$Builder", "()V", &[])?;
                    let attributes = env
                        .call_method(&builder, "build", "()Landroid/print/PrintAttributes;", &[])?
                        .l()?;
                    env.call_method(
                        &manager,
                        "print",
                        "(Ljava/lang/String;Landroid/print/PrintDocumentAdapter;Landroid/print/PrintAttributes;)Landroid/print/PrintJob;",
                        &[(&name).into(), (&adapter).into(), (&attributes).into()],
                    )?;
                    Ok(())
                });
                if printed.is_err() {
                    let _ = env.exception_clear();
                }
                let _ = answer.try_send(printed.map_err(|e| e.to_string()));
            });
        })
        .map_err(|e| e.to_string())?;
    answered
        .recv()
        .await
        .unwrap_or_else(|| Err("the print dialog never answered".into()))
}

#[cfg(not(target_os = "android"))]
async fn print(
    _window: tauri::WebviewWindow<crate::Runtime>,
    _job_name: String,
) -> Result<(), String> {
    Err("the system print dialog is the Android app's to open".into())
}

#[cfg(all(
    test,
    unix,
    not(any(target_os = "macos", target_os = "android", target_os = "ios"))
))]
mod tests {
    use super::percent_encoded;

    #[test]
    fn a_queue_name_is_one_url_segment() {
        assert_eq!(percent_encoded("Canon_PRO-200"), "Canon_PRO-200");
        assert_eq!(percent_encoded("Photo/Lab #2?"), "Photo%2FLab%20%232%3F");
        assert_eq!(percent_encoded("Büro"), "B%C3%BCro");
    }
}
