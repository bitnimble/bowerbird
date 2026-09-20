//! §5.2's rendering: a window of an assembly, and the lowpass the two-band mix is taken against.
//!
//! **Whole rather than per window.** A window's own halo truncates at the window's edge, and that
//! truncation differs on each side of a window boundary - a seam in the picture with no image seam
//! under it. Built once over the crop and sliced, the same canvas pixel reads the same lowpass
//! whichever window asked for it, which is what the editor and a rendition agreeing requires.

use crate::px::{Composite, Rect, Share, Span};

/// §5.2's band split: the wavelength the low band ends at.
pub const LAMBDA_SPLIT: Share = Share::of(1, 64);

/// How long the coarse canvas the lowpass is built on is, in pixels.
///
/// Eight cells to a `LAMBDA_SPLIT`, so the split's own wavelength is resolved rather than aliased.
const COARSE_LONG: usize = 512;

/// One source's lowpass over the whole crop, and the grid it is stated on.
pub struct Lowpass {
    /// Slot-major, `Drawing::sources_used()`'s order: each source's crop, area-averaged to the
    /// split's own grid. A few kilobytes a source.
    pub bands: Vec<crate::resident::Resident>,
    /// The grid's own size, and where it sits on the canvas in canvas pixels.
    pub size: (usize, usize),
    pub crop: Rect<crate::px::Composite>,
    /// The white every window of this render is coded against, measured over the whole crop while
    /// the bands were being built. A strip left to measure its own is a band across the finished
    /// picture, which is `crate::composite_tile::CompositeRequest::levels`' own warning.
    pub levels: crate::tone::Anchored,
}

/// The lowpass for every source the recipe uses, built once for a whole render.
///
/// **One decode a source, at a coarse scale.** `layers_of` at `canvas_long / COARSE_LONG` asks the
/// decoder for a frame that size, so this costs a coarse decode a source rather than a full one -
/// §3.9 measures a whole decode at 0.15s for a 33MP frame, and this is far under it. Then
/// `base::resize` to the split's grid, which is an area average in light and so *is* the lowpass:
/// a box's sidelobes are identical on both sides of every seam and cancel out of `layer - lowpass`
/// exactly, so the 5-tap binomial §5.2 describes buys nothing a seam can see.
pub async fn lowpass(
    recipe: &crate::assembly::Drawing,
    request: &crate::composite_tile::CompositeRequest<'_>,
) -> Result<Lowpass, String> {
    let refused = || crate::base::without_a_device("the assembly's lowpass");
    let gpu = crate::gpu::device().ok_or_else(refused)?;
    let base = crate::base::device(gpu).ok_or_else(refused)?;

    let spec = &recipe.spec;
    let [cw, ch] = spec.canvas;
    let crop = Rect::exact(
        (spec.crop[0] * cw as f64).round() as usize,
        (spec.crop[1] * ch as f64).round() as usize,
        ((spec.crop[2] - spec.crop[0]) * cw as f64).round().max(1.0) as usize,
        ((spec.crop[3] - spec.crop[1]) * ch as f64).round().max(1.0) as usize,
    );
    let (crop_w, crop_h) = (crop.raw().2, crop.raw().3);
    let coarse = crop_w.max(crop_h) as f64 / COARSE_LONG as f64;
    let scale = coarse.max(1.0);

    let of = crate::assembly_weight::slots_of(recipe);
    let slots = recipe.sources_used().len();

    let grid = {
        let long = LAMBDA_SPLIT
            .across(Span::<Composite>::exact(crop_w.max(crop_h)))
            .raw()
            .max(1.0) as f32;
        (
            ((crop_w as f32 / long).round() as usize).max(1),
            ((crop_h as f32 / long).round() as usize).max(1),
        )
    };

    let mut bands: Vec<Option<crate::resident::Resident>> = (0..slots).map(|_| None).collect();

    let coarse_request = crate::composite_tile::CompositeRequest {
        window: Rect::exact(
            (crop.raw().0 as f64 / scale).round() as usize,
            (crop.raw().1 as f64 / scale).round() as usize,
            (crop_w as f64 / scale).round().max(1.0) as usize,
            (crop_h as f64 / scale).round().max(1.0) as usize,
        ),
        // The whole of the window, which is what an empty list means.
        parts: &[],
        scale,
        // Every source's own lowpass, whatever the weights say: the bands are what the blend mixes
        // *between*, so a source gathered here at no weight is still a source the blend reads.
        mask: None,
        ..request.clone()
    };
    let levels = crate::composite_tile::layers_of(spec, &coarse_request, |i, layer, _| {
        let crate::composite_tile::Layer { rgb, weight } = layer;
        if let Some(slot) = of[i] {
            bands[slot as usize] = crate::base::resize(gpu, base, &rgb, grid);
        }
        drop(weight);
        rgb.reclaim();
        Ok(())
    })
    .await?
    .ok_or("no source of this assembly reaches its crop")?;

    Ok(Lowpass {
        levels,
        bands: bands
            .into_iter()
            .collect::<Option<Vec<_>>>()
            .ok_or("a source the recipe uses did not reach the crop")?,
        size: grid,
        crop,
    })
}

/// One rectangle of an assembly's canvas, every tile taking the frame it picked.
///
/// The panorama's own loop with two things changed: the weight each source is gathered with comes
/// from §5.2's fields rather than from the feather, and the layers land in two bands rather than
/// one accumulator. The decode, the coding, the lens gather and the order are `composite_tile`'s,
/// unchanged - which is what makes the editor and a rendition one implementation rather than two.
///
/// `hold` is [`lowpass`]'s answer, built once for a whole render: it is a decode a source and it
/// does not depend on the window.
pub async fn prepared(
    recipe: &crate::assembly::Drawing,
    hold: &Lowpass,
    request: &crate::composite_tile::CompositeRequest<'_>,
) -> Result<(crate::resident::Resident, crate::tile::Prepared), String> {
    let refused = || crate::base::without_a_device("the assembly's render");
    let gpu = crate::gpu::device().ok_or_else(refused)?;
    let base = crate::base::device(gpu).ok_or_else(refused)?;

    // Once for the window, not once a source: every source reads the same array at its own slot,
    // and the flood is the expensive half of a window. No test can see the difference.
    let fields = crate::assembly_weight::weights(gpu, recipe, request.window, request.scale).await;
    let slot_of = crate::assembly_weight::slots_of(recipe);
    let tile_warps: Vec<[f64; 6]> = (0..recipe.tiles.len())
        .map(|tile| recipe.warp_of(tile))
        .collect();
    let tile_slot: Vec<u32> = (0..recipe.tiles.len())
        .map(|tile| slot_of[recipe.pick[tile]].expect("a picked source has a slot"))
        .collect();
    let masked = crate::composite_tile::CompositeRequest {
        mask: Some(crate::composite_tile::Mask {
            signed: &fields.signed,
            tile_of: &fields.tile_of,
            warps: &fields.warps,
            tile_warps: &tile_warps,
            tile_slot: &tile_slot,
            slots: fields.slots,
            slot_of: &slot_of,
        }),
        // A window left to measure its own white is a band across the finished picture, and the
        // lowpass has already measured the whole crop's.
        levels: request.levels.or(Some(hold.levels)),
        ..request.clone()
    };

    let mut banding = crate::assembly_blend::Banding::over(
        gpu,
        base,
        request.window,
        &fields.width,
        hold,
        request.scale,
    );
    let mut carried = None;
    let levels = crate::composite_tile::layers_of(&recipe.spec, &masked, |i, layer, arrived| {
        banding.add(
            layer,
            slot_of[i].expect("a gathered source has a slot") as usize,
        );
        if i == recipe.base {
            carried = Some(arrived);
        }
        Ok(())
    })
    .await?;

    if banding.is_empty() {
        return Err("no source of this assembly covers that window".into());
    }
    let anchored = levels.ok_or("no source of this assembly reaches that window")?;
    // §2.5: the base is the pick every pixel outside every tile comes from, and §2.6 has date and
    // shoot follow it, so it is the frame the composite is graded as where a panorama grades as its
    // reference. `order_of` still puts the reference first, which is the anchor's job and separate.
    let from_the_base = carried.ok_or("the assembly's base does not reach that window")?;
    let picture = banding.resolve();

    let (left, top, width, height) = request.window.raw();
    let canvas = |value: usize| ((value as f64) / request.scale).round() as usize;
    Ok((
        picture,
        crate::tile::Prepared {
            samples: Vec::new(),
            width,
            height,
            keep: [0, 0, width, height],
            levels: anchored,
            matched: match request.from {
                crate::composite_tile::From::Camera => None,
                crate::composite_tile::From::Original => request.sources[recipe.base]
                    .analysis
                    .and_then(|a| a.from_raw.matched.clone()),
            },
            as_shot: from_the_base.as_shot,
            wb_gains: Some(from_the_base.wb_gains),
            photograph: (canvas(recipe.spec.canvas[0]), canvas(recipe.spec.canvas[1])),
            origin: (left, top),
            defocus: from_the_base.defocus,
            reference_nits: request.reference_white_nits,
        },
    ))
}
