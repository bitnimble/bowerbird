//! What a uniform block is, according to the shader that reads it.
//!
//! **Every one of these is written twice**: a `struct` in the shader and a run of `to_le_bytes` on
//! the host. The uniform layout rules are not the obvious ones - a `uint3` aligns to sixteen, an
//! array of scalars strides its elements by sixteen, and a struct rounds its own size up to
//! sixteen - so a field added or reordered on one side moves everything below it on that side only,
//! and nothing objects: the buffer is a legal length, the shader reads the padding, and the picture
//! is quietly wrong.
//!
//! So the shader is asked rather than matched. `naga` lays out the module the host actually builds;
//! the host's builder is run and its bytes counted. No table to keep in step.
//!
//! Size rather than field-by-field offsets, deliberately: the offsets follow from the field list,
//! which `the_uniform_matches_the_shader_struct` already pins for the one struct big enough to be
//! worth naming a field at a time. What every other struct needs is the tail check, which is the
//! part a human gets wrong.

/// The bytes a uniform block occupies, by the shader's own rules.
///
/// `source` is the module as the host composes it, since a struct can only be laid out in the
/// program it belongs to. `name` is the struct's, not the binding's.
fn uniform_size(source: &str, name: &str) -> Result<usize, String> {
    let module = naga::front::wgsl::parse_str(source).map_err(|e| {
        format!(
            "{name}: the module does not parse: {}",
            e.emit_to_string(source)
        )
    })?;
    let mut layouter = naga::proc::Layouter::default();
    layouter
        .update(module.to_ctx())
        .map_err(|e| format!("{name}: the module does not lay out: {e}"))?;

    // **Matched on a prefix, because the generated module renames.** Slang emits a uniform block as
    // `Params_std140_0` - its own layout of the struct, computed rather than written - so this asks
    // the module which block it has rather than restating the mangling.
    let (handle, _) = module
        .types
        .iter()
        .find(|(_, ty)| ty.name.as_deref().is_some_and(|it| it.starts_with(name)))
        .ok_or_else(|| format!("{name}: no such type in the module"))?;

    // **Rounded to sixteen, which `Layouter` does not do.** It reports the type's natural size -
    // `Reduction`'s two `vec2u` and a `vec2f` are 24 - and the *uniform* address space then rounds a
    // struct's alignment up to sixteen and its size with it, which is the 32 the host writes and the
    // binding wants. Getting this wrong the other way is the same silent gap the whole file is
    // about, so it is stated here rather than absorbed into each caller's padding.
    Ok((layouter[handle].size as usize).next_multiple_of(16))
}

#[cfg(test)]
mod tests {
    /// Every uniform block, against the struct the shader declares.
    ///
    /// The builders are called with whatever arguments produce a block - none of them branch on a
    /// value, they all write a fixed run of words - so the length is the whole of what is asked.
    #[test]
    fn every_uniform_is_the_size_its_shader_reads() {
        assert_eq!(crate::print::Scene::default().uniform(crate::light::Light::ZERO).len(), 112);
        // The blocks whose bytes a function returns. `base.rs` builds its other four inline into
        // the buffer they go to, so there is nothing to call and no length to take; extract them
        // the same way when one is next touched and add a line here.
        let cases: Vec<(&str, &str, String, usize)> = vec![
            (
                "print_light_calibrate.wgsl",
                "Lamp",
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/print_light_calibrate.wgsl")).to_string(),
                crate::print::light_uniform(crate::print::Scene::default().light_parameters(), 6500.0).len(),
            ),
            (
                "frame.wgsl",
                "PrintParams",
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/frame.wgsl")).to_string(),
                crate::print::Scene::default().uniform(crate::light::Light::ZERO).len(),
            ),
            (
                "assemble.wgsl",
                "Params",
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/assemble.wgsl")).to_string(),
                crate::demosaic::assemble_block(),
            ),
            // `mosaic.slang`'s block, which both demosaics take as group 0. Read out of RCD's
            // module because a module is only laid out in a program that uses it.
            (
                "assembly_levels.wgsl",
                "Params",
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/assembly_levels.wgsl")).to_string(),
                crate::assembly_levels::params_block(),
            ),
            (
                "assembly_blend.wgsl",
                "Params",
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/assembly_blend.wgsl")).to_string(),
                crate::assembly_blend::params_block(),
            ),
            (
                "assembly_weight.wgsl",
                "Params",
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/assembly_weight.wgsl")).to_string(),
                crate::assembly_weight::params_block(),
            ),
            (
                "composite_gather.wgsl",
                "Params",
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/composite_gather.wgsl")).to_string(),
                crate::composite_tile::params_block(),
            ),
            (
                "composite_blend.wgsl",
                "Params",
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/composite_blend.wgsl")).to_string(),
                crate::composite_tile::blend_block(),
            ),
            (
                "composite_sharpness.wgsl",
                "Params",
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/composite_sharpness.wgsl")).to_string(),
                crate::composite_tile::sharpness_block(),
            ),
            (
                "pixel_shift.wgsl",
                "Params",
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/pixel_shift.wgsl")).to_string(),
                crate::pixel_shift::scatter_block(),
            ),
            (
                "pixel_shift_settle.wgsl",
                "Params",
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/pixel_shift_settle.wgsl")).to_string(),
                crate::pixel_shift::settle_block(),
            ),
            (
                "rcd.wgsl",
                "Shape",
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/rcd.wgsl")).to_string(),
                crate::cfa::shape_block(),
            ),
            (
                "lslcd.wgsl",
                "Params",
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/lslcd.wgsl")).to_string(),
                crate::lslcd::params_block(),
            ),
            (
                "dust.wgsl",
                "Params",
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/dust.wgsl")).to_string(),
                crate::dust::params_block(),
            ),
            (
                "fit_wide.wgsl",
                "Params",
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/fit_wide.wgsl")).to_string(),
                crate::fit_wide::params_block(),
            ),
            (
                "repair.wgsl",
                "Params",
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/repair.wgsl")).to_string(),
                crate::repair::params_block(),
            ),
            (
                "copy_rect.wgsl",
                "Params",
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/copy_rect.wgsl")).to_string(),
                crate::retouched_frame::params_block(),
            ),
            (
                "reduce.wgsl",
                "Reduction",
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/reduce.wgsl")).to_string(),
                crate::base::REDUCTION_BYTES,
            ),
            (
                "fit_pairs.wgsl",
                "Params",
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/fit_pairs.wgsl")).to_string(),
                crate::fit_pairs::params_block(),
            ),
            (
                "linearise.wgsl",
                "Params",
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/linearise.wgsl")).to_string(),
                crate::linearise::BLOCK_BYTES,
            ),
            (
                "planes.wgsl",
                "Params",
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/planes.wgsl")).to_string(),
                crate::planes::BLOCK_BYTES,
            ),
        ];

        for (file, name, source, wrote) in cases {
            let wants =
                super::uniform_size(&source, name).unwrap_or_else(|why| panic!("{file}: {why}"));
            assert_eq!(
                wrote, wants,
                "{file}'s {name} is {wants} bytes and the host writes {wrote}. WGSL rounds a \
                 uniform struct to sixteen and aligns a vector to its own width, so a field added \
                 or reordered moves the tail on one side only.",
            );
        }
    }
}
