use gpu::Gpu;

/// Builds every pipeline the page's module can dispatch; PMRID's only once its weights are held.
///
/// A builder missing from here compiles on the draw that first reaches it, freezing the page.
pub fn build_every_pipeline(gpu: &'static Gpu) {
    crate::grade::device(gpu).build_deferred_pipelines();
    crate::base::device(gpu);
    mosaic::condition::device(gpu);
    mosaic::demosaic::device(gpu);
    denoise::dust::device(gpu);
    denoise::dust_find::device(gpu);
    denoise::galosh::device(gpu);
    mosaic::highlight::device(gpu);
    crate::linearise::device(gpu);
    mosaic::lslcd::device(gpu);
    crate::planes::kernel(gpu);
    denoise::pmrid::device(gpu);
    crate::repair::averaging(gpu);
    crate::repair::repairing(gpu);
    crate::retouched_frame::copying(gpu);
    crate::tca_device::kernels(gpu);
    colour::white_balance::device(gpu);
    crate::fit::resamplers(gpu);
    crate::fit_curve::kernels(gpu);
    crate::fit_lattice::kernels(gpu);
    crate::fit_moments::kernel(gpu);
    crate::fit_objective::kernels(gpu);
    crate::fit_pairs::kernels(gpu);
    crate::fit_score::kernel(gpu);
    crate::fit_source::kernels(gpu);
    crate::fit_span::kernels(gpu);
    crate::fit_wide::kernels(gpu);
    crate::hdr_fit::box_device(gpu);
    crate::hdr_fit::gather_device(gpu);
    crate::hdr_fit::model_device(gpu);
    crate::hdr_fit::packed_box_device(gpu);
    crate::hdr_fit::register_device(gpu);
    crate::hdr_fit::search_device(gpu);
    crate::hdr_fit::stats_device(gpu);
    crate::hdr_fit::warp_device(gpu);
    colour::lattice::bake_kernel(gpu);
    crate::grade::device(gpu).colour_wheel();
}

#[cfg(test)]
mod tests {
    #[test]
    fn every_pipeline_builds() {
        super::build_every_pipeline(gpu::device().expect("a GPU adapter"));
    }
}
