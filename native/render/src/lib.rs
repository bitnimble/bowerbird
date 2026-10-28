//! The render below the decode: the coded base and its stages, the detail passes, the grade and the
//! print, on whatever GPU this machine has, from the shaders the editor runs.

#![deny(unsafe_code)]
#![deny(unfulfilled_lint_expectations)]
#![deny(unsafe_op_in_unsafe_fn)]

/// The stages between the demosaic and the grade, moving onto the GPU one at a time.
pub mod base;
pub mod detail;
pub mod grade;
pub mod print;
pub mod printer_gamut;

#[cfg(test)]
mod tests {
    /// The builders are called with whatever arguments produce a block - none of them branch on a
    /// value, they all write a fixed run of words - so the length is the whole of what is asked.
    #[test]
    fn every_uniform_is_the_size_its_shader_reads() {
        let print = crate::print::Scene::default()
            .uniform(units::light::Light::ZERO)
            .len();
        assert_eq!(print, 112);
        // The blocks whose bytes a function returns. `base.rs` builds its other four inline into
        // the buffer they go to, so there is nothing to call and no length to take; extract them
        // the same way when one is next touched and add a line here.
        shaders::layout::check(&[
            (
                "print_light_calibrate.wgsl",
                "Lamp",
                shaders::PRINT_LIGHT_CALIBRATE.source,
                crate::print::light_uniform(
                    crate::print::Scene::default().light_parameters(),
                    6500.0,
                )
                .len(),
            ),
            ("frame.wgsl", "PrintParams", shaders::FRAME.source, print),
            (
                "reduce.wgsl",
                "Reduction",
                shaders::REDUCE.source,
                crate::base::REDUCTION_BYTES,
            ),
        ]);
    }
}
