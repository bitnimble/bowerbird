//! The denoises, on the mosaic before anything has averaged a neighbour into it, and the sensor
//! dust found and divided out of it beside them.

#![deny(unsafe_code)]

/// Sensor particles found on the mosaic, and their shadows divided back out of it.
pub mod dust;
/// The search half of that, dispatched on the device the mosaic is already on.
pub mod dust_find;
/// The denoise, on the mosaic, before anything has averaged a neighbour into it.
pub mod galosh;
/// The other denoise, in the same place: a learned network a reader can choose instead.
pub mod pmrid;
pub mod upscale;

#[cfg(test)]
mod tests {
    #[test]
    fn every_uniform_is_the_size_its_shader_reads() {
        shaders::layout::check(&[(
            "dust.wgsl",
            "Params",
            shaders::DUST.source,
            crate::dust::params_block(),
        )]);
    }
}
