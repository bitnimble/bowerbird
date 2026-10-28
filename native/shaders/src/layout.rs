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
//! the host's builder is run and its bytes counted. No table to keep in step. Each crate holds its
//! own blocks to this in a test named `every_uniform_is_the_size_its_shader_reads`.
//!
//! Size rather than field-by-field offsets, deliberately: the offsets follow from the field list,
//! which `the_uniform_matches_the_shader_struct` already pins for the one struct big enough to be
//! worth naming a field at a time. What every other struct needs is the tail check, which is the
//! part a human gets wrong.

/// The bytes a uniform block occupies, by the shader's own rules.
///
/// `source` is the module as the host composes it, since a struct can only be laid out in the
/// program it belongs to. `name` is the struct's, not the binding's.
pub fn uniform_size(source: &str, name: &str) -> Result<usize, String> {
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

/// Every `(file, struct, module, host bytes)` case, each against the size the shader lays out.
pub fn check(cases: &[(&str, &str, &str, usize)]) {
    for &(file, name, source, host) in cases {
        let shader = uniform_size(source, name).unwrap_or_else(|why| panic!("{file}: {why}"));
        assert_eq!(
            host, shader,
            "{file}'s {name} is {shader} bytes and the host writes {host}. WGSL rounds a uniform \
             struct to sixteen and aligns a vector to its own width, so a field added or reordered \
             moves the tail on one side only.",
        );
    }
}
