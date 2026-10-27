//! The camera match: the lens and the colour treatment a RAW's render is fitted to from the
//! camera's own JPEG, and what is measured about a photograph on the way.

#![deny(unsafe_code)]

mod curve;
pub mod hdr;
mod lattice;
mod moments;
mod objective;
mod pairs;
pub mod photo_analysis;
pub mod profile;
pub mod score;
pub mod source;
mod span;
pub mod tca;
pub mod tca_device;
mod wide;

/// Builds every pipeline the fit dispatches, for a page that must not compile one mid-draw.
pub fn build_pipelines(gpu: &'static gpu::Gpu) {
    tca_device::kernels(gpu);
    profile::resamplers(gpu);
    curve::kernels(gpu);
    lattice::kernels(gpu);
    moments::kernel(gpu);
    objective::kernels(gpu);
    pairs::kernels(gpu);
    score::kernel(gpu);
    source::kernels(gpu);
    span::kernels(gpu);
    wide::kernels(gpu);
    hdr::box_device(gpu);
    hdr::gather_device(gpu);
    hdr::model_device(gpu);
    hdr::packed_box_device(gpu);
    hdr::register_device(gpu);
    hdr::search_device(gpu);
    hdr::stats_device(gpu);
    hdr::warp_device(gpu);
}

#[cfg(test)]
mod tests {
    /// Every uniform block, against the struct the shader declares (`shaders::layout`).
    #[test]
    fn every_uniform_is_the_size_its_shader_reads() {
        shaders::layout::check(&[
            (
                "fit_wide.wgsl",
                "Params",
                shaders::FIT_WIDE.source,
                crate::wide::params_block(),
            ),
            (
                "fit_pairs.wgsl",
                "Params",
                shaders::FIT_PAIRS.source,
                crate::pairs::params_block(),
            ),
            (
                "fit_lattice.wgsl",
                "Params",
                shaders::FIT_LATTICE.source,
                crate::lattice::params_block(),
            ),
        ]);
    }
}
