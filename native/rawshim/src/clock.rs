//! A monotonic clock, and the stage laps every decode path reports through.
//!
//! **`std::time::Instant::now` panics on `wasm32-unknown-unknown`** - the target has no clock
//! behind it, and the call reads one unconditionally. Everything timed in this crate is
//! diagnostic, so on that target the clock stands still rather than taking the decode down with
//! it. `rawler`'s CRX decoder carries the same local patch for the same reason.
//!
//! One type and one `laps`, not a `#[cfg]` per call site: the four paths that report laps did so
//! by copying the same six lines, and four copies of a platform gate is four things to drift.

#[cfg(not(target_arch = "wasm32"))]
pub use std::time::Instant as Mark;

#[cfg(target_arch = "wasm32")]
pub use stopped::Mark;

#[cfg(target_arch = "wasm32")]
mod stopped {
    pub struct Mark;

    impl Mark {
        pub fn now() -> Self {
            Mark
        }

        pub fn elapsed(&self) -> std::time::Duration {
            std::time::Duration::ZERO
        }
    }
}

/// Stage laps under `BOWERBIRD_DECODE_PROFILE`, prefixed with what is being timed.
///
/// The switch is read once, when the run starts, so a lap costs a clock read and nothing else.
pub fn laps(prefix: &'static str) -> impl FnMut(&str) {
    let profile = std::env::var_os("BOWERBIRD_DECODE_PROFILE").is_some();
    let recording = RECORDING.load(std::sync::atomic::Ordering::Relaxed);
    let mut mark = Mark::now();
    move |name: &str| {
        let taken = mark.elapsed();
        if profile {
            eprintln!("{prefix}{name}: {}ms", taken.as_millis());
        }
        if recording {
            KEPT.lock().unwrap_or_else(|held| held.into_inner()).push((
                prefix,
                name.to_string(),
                taken.as_secs_f64() * 1000.0,
            ));
        }
        mark = Mark::now();
    }
}

/// Whether [`laps`] keeps what it times as well as printing it.
///
/// Off, and only the benchmark turns it on. Every lap would otherwise push a `String` onto a
/// process-wide vector that nothing in a server ever drains.
static RECORDING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

// `allow`, not `expect`: whether this counts as complex moves between clippy releases.
#[allow(clippy::type_complexity)]
static KEPT: std::sync::Mutex<Vec<(&'static str, String, f64)>> = std::sync::Mutex::new(Vec::new());

/// Whether a reader is watching the laps closely enough to be worth stalling the device for.
///
/// A lap around recorded-but-unsubmitted GPU work times the recording, not the work: measured on a
/// 61MP rendition, the coding, the defringe and the warp reported 3.4ms between them and the grade
/// that followed reported 421, because the grade was the first thing in the job to wait on the
/// queue. `Gpu::settle` is what closes that, and this is how it knows to.
///
/// **The profile switch alone, deliberately not [`record`].** The waits cost the pipeline its
/// overlap between submissions - 3 to 6% of the total, measured - and the benchmark's job is the
/// total. So the ratchet keeps timing the pipeline that ships and reads the stage split as a
/// rough division, and a reader who wants the split to be true asks for it with
/// `BOWERBIRD_DECODE_PROFILE` and accepts the slower run that comes with it.
pub fn watched() -> bool {
    std::env::var_os("BOWERBIRD_DECODE_PROFILE").is_some()
}

/// Keep every lap from here on, for a caller that wants the stages as numbers rather than as lines.
///
/// Read once per `laps` call, so a stage already underway when this is set reports nothing - which
/// is why the benchmark asks before its first render rather than between rounds.
pub fn record() {
    RECORDING.store(true, std::sync::atomic::Ordering::Relaxed);
}

/// Every lap since this was last asked, in milliseconds, taken rather than read.
pub fn taken() -> Vec<(&'static str, String, f64)> {
    std::mem::take(&mut *KEPT.lock().unwrap_or_else(|held| held.into_inner()))
}
