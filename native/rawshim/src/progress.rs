//! How far a job has got, readable while it is still running, and whether it has been told to stop.
//!
//! A job is one blocking call across the FFI, so the thread that asked for it cannot report on it;
//! this is what another thread reads instead. A job somebody is watching runs under an id its caller
//! chose (`Job::progress_id`), and that id names its cell: two watched jobs at once each count and
//! stop alone. Every other job's steps go nowhere.
//!
//! **Owned by the counting job's thread, not by whichever job touches it.** Every job on every
//! worker passes through the same `begin` and `advance`: a grid tile of an older merge rendering
//! beside a carve would otherwise restart the reader's bar from nought.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

#[derive(Default)]
struct Cell {
    /// `done` in the high word and `total` in the low one, so a reader gets both from one load and
    /// never sees a count from one pass against a total from the next.
    packed: AtomicU64,
    cancel_asked: AtomicBool,
}

static WATCHED: Mutex<BTreeMap<u32, Arc<Cell>>> = Mutex::new(BTreeMap::new());

thread_local! {
    static CURRENT: RefCell<Option<Arc<Cell>>> = const { RefCell::new(None) };
}

fn watched() -> MutexGuard<'static, BTreeMap<u32, Arc<Cell>>> {
    WATCHED.lock().unwrap_or_else(PoisonError::into_inner)
}

fn with_current<T>(read: impl FnOnce(&Cell) -> T) -> Option<T> {
    CURRENT.with_borrow(|current| current.as_deref().map(read))
}

/// Runs `job` with its steps counted under `id`, and not at all without one, leaving nothing
/// behind however it ended.
pub fn counted<T>(id: Option<u32>, job: impl FnOnce() -> T) -> T {
    let Some(id) = id else {
        return job();
    };
    let cell = Arc::new(Cell::default());
    watched().insert(id, cell.clone());
    CURRENT.set(Some(cell));
    let out = job();
    CURRENT.set(None);
    watched().remove(&id);
    out
}

/// Starts a pass of `total` steps. A total of zero means nothing is running.
///
/// **A pass already running is left alone**, so a stage that is also a phase of something larger
/// counts into the outer pass rather than restarting it. The align is both: a panorama asks for it
/// on its own, and §3 asks for it as the first third of a carve - and when it restarted the count
/// the reader watched the bar reach a sixth and then sit there for the two thirds that report
/// nothing.
pub fn begin(total: usize) {
    with_current(|cell| {
        let fresh = total.min(u32::MAX as usize) as u64;
        let _ = cell
            .packed
            .compare_exchange(0, fresh, Ordering::Relaxed, Ordering::Relaxed);
    });
}

pub fn advance() {
    with_current(|cell| {
        let _ = cell
            .packed
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |packed| {
                let total = packed as u32;
                let done = (packed >> 32) as u32;
                (done < total).then(|| u64::from(done + 1) << 32 | u64::from(total))
            });
    });
}

/// The count of the job running under `id`, or zero where none is.
pub fn packed(id: u32) -> u64 {
    watched()
        .get(&id)
        .map_or(0, |cell| cell.packed.load(Ordering::Relaxed))
}

/// Tells the job running under `id` to stop at its next boundary. Nothing happens where none is
/// running yet, so a caller cancelling a job it has only just posted asks again until it is.
pub fn cancel(id: u32) {
    if let Some(cell) = watched().get(&id) {
        cell.cancel_asked.store(true, Ordering::Relaxed);
    }
}

/// What a job a cancel reached fails with. The job answers it verbatim, which is how the server
/// tells a cancel from a failure (`rawshim_job.ts`).
pub const CANCELLED: &str = "cancelled";

pub fn cancelled() -> bool {
    with_current(|cell| cell.cancel_asked.load(Ordering::Relaxed)).unwrap_or(false)
}

pub fn stop_if_cancelled() -> Result<(), String> {
    match cancelled() {
        true => Err(CANCELLED.to_string()),
        false => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_job_under_an_id_moves_its_count() {
        counted(Some(1), || {
            begin(3);
            for _ in 0..5 {
                advance();
            }
            assert_eq!(packed(1), 3 << 32 | 3, "past its total");
        });
        assert_eq!(packed(1), 0, "left standing behind its job");

        counted(Some(2), || {
            begin(10);
            advance();
            // A stage that is also a phase of something larger counts into the outer pass.
            begin(3);
            assert_eq!(packed(2), 1 << 32 | 10, "the inner total replaced the outer");

            let other = std::thread::spawn(|| {
                counted(None, || {
                    begin(99);
                    advance();
                })
            });
            other.join().expect("the other job");
            assert_eq!(packed(2), 1 << 32 | 10, "a job nobody watches moved the count");
        });
    }

    #[test]
    fn a_cancel_reaches_only_the_job_it_names() {
        cancel(3);
        assert!(
            !counted(Some(3), cancelled),
            "a cancel sent before its job ran was kept for it"
        );

        let (started, start) = std::sync::mpsc::channel();
        let (finish, finished) = std::sync::mpsc::channel::<()>();
        let beside = std::thread::spawn(move || {
            counted(Some(5), || {
                started.send(()).expect("the test is waiting");
                finished.recv().expect("the test says when");
                cancelled()
            })
        });
        start.recv().expect("the job beside started");

        counted(Some(4), || {
            cancel(4);
            begin(2);
            assert!(cancelled(), "the job's own begin wiped its cancel");
            let unwatched = std::thread::spawn(|| counted(None, cancelled));
            assert!(
                !unwatched.join().expect("the unwatched job"),
                "a job nobody watches was cancelled"
            );
        });
        finish.send(()).expect("the job beside is waiting");
        assert!(
            !beside.join().expect("the job beside"),
            "a cancel stopped a job it did not name"
        );
    }
}
