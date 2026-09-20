//! Decoded regions of a photograph, held so that reaching one again costs neither the read nor
//! the decode.
//!
//! Keyed on the file's own identity and the rectangle, those being everything the decode's answer
//! is a function of. **Not a cache of the file**: a lazy mapping is 20us and the kernel keeps the
//! pages it faulted, so what is worth holding is the decompression rather than the read.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

/// How much decoded region this process holds before the oldest goes.
///
/// Shared by every worker, this being one address space: a budget each would be this times however
/// many threads the pool opened.
const BUDGET_BYTES: usize = 2 * 1024 * 1024 * 1024;

/// One decode of one rectangle, as [`rawler::decoders::Decoder::raw_image_region_tight`] answered
/// it: the frame, and the tile-aligned rectangle it actually covered.
pub struct Region {
    pub image: rawler::RawImage,
    pub covered: rawler::imgop::Rect,
}

impl Region {
    fn bytes(&self) -> usize {
        match &self.image.data {
            rawler::RawImageData::Integer(samples) => samples.len() * 2,
            rawler::RawImageData::Float(samples) => samples.len() * 4,
        }
    }
}

/// What a decoded region is a function of.
///
/// The file by its path, its length and its modification time, so a RAW replaced in place is a
/// different photograph rather than the old one's pixels under the new one's name.
#[derive(Clone, PartialEq, Eq, Hash)]
struct Key {
    path: PathBuf,
    len: u64,
    modified: Option<std::time::Duration>,
    image: usize,
    region: (usize, usize, usize, usize),
}

/// The decode of `region`, from whatever this holds or from `decode`.
///
/// None where `decode` declined, and `decode`'s own answer uncached for a source with no path - a
/// photograph handed over as bytes has no identity to key on, and is a tab's single open anyway.
pub fn region(
    source: &rawler::rawsource::RawSource,
    params: &rawler::decoders::RawDecodeParams,
    region: rawler::imgop::Rect,
    decode: impl FnOnce() -> Option<Region>,
) -> Option<Arc<Region>> {
    let Some(key) = keyed(source, params, region) else {
        return decode().map(Arc::new);
    };
    if let Some(held) = store().lock().ok().and_then(|mut store| store.take(&key)) {
        return Some(held);
    }
    // **Decoded with the lock down.** A region is tens of milliseconds and every worker shares this
    // map, so holding it across the decode would make the pool one thread. Two threads asking for
    // the same rectangle at once therefore both decode it and the second insert replaces the first:
    // a duplicate decode, not a wrong answer.
    let held = Arc::new(decode()?);
    if let Ok(mut store) = store().lock() {
        let bytes = held.bytes();
        store.keep(key, held.clone(), bytes);
    }
    Some(held)
}

fn keyed(
    source: &rawler::rawsource::RawSource,
    params: &rawler::decoders::RawDecodeParams,
    region: rawler::imgop::Rect,
) -> Option<Key> {
    let path = source.path();
    if path.as_os_str().is_empty() {
        return None;
    }
    let file = std::fs::metadata(path).ok()?;
    Some(Key {
        path: path.to_owned(),
        len: file.len(),
        modified: file
            .modified()
            .ok()
            .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok()),
        image: params.image_index,
        region: (region.p.x, region.p.y, region.d.w, region.d.h),
    })
}

fn store() -> &'static Mutex<Store<Arc<Region>>> {
    static CACHE: OnceLock<Mutex<Store<Arc<Region>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(Store::holding(BUDGET_BYTES)))
}

struct Held<V> {
    value: V,
    bytes: usize,
    /// When it was last asked for, so the oldest are the ones that go.
    used: u64,
}

/// What is held, under a budget, oldest out first.
///
/// Generic in `V` so the eviction is tested over a few bytes rather than a few gigabytes of real
/// frames: narrowed to `Arc<Region>`, those tests would need a decode each.
struct Store<V> {
    held: HashMap<Key, Held<V>>,
    budget: usize,
    bytes: usize,
    clock: u64,
}

impl<V: Clone> Store<V> {
    fn holding(budget: usize) -> Store<V> {
        Store { held: HashMap::new(), budget, bytes: 0, clock: 0 }
    }

    fn take(&mut self, key: &Key) -> Option<V> {
        self.clock += 1;
        let clock = self.clock;
        let held = self.held.get_mut(key)?;
        held.used = clock;
        Some(held.value.clone())
    }

    fn keep(&mut self, key: Key, value: V, bytes: usize) {
        if bytes > self.budget {
            return;
        }
        self.clock += 1;
        let used = self.clock;
        if let Some(gone) = self.held.insert(key, Held { value, bytes, used }) {
            self.bytes -= gone.bytes;
        }
        self.bytes += bytes;
        while self.bytes > self.budget {
            let Some(oldest) =
                self.held.iter().min_by_key(|(_, held)| held.used).map(|(key, _)| key.clone())
            else {
                break;
            };
            let Some(gone) = self.held.remove(&oldest) else { break };
            self.bytes -= gone.bytes;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Key, Store};

    fn key(at: usize) -> Key {
        Key {
            path: std::path::PathBuf::from("DSC00853.ARW"),
            len: 91028330,
            modified: None,
            image: 0,
            region: (at, 0, 1024, 1024),
        }
    }

    #[test]
    fn a_region_asked_for_again_outlives_one_that_was_not() {
        let mut store = Store::holding(300);
        store.keep(key(0), "first", 100);
        store.keep(key(1), "second", 100);
        // Asked for again, which is the whole of what makes it newer than the one after it: a
        // reader panning back and forth over a seam wants both ends, not the last thing they saw.
        assert_eq!(store.take(&key(0)), Some("first"));
        store.keep(key(2), "third", 100);
        store.keep(key(3), "fourth", 100);

        assert!(store.bytes <= 300, "{} bytes held against a budget of 300", store.bytes);
        assert_eq!(store.take(&key(3)), Some("fourth"), "the newest went");
        assert_eq!(store.take(&key(0)), Some("first"), "a region asked for again went early");
        assert_eq!(store.take(&key(1)), None, "the oldest stayed");
    }

    /// The one just kept is never the one evicted, however large it is: a caller handed a region
    /// that the insert then dropped would decode it again on the next tick, for ever.
    #[test]
    fn a_region_no_budget_could_hold_costs_nothing_to_refuse() {
        let mut store = Store::holding(300);
        store.keep(key(0), "held", 100);
        store.keep(key(9), "enormous", 4000);
        assert_eq!(store.take(&key(9)), None, "a region larger than the budget was kept");
        assert_eq!(store.take(&key(0)), Some("held"), "refusing one cost what was already there");
        assert_eq!(store.bytes, 100);
    }

    /// A file replaced in place is a different photograph, not the old one's pixels under the new
    /// one's name.
    #[test]
    fn a_rewritten_file_is_a_different_key() {
        let mut store = Store::holding(300);
        store.keep(key(0), "before", 100);
        let after = Key { len: 91028331, ..key(0) };
        assert_eq!(store.take(&after), None);
        store.keep(after.clone(), "after", 100);
        assert_eq!(store.take(&after), Some("after"));
        assert_eq!(store.take(&key(0)), Some("before"));
    }
}
