//! rawshim's uniform blocks, against the structs their shaders declare (`shaders::layout`).

#[cfg(test)]
mod tests {
    /// Every uniform block, against the struct the shader declares.
    ///
    /// The builders are called with whatever arguments produce a block - none of them branch on a
    /// value, they all write a fixed run of words - so the length is the whole of what is asked.
    #[test]
    fn every_uniform_is_the_size_its_shader_reads() {
        let cases = [
            (
                "assembly_levels.wgsl",
                "Params",
                shaders::ASSEMBLY_LEVELS.source,
                crate::assembly_levels::params_block(),
            ),
            (
                "assembly_blend.wgsl",
                "Params",
                shaders::ASSEMBLY_BLEND.source,
                crate::assembly_blend::params_block(),
            ),
            (
                "assembly_weight.wgsl",
                "Params",
                shaders::ASSEMBLY_WEIGHT.source,
                crate::assembly_weight::params_block(),
            ),
            (
                "composite_gather.wgsl",
                "Params",
                shaders::COMPOSITE_GATHER.source,
                crate::composite_tile::params_block(),
            ),
            (
                "composite_blend.wgsl",
                "Params",
                shaders::COMPOSITE_BLEND.source,
                crate::composite_tile::blend_block(),
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
            (
                "linearise.wgsl",
                "Params",
                shaders::LINEARISE.source,
                crate::linearise::BLOCK_BYTES,
            ),
        ];
        shaders::layout::check(&cases);
    }
}
