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
    let mut mark = Mark::now();
    move |name: &str| {
        if profile {
            eprintln!("{prefix}{name}: {}ms", mark.elapsed().as_millis());
        }
        mark = Mark::now();
    }
}
