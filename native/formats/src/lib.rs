//! The file formats: the finished pictures this application reads, and the ones an export writes.

// Unsafe is denied crate-wide and exempted one statement at a time, as rawshim's `lib.rs` sets out.
// Every C handle is owned by a Rust value whose `Drop` frees it - `avif::Image`, `avif::Encoder`,
// `avif_gain_write::GainMap`, `jxl_write::Runner` - so the marked calls are the one that creates
// and the one that frees, and no early return can leak in between.
#![allow(non_upper_case_globals, non_camel_case_types, non_snake_case)]
#![deny(unsafe_code)]
#![deny(unfulfilled_lint_expectations)]
#![deny(unsafe_op_in_unsafe_fn)]

/// The headroom behind Apple's own gain map, which the two maker note tags state between them.
pub mod apple_gain;
#[cfg(feature = "renditions")]
pub mod avif;
/// Writing a gain map beside a picture, which only an export asks for.
#[cfg(feature = "renditions")]
pub mod avif_gain_write;
pub mod exif;
pub mod gain_map;
pub mod header;
/// A HEIC as the viewer's stage decodes and draws it.
pub mod heif_view;
/// The HEVC bitstream inside a HEIC, into the code values the linearise reads.
pub mod hevc;
pub mod jpeg;
/// The gain map a JPEG carries as its second MPF image, in either spelling of the terms.
pub mod jpeg_gain;
/// The same, in the spelling a JPEG carries it.
#[cfg(feature = "renditions")]
pub mod jpeg_gain_write;
/// JPEG XL, the same.
#[cfg(feature = "renditions")]
pub mod jxl_write;
/// Which way up a file says its picture goes, in the numbering both hosts and both shaders use.
pub mod orientation;
pub mod planes;
/// PNG, which an export can ask for and nothing else writes.
#[cfg(feature = "renditions")]
pub mod png_write;
/// The photographs that arrive already rendered, read off their files: PNG, JPEG, HEIC and AVIF.
pub mod rendered;
/// A picture resized, and a finished file decoded to a bounded size.
pub mod resize;
pub mod still;
/// TIFF, the same.
#[cfg(feature = "renditions")]
pub mod tiff_write;

/// libavif, libjxl and libjpeg-turbo, which only a `renditions` build binds. An editor build links
/// no C at all and so has no bindings to declare.
#[cfg(test)]
mod tests {
    /// Every uniform block, against the struct the shader declares (`shaders::layout`).
    #[test]
    fn every_uniform_is_the_size_its_shader_reads() {
        shaders::layout::check(&[(
            "planes.wgsl",
            "Params",
            shaders::PLANES.source,
            crate::planes::BLOCK_BYTES,
        )]);
    }
}

#[cfg(feature = "renditions")]
pub mod raw {
    #![allow(
        non_upper_case_globals,
        non_camel_case_types,
        non_snake_case,
        dead_code
    )]
    #![expect(unsafe_code)]
    include!(concat!(env!("OUT_DIR"), "/bindings.rs"));
}
