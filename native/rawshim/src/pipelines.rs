use gpu::Gpu;

/// Builds every pipeline the page's module can dispatch; PMRID's only once its weights are held.
///
/// A builder missing from here compiles on the draw that first reaches it, freezing the page.
pub fn build_every_pipeline(gpu: &'static Gpu) {
    render::grade::device(gpu).build_deferred_pipelines();
    render::base::device(gpu);
    mosaic::condition::device(gpu);
    mosaic::demosaic::device(gpu);
    denoise::dust::device(gpu);
    denoise::dust_find::device(gpu);
    denoise::galosh::device(gpu);
    mosaic::highlight::device(gpu);
    crate::linearise::device(gpu);
    mosaic::lslcd::device(gpu);
    formats::planes::kernel(gpu);
    denoise::pmrid::device(gpu);
    crate::repair::averaging(gpu);
    crate::repair::repairing(gpu);
    crate::retouched_frame::copying(gpu);
    colour::white_balance::device(gpu);
    fit::build_pipelines(gpu);
    colour::lattice::bake_kernel(gpu);
    render::grade::device(gpu).colour_wheel();
}

#[cfg(test)]
mod tests {
    #[test]
    fn every_pipeline_builds() {
        super::build_every_pipeline(gpu::device().expect("a GPU adapter"));
    }
}
