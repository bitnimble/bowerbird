//! The window's interface scale, which the page keeps among this device's preferences.

const UI_SCALES: std::ops::RangeInclusive<f64> = 0.5..=2.0;

#[tauri::command]
pub fn set_ui_scale(
    window: tauri::WebviewWindow<crate::Runtime>,
    value: f64,
) -> Result<(), String> {
    if !UI_SCALES.contains(&value) {
        return Err(format!(
            "an interface scale of {value} is outside {UI_SCALES:?}"
        ));
    }
    window
        .set_zoom(value)
        .map_err(|e| format!("could not scale the window: {e}"))
}
