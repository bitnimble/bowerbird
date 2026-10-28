//! Several photographs into one: aligned into a recipe, rendered window by window, and the
//! assemblies and repairs that cut between them along solved seams.

#![deny(unsafe_code)]

/// A set of photographs into a recipe: what overlaps what, and where each one points.
pub mod align;
/// A composition's geometry, and the tiles across it that each take one frame.
pub mod assembly;
/// Corners of a frame and what each one looks like, so a match can be asked whether it is *unique*
/// - which is the one thing a correlation search cannot say.
pub mod features;
/// What two frames of a composite have in common: how far apart they sit, and where their content
/// corresponds once that is known.
pub mod pairs;
/// Where a patch of one frame lies in another, or elsewhere in its own.
pub mod patch_search;
pub mod repair;
pub mod retouched_frame;
/// A world, and what a camera pointed at it would have recorded: the synthetic views a composite's
/// alignment is exercised against, and the library the end-to-end suite composes one out of.
pub mod scene;
/// Where each frame of a composite points, and how long the lens was, from what the pairs found.
pub mod solve;
/// One rectangle of a composite's canvas, gathered source by source and blended.
pub mod tile;

#[cfg(test)]
mod tests {
    #[test]
    fn every_uniform_is_the_size_its_shader_reads() {
        shaders::layout::check(&[
            (
                "assembly_levels.wgsl",
                "Params",
                shaders::ASSEMBLY_LEVELS.source,
                crate::assembly::levels::params_block(),
            ),
            (
                "assembly_blend.wgsl",
                "Params",
                shaders::ASSEMBLY_BLEND.source,
                crate::assembly::blend::params_block(),
            ),
            (
                "assembly_weight.wgsl",
                "Params",
                shaders::ASSEMBLY_WEIGHT.source,
                crate::assembly::weight::params_block(),
            ),
            (
                "composite_gather.wgsl",
                "Params",
                shaders::COMPOSITE_GATHER.source,
                crate::tile::params_block(),
            ),
            (
                "composite_blend.wgsl",
                "Params",
                shaders::COMPOSITE_BLEND.source,
                crate::tile::blend_block(),
            ),
            (
                "repair.wgsl",
                "Params",
                shaders::REPAIR.source,
                crate::repair::params_block(),
            ),
            (
                "copy_rect.wgsl",
                "Params",
                shaders::COPY_RECT.source,
                crate::retouched_frame::params_block(),
            ),
        ]);
    }
}
