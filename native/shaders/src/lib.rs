//! Every shader in `slang/`, compiled to the WGSL both hosts run.
//!
//! The browser's build compiles the same files with the same compiler
//! (`scripts/build-web-shaders.ts`), so the module the page runs and the module a rendition runs are
//! the same bytes. A copy beside either host would pass every test it had while diverging from what
//! ships.

#![deny(unsafe_code)]

#[cfg(feature = "layout")]
pub mod layout;
pub mod overrides;

/// One compiled WGSL file.
#[derive(Clone, Copy, Debug)]
pub struct Module {
    /// Under the compiled tree, with `/`: frame.wgsl, galosh/pyr_pack.wgsl.
    pub path: &'static str,
    pub source: &'static str,
}

impl Module {
    /// The file's name without its directory or extension, which is also the entry point of every
    /// shader that has one.
    pub fn stem(&self) -> &'static str {
        let file = self.path.rsplit('/').next().unwrap_or(self.path);
        file.strip_suffix(".wgsl").unwrap_or(file)
    }

    /// `constants` where `entry` reads them, and none where it does not ([`overrides`]).
    pub fn constants_for<'a>(
        &self,
        entry: &str,
        constants: &'a [(&'a str, f64)],
    ) -> &'a [(&'a str, f64)] {
        match overrides::reads_overrides(self.path, entry) {
            true => constants,
            false => &[],
        }
    }
}

include!(concat!(env!("OUT_DIR"), "/shaders.rs"));
