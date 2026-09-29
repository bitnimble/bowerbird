//! What the shell has to say, on stderr and kept for the page's logs dialog.

use std::collections::VecDeque;
use std::fmt::Display;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const LINES_KEPT: usize = 2000;

static LINES: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());

pub(crate) fn info(message: impl Display) {
    record("INFO", message);
}

pub(crate) fn warn(message: impl Display) {
    record("WARN", message);
}

pub(crate) fn error(message: impl Display) {
    record("ERROR", message);
}

/// The shell's lines, oldest first, shaped like the server's so the page can merge them by time.
#[tauri::command]
pub fn app_logs() -> Vec<String> {
    LINES
        .lock()
        .map(|lines| lines.iter().cloned().collect())
        .unwrap_or_default()
}

fn record(level: &str, message: impl Display) {
    let since_epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let line = format!("{} {level:<5} [shell] {message}", iso_8601(since_epoch));
    eprintln!("{line}");
    let Ok(mut lines) = LINES.lock() else { return };
    lines.push_back(line);
    if lines.len() > LINES_KEPT {
        lines.pop_front();
    }
}

/// `Date.prototype.toISOString`'s shape exactly, since the page sorts lines by it as text.
fn iso_8601(since_epoch: Duration) -> String {
    let seconds = since_epoch.as_secs();
    let of_day = seconds % 86_400;
    // Howard Hinnant's civil_from_days.
    let z = (seconds / 86_400) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        of_day / 3600,
        of_day % 3600 / 60,
        of_day % 60,
        since_epoch.subsec_millis()
    )
}

#[cfg(test)]
mod tests {
    use super::iso_8601;
    use std::time::Duration;

    #[test]
    fn timestamps_match_the_pages() {
        assert_eq!(iso_8601(Duration::ZERO), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            iso_8601(Duration::from_millis(1_790_000_000_042)),
            "2026-09-21T14:13:20.042Z"
        );
        assert_eq!(
            iso_8601(Duration::from_secs(951_782_400)),
            "2000-02-29T00:00:00.000Z"
        );
        assert_eq!(
            iso_8601(Duration::from_secs(4_107_542_399)),
            "2100-02-28T23:59:59.000Z"
        );
    }
}
