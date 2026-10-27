//! The sensor's photosites into RGB: the pattern, the conditioning, the highlight field and the
//! two demosaics.

#![deny(unsafe_code)]

/// Which colour each photosite carries, as a period rather than as a 2x2.
pub mod cfa;
/// The sensor's samples into the mosaic, with the samples crossing to the GPU rather than it.
pub mod condition;
pub mod demosaic;
pub mod highlight;
/// Demosaicing by luma-chroma demultiplexing, for the patterns RCD cannot pair into 2x2 sites.
pub mod lslcd;

#[cfg(test)]
mod tests {
    /// Every uniform block, against the struct the shader declares (`shaders::layout`).
    #[test]
    fn every_uniform_is_the_size_its_shader_reads() {
        shaders::layout::check(&[
            (
                "assemble.wgsl",
                "Params",
                shaders::ASSEMBLE.source,
                crate::demosaic::assemble_block(),
            ),
            // `mosaic.slang`'s block, which both demosaics take as group 0. Read out of RCD's
            // module because a module is only laid out in a program that uses it.
            (
                "rcd.wgsl",
                "Shape",
                shaders::RCD.source,
                crate::cfa::shape_block(),
            ),
            (
                "highlight_field.wgsl",
                "Field",
                shaders::HIGHLIGHT_FIELD.source,
                crate::highlight::params_block(),
            ),
            (
                "lslcd.wgsl",
                "Params",
                shaders::LSLCD.source,
                crate::lslcd::params_block(),
            ),
        ]);
    }
}
