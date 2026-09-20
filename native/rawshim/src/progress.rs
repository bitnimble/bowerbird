//! How far a job has got, readable while it is still running.
//!
//! A job is one blocking call across the FFI, so the thread that asked for it cannot report on it;
//! this is what another thread reads instead. One cell for the process, so only the job somebody is
//! waiting on - the one that asked with `Job::report_progress` - counts itself here, and every other
//! job's steps go nowhere.
//!
//! **Owned by the counting job's thread, not by whichever job touches it.** Every job on every
//! worker passes through the same `begin` and `advance`: a grid tile of an older merge rendering
//! beside a carve would otherwise restart the reader's bar from nought.

use std::cell::Cell;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

thread_local! {
    static COUNTS: Cell<bool> = const { Cell::new(false) };
}

/// Runs `job` with its steps counted in the cell where `counts`, and not at all otherwise, leaving
/// the cell clear behind a job that counted however it ended.
pub fn counted<T>(counts: bool, job: impl FnOnce() -> T) -> T {
    COUNTS.set(counts);
    if counts {
        // A cancel that landed after the last job returned was meant for that one.
        CANCELLED.store(false, Ordering::Relaxed);
    }
    let out = job();
    if counts {
        PACKED.store(0, Ordering::Relaxed);
    }
    COUNTS.set(false);
    out
}

/// `done` in the high word and `total` in the low one, so a reader gets both from one load and
/// never sees a count from one pass against a total from the next.
static PACKED: AtomicU64 = AtomicU64::new(0);

/// Whether the counting job has been told to stop, read at the boundaries a long pass already
/// crosses. A blocking call across the FFI cannot be interrupted from outside it, so cancelling one
/// is the library agreeing to look.
static CANCELLED: AtomicBool = AtomicBool::new(false);

/// Starts a pass of `total` steps. A total of zero means nothing is running.
///
/// **A pass already running is left alone**, so a stage that is also a phase of something larger
/// counts into the outer pass rather than restarting it. The align is both: a panorama asks for it
/// on its own, and §3 asks for it as the first third of a carve - and when it restarted the count
/// the reader watched the bar reach a sixth and then sit there for the two thirds that report
/// nothing. [`counted`] clears the cell when the job ends, so nothing outlives the job that began it.
pub fn begin(total: usize) {
    if !COUNTS.get() || PACKED.load(Ordering::Relaxed) as u32 != 0 {
        return;
    }
    PACKED.store(total.min(u32::MAX as usize) as u64, Ordering::Relaxed);
}

pub fn cancel() {
    CANCELLED.store(true, Ordering::Relaxed);
}

/// Whether this thread's job is the counting one and has been told to stop; a job nobody is
/// watching is never the one a cancel meant.
pub fn cancelled() -> bool {
    COUNTS.get() && CANCELLED.load(Ordering::Relaxed)
}

pub fn advance() {
    if !COUNTS.get() {
        return;
    }
    let _ = PACKED.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |packed| {
        let total = packed as u32;
        let done = (packed >> 32) as u32;
        (done < total).then(|| u64::from(done + 1) << 32 | u64::from(total))
    });
}

pub fn packed() -> u64 {
    PACKED.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;

    // One test, because the cell is the process's and tests run side by side.
    #[test]
    fn only_the_counting_job_moves_the_cell() {
        counted(true, || {
            begin(3);
            for _ in 0..5 {
                advance();
            }
            assert_eq!(packed(), 3 << 32 | 3, "past its total");
        });
        assert_eq!(packed(), 0, "left standing behind its job");

        counted(true, || {
            begin(10);
            advance();
            // A stage that is also a phase of something larger counts into the outer pass.
            begin(3);
            assert_eq!(packed(), 1 << 32 | 10, "the inner total replaced the outer");

            let other = std::thread::spawn(|| {
                counted(false, || {
                    begin(99);
                    advance();
                })
            });
            other.join().expect("the other job");
            assert_eq!(
                packed(),
                1 << 32 | 10,
                "a job nobody watches moved the count"
            );
        });

        // A cancel is the counting job's alone, and survives a pass beginning but not a job.
        cancel();
        assert!(
            !counted(true, cancelled),
            "a job was cancelled by the last one's cancel"
        );
        counted(true, || {
            cancel();
            begin(2);
            assert!(cancelled(), "the job's own begin wiped its cancel");
            let other = std::thread::spawn(|| counted(false, cancelled));
            assert!(
                !other.join().expect("the other job"),
                "a job nobody watches was cancelled"
            );
        });
    }
}
