//! What the pipeline says about itself: the lines it logs, the stages it times and how far it
//! has got.

#![deny(unsafe_code)]

pub mod clock;
/// How far the work somebody is waiting on has got, read from outside the call doing it.
pub mod progress;

/// A line about something the pipeline declined to do, where the reader will actually see it.
///
/// **`eprintln!` is dropped on `wasm32-unknown-unknown`**, whose std has no stderr behind it - so
/// the announcements that exist to stop a fall-through being silent were silent in the one host
/// that has the most to fall through to. The console is where a page's are.
///
/// Held for [`take_log`] once the server has asked for them, so they reach its log; stderr
/// until then, which is where a test or an example reads them.
pub fn warn(message: &str) {
    #[cfg(target_arch = "wasm32")]
    console::warn(message);
    #[cfg(not(target_arch = "wasm32"))]
    log::keep(log::Level::Warn, message);
}

/// A line worth knowing that is not a problem, on the same terms as [`warn`].
pub fn info(message: &str) {
    #[cfg(target_arch = "wasm32")]
    console::info(message);
    #[cfg(not(target_arch = "wasm32"))]
    log::keep(log::Level::Info, message);
}

/// Moves as many whole held lines as fit into `out`, newline-separated, and returns the bytes
/// written; from the first call on, lines are held rather than printed.
#[cfg(not(target_arch = "wasm32"))]
pub fn take_log(out: &mut [u8]) -> usize {
    log::take(out)
}

#[cfg(not(target_arch = "wasm32"))]
mod log {
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, Ordering};

    const LINES_HELD: usize = 1000;

    static HELD: Held = Held::new();

    /// Held as the line's first character, which `rawshim.ts` reads back off.
    #[derive(Clone, Copy)]
    pub(crate) enum Level {
        Info,
        Warn,
    }

    pub(crate) fn keep(level: Level, message: &str) {
        HELD.keep(level, message);
    }

    pub(crate) fn take(out: &mut [u8]) -> usize {
        HELD.take(out)
    }

    struct Held {
        claimed: AtomicBool,
        lines: Mutex<Vec<String>>,
    }

    impl Held {
        const fn new() -> Self {
            Self {
                claimed: AtomicBool::new(false),
                lines: Mutex::new(Vec::new()),
            }
        }

        fn keep(&self, level: Level, message: &str) {
            if !self.claimed.load(Ordering::Relaxed) {
                eprintln!("{message}");
                return;
            }
            let Ok(mut lines) = self.lines.lock() else {
                return;
            };
            if lines.len() < LINES_HELD {
                let marker = match level {
                    Level::Info => 'I',
                    Level::Warn => 'W',
                };
                // One line each: the reader splits on newlines and reads each one's marker.
                lines.push(format!("{marker}{}", message.replace('\n', " ")));
            }
        }

        fn take(&self, out: &mut [u8]) -> usize {
            self.claimed.store(true, Ordering::Relaxed);
            if out.is_empty() {
                return 0;
            }
            let Ok(mut lines) = self.lines.lock() else {
                return 0;
            };
            let mut written = 0;
            let mut taken = 0;
            for line in lines.iter() {
                let separator = usize::from(written > 0);
                if separator + line.len() > out.len() - written {
                    if taken == 0 {
                        let cut = (0..=out.len())
                            .rev()
                            .find(|&at| line.is_char_boundary(at))
                            .unwrap_or(0);
                        out[..cut].copy_from_slice(&line.as_bytes()[..cut]);
                        written = cut;
                        taken = 1;
                    }
                    break;
                }
                if separator == 1 {
                    out[written] = b'\n';
                }
                out[written + separator..written + separator + line.len()]
                    .copy_from_slice(line.as_bytes());
                written += separator + line.len();
                taken += 1;
            }
            lines.drain(..taken);
            written
        }
    }

    #[cfg(test)]
    mod tests {
        use super::{Held, Level};

        #[test]
        fn held_lines_come_out_whole_and_in_order() {
            let held = Held::new();
            held.keep(Level::Warn, "before the claim goes to stderr");
            let mut out = [0u8; 14];
            assert_eq!(held.take(&mut out), 0);
            held.keep(Level::Info, "first");
            held.keep(Level::Warn, "second");
            held.keep(Level::Warn, "a line longer\nthan the buffer");
            let written = held.take(&mut out);
            assert_eq!(&out[..written], b"Ifirst\nWsecond");
            let written = held.take(&mut out);
            assert_eq!(&out[..written], b"Wa line longer");
            assert_eq!(held.take(&mut out), 0);
        }
    }
}

#[cfg(target_arch = "wasm32")]
mod console {
    #[wasm_bindgen::prelude::wasm_bindgen]
    extern "C" {
        #[wasm_bindgen(js_namespace = console)]
        pub fn warn(message: &str);
        #[wasm_bindgen(js_namespace = console)]
        pub fn info(message: &str);
    }
}
