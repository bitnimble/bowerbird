//! The decode without LibRaw: rawler reads the sensor, and everything after that is ours.
//!
//! LibRaw's `dcraw_process` did four things in one call - black subtraction, white balance, the
//! demosaic and the camera-to-output matrix. Only the demosaic was ever difficult, and it now
//! lives in `demosaic.rs`; the other three are arithmetic over coefficients rawler already carries
//! on its `RawImage`, so this module is mostly a matter of getting them in the right order and
//! the right space.

use crate::frame::{Frame, Pixels};
use rayon::prelude::*;

/// Decodes a RAW to a linear Rec.2020 frame, denoising the mosaic and demosaicing on the GPU.
///
/// `amounts` is the mosaic denoise, which runs before the demosaic for the reason it always has:
/// GALOSH is fitted to the sensor's own noise on the CFA, and a demosaic in front of it would
/// correlate the samples it measures.
/// The same frame as 8-bit sRGB, which is what a caller asking for a render rather than a scene
/// wants.
///
/// Not a second decode: the scene-linear frame is the one that took the work, and this is the
/// matrix and the transfer curve on top of it. `dcraw_process` used to hand this back directly,
/// which is why the depth and the colour space arrive together as one request.
pub fn to_srgb8(frame: &Frame) -> Option<Frame> {
    let samples = frame.samples16()?;
    let matrix = crate::hdr_fit::rec2020_to_srgb();
    let mut out = vec![0u8; samples.len()];
    out.par_chunks_mut(frame.width * 3).enumerate().for_each(|(row, line)| {
        let from = &samples[row * frame.width * 3..(row + 1) * frame.width * 3];
        for (pixel, source) in line.chunks_exact_mut(3).zip(from.chunks_exact(3)) {
            let linear = [
                f32::from(source[0]) / 65535.0,
                f32::from(source[1]) / 65535.0,
                f32::from(source[2]) / 65535.0,
            ];
            for (channel, slot) in pixel.iter_mut().enumerate() {
                let row = matrix[channel];
                let value = row[0] * f64::from(linear[0]) + row[1] * f64::from(linear[1]) + row[2] * f64::from(linear[2]);
                *slot = (srgb_transfer(value.clamp(0.0, 1.0)) * 255.0 + 0.5) as u8;
            }
        }
    });
    Some(Frame {
        width: frame.width,
        height: frame.height,
        pixels: Pixels::Eight(out),
        halved: frame.halved,
        as_shot: frame.as_shot,
        noise: frame.noise,
    })
}

/// The sRGB transfer function, which is a straight line near black and a power curve above it.
fn srgb_transfer(linear: f64) -> f64 {
    if linear <= 0.003_130_8 {
        linear * 12.92
    } else {
        1.055 * linear.powf(1.0 / 2.4) - 0.055
    }
}

/// The camera's embedded JPEG, still compressed.
///
/// Still compressed because the caller decodes it at a size: a preview is usually the sensor's own
/// resolution and libjpeg scales during the decode, so a caller that wants a grid tile out of a
/// 24MP JPEG should not be handed 24MP of pixels first. That is why this exists rather than
/// rawler's `preview_image`, which decodes what it finds.
pub fn preview_jpeg(path: &str) -> Option<Vec<u8>> {
    let source = rawler::rawsource::RawSource::new(std::path::Path::new(path)).ok()?;
    let decoder = rawler::get_decoder(&source).ok()?;
    let params = rawler::decoders::RawDecodeParams::default();
    Some(decoder.preview_jpeg(&source, &params).ok().flatten()?.to_vec())
}

/// The embedded JPEG, turned upright if it is not already.
///
/// **The preview is stored as the sensor read it, and LibRaw's thumbnail is not.** That is the one
/// behavioural difference between the two ways of reaching the same JPEG, and it is not cosmetic:
/// the camera match is fitted by comparing this against the render, so a sideways preview fits
/// against unrelated content. Measured, it cost 15% of the mean luma on a portrait frame.
///
/// A landscape frame is handed back untouched, which is most of them. The rest pay a decode and a
/// re-encode, and pay it here so that every caller is right rather than each having to know.
pub fn upright_preview_jpeg(path: &str) -> Option<Vec<u8>> {
    upright_preview_of(&rawler::rawsource::RawSource::new(std::path::Path::new(path)).ok()?)
}

/// The same, from a file already in memory, which is how an edit's open reaches it.
pub fn upright_preview_jpeg_bytes(bytes: &[u8]) -> Option<Vec<u8>> {
    upright_preview_of(&rawler::rawsource::RawSource::new_from_slice(bytes))
}

fn upright_preview_of(source: &rawler::rawsource::RawSource) -> Option<Vec<u8>> {
    let source = &source;
    let decoder = rawler::get_decoder(source).ok()?;
    let params = rawler::decoders::RawDecodeParams::default();
    let jpeg = decoder.preview_jpeg(&source, &params).ok().flatten()?;

    let upright = upright_of(decoder.as_ref(), &source, &params);
    use rawler::decoders::Orientation as O;
    if matches!(upright, O::Normal | O::Unknown) {
        return Some(jpeg.to_vec());
    }

    let image = crate::jpeg::decode(jpeg, 0).ok()?;
    let (data, width, height) = orient(image.data, image.width, image.height, upright);
    let turned = crate::rgb::RgbRef { width, height, data: &data };
    // High enough that the fit sees the preview and not the encoder. It is compared against a
    // render to derive a colour transform, so a visible block artefact is a colour error.
    crate::jpeg::encode(turned, 95).ok()
}

/// One tile of a photograph, decoding only the part of the file the tile needs.
///
/// `tile` is in the same space `decode` hands back: the recommended crop's pixels, before the
/// orientation is applied. That is what `cropbox` means on the LibRaw side, and a loupe asking both
/// decoders for the same rectangle has to get the same picture.
///
/// The saving is the point of the fork. `raw_image_region_tight` decodes only the tiles or subbands
/// the region touches and allocates only the rectangle it covered, and everything after it here -
/// conditioning, the denoise, the demosaic, the colour transform - runs over the region rather than
/// the frame.
pub fn decode_tile(
    path: &str,
    tile: crate::Tile,
    amounts: crate::galosh::Amounts,
    fit: crate::galosh::Fit,
    halo: usize,
) -> Option<Frame> {
    blocking(decode_tile_path_async(path, tile, amounts, fit, halo))
}

/// The same, awaited, which is the only spelling a browser can take
/// ([`decode_bytes_async`] says why).
pub async fn decode_tile_path_async(
    path: &str,
    tile: crate::Tile,
    amounts: crate::galosh::Amounts,
    fit: crate::galosh::Fit,
    halo: usize,
) -> Option<Frame> {
    let source = rawler::rawsource::RawSource::new(std::path::Path::new(path)).ok()?;
    decode_tile_source(&source, tile, amounts, fit, halo).await
}

/// One tile of a RAW the caller already holds, which is how a tab magnifies without a server.
pub async fn decode_tile_bytes_async(
    bytes: &[u8],
    tile: crate::Tile,
    amounts: crate::galosh::Amounts,
    fit: crate::galosh::Fit,
    halo: usize,
) -> Option<Frame> {
    let source = rawler::rawsource::RawSource::new_from_slice(bytes);
    decode_tile_source(&source, tile, amounts, fit, halo).await
}

async fn decode_tile_source(
    source: &rawler::rawsource::RawSource,
    tile: crate::Tile,
    amounts: crate::galosh::Amounts,
    fit: crate::galosh::Fit,
    halo: usize,
) -> Option<Frame> {
    let decoder = rawler::get_decoder(source).ok()?;
    let params = rawler::decoders::RawDecodeParams::default();
    let upright = upright_of(decoder.as_ref(), &source, &params);

    // Dummy first, for `crop_area`: the tile is in the crop's coordinates and the region to decode
    // is in the sensor's, so the offset between them has to be known before anything is read. A
    // dummy decode skips the decompression, which is the whole cost.
    let shape = decoder.raw_image(&source, &params, true).ok()?;
    let (frame_w, frame_h) = (shape.width, shape.height);
    let (origin, extent) = shape.crop_area.map_or(((0, 0), (frame_w, frame_h)), |area| {
        ((area.p.x, area.p.y), (area.d.w, area.d.h))
    });
    // Named upright, cropped in the sensor's coordinates, handed back upright again.
    let tile = as_sensor_rect(tile, extent.0, extent.1, upright);

    // Grown by what reads past the tile, and by the denoise's own window, then aligned to whole CFA
    // sites so the pattern inside the region is the pattern the frame has. An odd origin would
    // relabel every colour in it.
    let halo = crate::tile_halo(halo);
    let reach = RCD_MARGIN + halo;
    let left = (origin.0 + tile.left).saturating_sub(reach) & !1;
    let top = (origin.1 + tile.top).saturating_sub(reach) & !1;
    let right = (origin.0 + tile.left + tile.width + reach).min(frame_w);
    let bottom = (origin.1 + tile.top + tile.height + reach).min(frame_h);
    // Both extents even as well as both origins, because the denoise pairs samples into 2x2 sites
    // and refuses a region that does not. Trimmed rather than grown: the last column is halo, which
    // is there to be eaten, and at the frame's own edge there is nothing to grow into. A caller
    // asking for an odd-sized tile is ordinary - the loupe rounds a span to whole pixels - so this
    // is the common path rather than a guard against a strange request.
    let right = right - ((right - left) & 1);
    let bottom = bottom - ((bottom - top) & 1);
    if right <= left || bottom <= top {
        return None;
    }
    let region = rawler::imgop::Rect::new(
        rawler::imgop::Point::new(left, top),
        rawler::imgop::Dim2::new(right - left, bottom - top),
    );

    let (image, decoded) = decoder
        .raw_image_region_tight(&source, &params, region, false)
        .ok()?;
    let rawler::RawImageData::Integer(samples) = &image.data else {
        return None;
    };
    if samples.len() < image.width * image.height {
        return None;
    }

    // The region's own mosaic, lifted out of the tile-aligned rectangle the decode actually covered.
    let (region_w, region_h) = (right - left, bottom - top);
    let mut window = vec![0u16; region_w * region_h];
    for row in 0..region_h {
        let from = (top - decoded.p.y + row) * image.width + (left - decoded.p.x);
        window[row * region_w..(row + 1) * region_w].copy_from_slice(&samples[from..from + region_w]);
    }

    let cfa = cfa_of(&image);
    let gpu = crate::gpu::device();
    let mut mosaic = condition(gpu, &window, region_w, region_h, &image, cfa);

    // **Tiled inside the region, once the region is worth tiling.** A loupe window is no longer the
    // size of the glass - it is grown by the reach of everything after the gather - so the region
    // reaches the size at which whole-region RCD is gigabytes of planes. Safe within a grown region
    // because the tiles' halos read real mosaic either side of every interior seam, and the band at
    // the region's own edge is the halo the crop discards. Below one tile the machinery would cut
    // one tile and copy it twice, so that stays the single pass it has always been.
    let tiled = region_w > RENDER_TILE || region_h > RENDER_TILE;

    let mut noise = None;
    if let (Mosaic::Device(frame), Some(gpu)) = (&mut mosaic, gpu) {
        if let Some(kernels) = crate::galosh::device(gpu).filter(|_| amounts.does_anything()) {
            // **The frame's fit, where the caller had one.** Every whole-region reduction in Phase
            // 0 and Phase 2 measures this crop rather than the photograph, and a crop is not a
            // sample of the frame: measured on the fixtures, a 512px tile fitted between 0.49 and
            // 1.51 times its own frame's noise, which is the strength it is then denoised at. So a
            // loupe disagreed with the export it exists to predict, and moved as the reader panned.
            let measured = match fit {
                crate::galosh::Fit::Given(fit) => Some(fit),
                // A tile fitting itself is the case above's cost, not its correctness: it is what a
                // caller with no frame's fit to hand back gets, and it is what the numbers describe.
                // Measured by the one filtering run below rather than by a pass of its own.
                _ if !tiled => None,
                // Tiled, the fit has to be taken over the whole region first: measured inside the
                // filtering run it would be each tile's own statistics, which is the disagreement
                // above at a smaller scale and against itself.
                _ => Some(crate::galosh::fit(gpu, kernels, frame).await),
            };
            noise = Some(match (measured, tiled) {
                (Some(fit), true) => {
                    denoise_in_tiles(gpu, kernels, frame, amounts, fit, halo).await;
                    fit
                }
                (Some(fit), false) => {
                    crate::galosh::denoise_with(gpu, kernels, frame, amounts, fit).await
                }
                (None, _) => crate::galosh::denoise(gpu, kernels, frame, amounts).await,
            });
        }
    }
    declined_galosh(&noise, amounts, fit);

    let matrix = camera_to_rec2020(&image)?;
    // The tile's place inside the region, which is where the margin that was grown on ends.
    let inset = (origin.0 + tile.left - left, origin.1 + tile.top - top);
    let crop = (inset.0, inset.1, tile.width.min(region_w - inset.0), tile.height.min(region_h - inset.1));
    let on_gpu = gpu.and_then(|gpu| crate::demosaic::device(gpu).map(|rcd| (gpu, rcd)));
    let pixels = match (&mosaic, on_gpu) {
        (Mosaic::Device(frame), Some((gpu, rcd))) => match tiled {
            true => demosaic_in_tiles(gpu, rcd, frame, cfa, crop, matrix).await?,
            false => crate::demosaic::demosaic_with(gpu, rcd, frame, cfa, |rgb| {
                to_rec2020(rgb, region_w, crop, matrix)
            })
            .await?,
        },
        _ => {
            let host = mosaic.host(gpu).await?;
            let rgb = crate::demosaic::cpu(&host, region_w, region_h, cfa)?;
            to_rec2020_from(&rgb, region_w, crop, matrix)
        }
    };

    let (pixels, out_w, out_h) = orient(pixels, crop.2, crop.3, upright);
    Some(Frame {
        width: out_w,
        height: out_h,
        pixels: Pixels::Sixteen(pixels),
        halved: false,
        as_shot: as_shot_of(&image),
        noise,
    })
}

/// The whole frame, at the sensor's own resolution.
pub fn decode(path: &str, amounts: crate::galosh::Amounts) -> Option<Frame> {
    decode_fitted(path, amounts, 0)
}

/// The frame, halved where the caller's floor allows it.
///
/// `at_least_long_edge` is the smallest long edge that would still serve. Halving a frame whose own
/// long edge is at least twice that leaves it still large enough, and saves the demosaic outright.
pub fn decode_fitted(path: &str, amounts: crate::galosh::Amounts, at_least_long_edge: u32) -> Option<Frame> {
    let source = rawler::rawsource::RawSource::new(std::path::Path::new(path)).ok()?;
    blocking(decode_source(&source, amounts, at_least_long_edge, crate::galosh::Fit::Measure))
}

/// One RGB pixel per 2x2 CFA site, which is a half-resolution frame with no demosaic in it.
///
/// **Not an approximation of one.** Every site carries a real red, a real blue and two greens, so
/// the output pixel is measured rather than interpolated - there is no direction to guess and no
/// false colour to suppress. It is what LibRaw's `half_size` did, and it is the reason a caller that
/// only wants a small rendition should never pay for RCD: the demosaic is the largest cost in the
/// decode and this skips all of it.
///
/// `cfa` is the 2x2 read row-major, and the site grid is the frame's own, so the caller must not
/// hand this a mosaic whose origin sits on an odd row or column.
fn half_size(mosaic: &[f32], width: usize, height: usize, cfa: [u32; 4]) -> Vec<f32> {
    let (out_w, out_h) = (width / 2, height / 2);
    let mut out = vec![0f32; out_w * out_h * 3];
    out.par_chunks_mut(out_w * 3).enumerate().for_each(|(row, line)| {
        let (top, bottom) = (row * 2 * width, (row * 2 + 1) * width);
        for (col, pixel) in line.chunks_exact_mut(3).enumerate() {
            let site = [
                mosaic[top + col * 2],
                mosaic[top + col * 2 + 1],
                mosaic[bottom + col * 2],
                mosaic[bottom + col * 2 + 1],
            ];
            let mut green = 0.0;
            let mut greens = 0.0;
            for (at, value) in site.iter().enumerate() {
                match cfa[at] {
                    0 => pixel[0] = *value,
                    2 => pixel[2] = *value,
                    // Both of them, averaged: the two greens of a site are the same colour sampled
                    // twice, and using one would throw away half the luminance signal the sensor
                    // spends half its photosites collecting.
                    _ => {
                        green += *value;
                        greens += 1.0;
                    }
                }
            }
            pixel[1] = if greens > 0.0 { green / greens } else { 0.0 };
        }
    });
    out
}

/// The colour transform over a frame that is already interleaved RGB, for the half-size path.
///
/// `to_rec2020` reads the demosaic's mapped bytes; this reads floats that never left the CPU.
fn to_rec2020_from(rgb: &[f32], stride: usize, crop: (usize, usize, usize, usize), matrix: [[f32; 3]; 3]) -> Vec<u16> {
    let (left, top, width, height) = crop;
    let mut out = vec![0u16; width * height * 3];
    out.par_chunks_mut(width * 3).enumerate().for_each(|(row, line)| {
        for (col, pixel) in line.chunks_exact_mut(3).enumerate() {
            let from = ((top + row) * stride + left + col) * 3;
            let (r, g, b) = (rgb[from], rgb[from + 1], rgb[from + 2]);
            for (channel, slot) in pixel.iter_mut().enumerate() {
                let value = matrix[channel][0] * r + matrix[channel][1] * g + matrix[channel][2] * b;
                *slot = (value * 65535.0).clamp(0.0, 65535.0) as u16;
            }
        }
    });
    out
}

/// The same decode, from bytes already in hand.
///
/// What preparing an edit needs: the server has read the file to hash it and hands the buffer
/// straight on, so opening the path again would read it twice.
pub fn decode_bytes(
    bytes: &[u8],
    amounts: crate::galosh::Amounts,
    at_least_long_edge: u32,
    fit: crate::galosh::Fit,
) -> Option<Frame> {
    blocking(decode_bytes_async(bytes, amounts, at_least_long_edge, fit))
}

/// The same, awaited, which is the only spelling a browser can take.
///
/// The chain's one readback is the demosaic's, and wgpu's WebGPU backend cannot be blocked for a
/// map ([`crate::gpu::read_back`]). Native drives this to completion without ever suspending, which
/// is what lets every blocking entry point above stay exactly as blocking as it was.
pub async fn decode_bytes_async(
    bytes: &[u8],
    amounts: crate::galosh::Amounts,
    at_least_long_edge: u32,
    fit: crate::galosh::Fit,
) -> Option<Frame> {
    decode_source(
        &rawler::rawsource::RawSource::new_from_slice(bytes),
        amounts,
        at_least_long_edge,
        fit,
    )
    .await
}

/// A decode driven to completion on this thread.
///
/// **Every host but a browser.** These futures suspend only on `wasm32`, where the readback awaits
/// the browser's own event loop; there the page's executor drives them
/// ([`decode_bytes_async`]) and nothing in the wasm build reaches the blocking spellings.
fn blocking<T>(work: impl std::future::Future<Output = T>) -> T {
    pollster::block_on(work)
}

async fn decode_source(
    source: &rawler::rawsource::RawSource,
    amounts: crate::galosh::Amounts,
    at_least_long_edge: u32,
    fit: crate::galosh::Fit,
) -> Option<Frame> {
    let mut lap = crate::clock::laps("  decode ");

    let source = &source;
    let decoder = rawler::get_decoder(source).ok()?;
    let params = rawler::decoders::RawDecodeParams::default();

    let upright = upright_of(decoder.as_ref(), &source, &params);

    lap("open");
    let image = decoder.raw_image(&source, &params, false).ok()?;
    lap("read");
    let (width, height) = (image.width, image.height);

    let cfa = cfa_of(&image);

    let rawler::RawImageData::Integer(samples) = &image.data else {
        return None;
    };
    if samples.len() < width * height {
        return None;
    }

    let gpu = crate::gpu::device();
    let mut mosaic = condition(gpu, &samples[..width * height], width, height, &image, cfa);

    lap("condition");
    // **Tiled, and at the halo a loupe takes.** A render assembled from the same regions as the
    // magnifier that predicts it is the same arithmetic rather than two routes that ought to
    // agree, which is the argument `job::Base::build` already makes about handing a tile the
    // frame's fit. It also bounds the GPU: whole-frame RCD is 3.1GB of planes at 61MP.
    //
    // `Fit::Measure` becomes a whole-frame fit and then a tiled denoise against it, which is the
    // same denoise - `open_bench` puts a measured fit against a given one at `worst 0e0`. The fit
    // has to be whole-frame either way, since Phase 0 reduces over everything it is shown and a
    // tile's own statistics are not the photograph's.
    let mut noise = None;
    if let (Mosaic::Device(frame), Some(gpu)) = (&mut mosaic, gpu) {
        if let Some(kernels) = crate::galosh::device(gpu) {
            noise = match fit {
                crate::galosh::Fit::Only => Some(crate::galosh::fit(gpu, kernels, frame).await),
                _ if !amounts.does_anything() => None,
                crate::galosh::Fit::Measure => {
                    let measured = crate::galosh::fit(gpu, kernels, frame).await;
                    denoise_in_tiles(
                        gpu,
                        kernels,
                        frame,
                        amounts,
                        measured,
                        crate::RENDITION_TILE_HALO,
                    )
                    .await;
                    Some(measured)
                }
                crate::galosh::Fit::Given(fit) => {
                    denoise_in_tiles(
                        gpu,
                        kernels,
                        frame,
                        amounts,
                        fit,
                        crate::RENDITION_TILE_HALO,
                    )
                    .await;
                    Some(fit)
                }
            };
        }
    }
    // Every way GALOSH can be missed at once - no adapter, no kernels, a mosaic that never reached
    // the device - said where the decode wanted something from it, since a frame that carries no
    // fit and was never filtered is otherwise indistinguishable from one that was.
    declined_galosh(&noise, amounts, fit);

    lap("denoise");
    let matrix = camera_to_rec2020(&image)?;

    // The sensor's readable area is larger than the picture: there are masked columns for the
    // black level and a few rows the manufacturer does not consider valid. LibRaw hands back the
    // cropped frame, so this must too, or every photograph shifts and every fitted camera match
    // describes a different framing.
    let crop = image
        .crop_area
        .map(|area| (area.p.x, area.p.y, area.d.w, area.d.h))
        .unwrap_or((0, 0, width, height));

    // Halved where the caller said a smaller frame would do, which skips the demosaic outright.
    // The crop halves with it, and its origin has to stay on a whole CFA site or the colours in the
    // half-size frame are the ones next door - so an odd origin declines rather than shifts.
    let halved = at_least_long_edge > 0
        && (width.max(height) as u32) / 2 >= at_least_long_edge
        && crop.0 % 2 == 0
        && crop.1 % 2 == 0;

    let (pixels, crop) = match halved {
        // The one place the mosaic still comes back whole: a halved frame skips the demosaic, so
        // there is no later stage on the device to hand it to.
        true => {
            let host = mosaic.host(gpu).await?;
            let small = half_size(&host, width, height, cfa);
            let crop = (crop.0 / 2, crop.1 / 2, crop.2 / 2, crop.3 / 2);
            (to_rec2020_from(&small, width / 2, crop, matrix), crop)
        }
        false => {
            let rcd = gpu.and_then(|gpu| crate::demosaic::device(gpu).map(|rcd| (gpu, rcd)));
            let pixels = match (&mosaic, rcd) {
                (Mosaic::Device(frame), Some((gpu, rcd))) => {
                    demosaic_in_tiles(gpu, rcd, frame, cfa, crop, matrix).await?
                }
                _ => {
                    let host = mosaic.host(gpu).await?;
                    let rgb = crate::demosaic::cpu(&host, width, height, cfa)?;
                    to_rec2020_from(&rgb, width, crop, matrix)
                }
            };
            (pixels, crop)
        }
    };

    lap("demosaic, colour, crop");

    // **The sensor reads in its own orientation; the photograph has another one.** LibRaw applies
    // this from `sizes.flip` and hands back an upright frame, so this must too - and not only
    // because the picture would be sideways. The camera match is fitted by comparing this frame
    // against the camera's own embedded JPEG, which is always upright, so a frame left in sensor
    // orientation produces a fit against unrelated content and a grade built on it.
    let (pixels, out_w, out_h) = orient(pixels, crop.2, crop.3, upright);

    lap("colour, crop, orient");

    Some(Frame {
        width: out_w,
        height: out_h,
        pixels: Pixels::Sixteen(pixels),
        halved,
        as_shot: as_shot_of(&image),
        noise,
    })
}

/// How wide a tile the denoise and the demosaic are cut into, for a whole frame as much as for a
/// loupe.
///
/// **Measured against the halo rather than chosen.** Over a 61MP frame the whole 16-to-64 halo
/// range costs 9% at this size and 37% at 512, so a large tile is what makes a generous halo
/// affordable; and 2048 at halo 32 is cheaper than 512 at any halo at all. Smaller than this buys
/// only finer progressive updates, which is a latency question and not this module's.
const RENDER_TILE: usize = 2048;

/// Where the tiles fall along one axis, as `(start, end)` pairs.
///
/// **Split evenly rather than into whole `RENDER_TILE`s, so that no strip is a few pixels wide.**
/// The demosaic declines a window narrower than twice its own margin, and a loupe names an
/// arbitrary rectangle - a tile 2049 pixels across would leave a one-pixel column and take the
/// whole decode down with it. The boundaries are free to move: each tile is computed with the halo
/// its stage reads through, so where they fall does not change the answer.
fn spans(total: usize) -> impl Iterator<Item = (usize, usize)> {
    let count = total.div_ceil(RENDER_TILE).max(1);
    let step = total.div_ceil(count);
    (0..count).map(move |at| (at * step, ((at + 1) * step).min(total)))
}

/// Says so where a decode asked GALOSH for something and got nothing.
///
/// A decode that filters nothing measures nothing, so `None` is the ordinary answer for most
/// callers and only means a decline when the caller wanted the fit or asked for an amount.
fn declined_galosh(
    noise: &Option<crate::galosh::NoiseFit>,
    amounts: crate::galosh::Amounts,
    fit: crate::galosh::Fit,
) {
    let wanted = matches!(fit, crate::galosh::Fit::Only) || amounts.does_anything();
    if wanted && noise.is_none() {
        crate::warn(
            "rawshim: no GPU for GALOSH, so this frame carries no noise fit and was not denoised",
        );
    }
}

/// Where the mosaic is, which is on the device wherever there is one.
///
/// Two spellings rather than one because the fall-throughs are real: a host with no adapter
/// conditions on the CPU and demosaics with PPG, and neither of those has a buffer to read.
enum Mosaic {
    Device(crate::condition::Mosaic),
    Host(Vec<f32>),
}

impl Mosaic {
    /// The samples on the host, for the stages that have no device path.
    ///
    /// Borrowed where they were never on one, so the no-GPU route pays nothing for the choice.
    async fn host(
        &self,
        gpu: Option<&'static crate::gpu::Gpu>,
    ) -> Option<std::borrow::Cow<'_, [f32]>> {
        match self {
            Mosaic::Host(values) => Some(std::borrow::Cow::Borrowed(values)),
            Mosaic::Device(frame) => frame.read(gpu?).await.map(std::borrow::Cow::Owned),
        }
    }
}

/// The mosaic denoise, tile by tile, at the halo this caller grew its region by.
async fn denoise_in_tiles(
    gpu: &'static crate::gpu::Gpu,
    kernels: &'static crate::galosh::Galosh,
    mosaic: &mut crate::condition::Mosaic,
    amounts: crate::galosh::Amounts,
    fit: crate::galosh::NoiseFit,
    halo: usize,
) {
    // `galosh`'s own, which rounds each region's origin to the shrinkage's grid. This had the same
    // geometry without that rounding, and so denoised every rendition against a neighbourhood the
    // whole-frame answer never uses - `pass12` shrinks inside a tile indexed from the region
    // origin, so a region off the grid shifts the tiling under every pixel in it.
    crate::galosh::denoise_in_tiles(
        gpu, kernels, mosaic, amounts, fit, halo, RENDER_TILE, |_| {},
    )
    .await;
}

/// The demosaic and the colour transform, tile by tile, straight into the cropped frame.
///
/// Tiled over the *crop* rather than the sensor, since that is the frame being built; the region
/// each tile needs is that rectangle in sensor coordinates grown by RCD's own margin. Whole-frame
/// RCD holds thirteen planes at once - 3.1GB at 61MP - which is the allocation this removes.
async fn demosaic_in_tiles(
    gpu: &'static crate::gpu::Gpu,
    rcd: &'static crate::demosaic::Rcd,
    mosaic: &crate::condition::Mosaic,
    cfa: [u32; 4],
    crop: (usize, usize, usize, usize),
    matrix: [[f32; 3]; 3],
) -> Option<Vec<u16>> {
    let (width, height) = (mosaic.width, mosaic.height);
    let (crop_left, crop_top, crop_w, crop_h) = crop;
    let mut out = vec![0u16; crop_w * crop_h * 3];

    for (ty0, ty1) in spans(crop_h) {
        for (tx0, tx1) in spans(crop_w) {
            // **Grown in the sensor's coordinates and clamped to the sensor, not to the crop.**
            // The crop is inset from the readable area, so there is real mosaic outside it, and
            // the whole-frame demosaic this replaces read that: it ran over everything and was
            // cropped afterwards. Clamping the halo to the crop instead border-fills the frame's
            // own edge, which came out as the first six samples of a pinned render moving and
            // nothing else in the row.
            let (sx0, sy0) = (crop_left + tx0, crop_top + ty0);
            let (sx1, sy1) = (crop_left + tx1, crop_top + ty1);
            let left = sx0.saturating_sub(RCD_MARGIN) & !1;
            let top = sy0.saturating_sub(RCD_MARGIN) & !1;
            // **Rounded out to even, never in.** The origin is aligned down to a whole CFA site, so
            // the far edge has to move to keep the extent even - and trimming it is a pixel off the
            // margin, which on a boundary at an odd column leaves RCD nine pixels of context where
            // it reads ten and border-extends the last column. That is one seam, worth nothing to a
            // mean and thousands of counts on an edge. Only at the field's own edge does the clamp
            // below take it back, and there the trimmed pixel is outside the picture anyway.
            let right = (sx1 + RCD_MARGIN).next_multiple_of(2).min(width);
            let bottom = (sy1 + RCD_MARGIN).next_multiple_of(2).min(height);
            let (right, bottom) =
                (right - ((right - left) & 1), bottom - ((bottom - top) & 1));
            if right <= left || bottom <= top {
                continue;
            }
            let (region_w, region_h) = (right - left, bottom - top);

            let window = mosaic.window(gpu, left, top, region_w, region_h);
            // Where this tile sits inside its own region, which is where the halo ends.
            let inner = (
                sx0 - left,
                sy0 - top,
                (sx1 - sx0).min(region_w - (sx0 - left)),
                (sy1 - sy0).min(region_h - (sy0 - top)),
            );
            let rgb = crate::demosaic::demosaic_with(gpu, rcd, &window, cfa, |bytes| {
                to_rec2020(bytes, region_w, inner, matrix)
            })
            .await?;
            window.buffer.destroy();
            for row in 0..inner.3 {
                let to = ((ty0 + row) * crop_w + tx0) * 3;
                let from = row * inner.2 * 3;
                out[to..to + inner.2 * 3].copy_from_slice(&rgb[from..from + inner.2 * 3]);
            }
        }
    }
    Some(out)
}

/// How far past a tile the pipeline reads, in sensor pixels.
const RCD_MARGIN: usize = crate::demosaic::MARGIN as usize;

/// The same rectangle, named in the crop's own coordinates instead of the upright frame's.
///
/// A tile arrives in the coordinates a reader sees, which are the upright ones, and everything
/// before `orient` works in the sensor's. On a landscape frame those are the same and this is
/// identity; on a portrait one they are not, and cropping without it hands back a tile of the right
/// size showing a different part of the photograph.
///
/// `width` and `height` are the crop's, before orientation.
fn as_sensor_rect(
    tile: crate::Tile,
    width: usize,
    height: usize,
    orientation: rawler::decoders::Orientation,
) -> crate::Tile {
    use rawler::decoders::Orientation as O;
    // Inverse of the mapping in `orient`, applied to the corners: each of these is its own inverse
    // except the two rotations, which are each other's.
    let back = |x: usize, y: usize| -> (usize, usize) {
        match orientation {
            O::HorizontalFlip => (width.saturating_sub(1) - x, y),
            O::Rotate180 => (width.saturating_sub(1) - x, height.saturating_sub(1) - y),
            O::VerticalFlip => (x, height.saturating_sub(1) - y),
            O::Transpose => (y, x),
            O::Rotate90 => (y, height.saturating_sub(1) - x),
            O::Transverse => (width.saturating_sub(1) - y, height.saturating_sub(1) - x),
            O::Rotate270 => (width.saturating_sub(1) - y, x),
            O::Normal | O::Unknown => (x, y),
        }
    };

    let far = (tile.left + tile.width.saturating_sub(1), tile.top + tile.height.saturating_sub(1));
    let (ax, ay) = back(tile.left, tile.top);
    let (bx, by) = back(far.0, far.1);
    crate::Tile {
        left: ax.min(bx),
        top: ay.min(by),
        width: ax.abs_diff(bx) + 1,
        height: ay.abs_diff(by) + 1,
    }
}

/// **From the metadata, not from `RawImage::orientation`.** That field exists but the decoders here
/// leave it `Normal` even for a frame shot in portrait; the EXIF tag is where the answer actually
/// is. Reading the wrong one leaves every upright photograph on its side.
fn upright_of(
    decoder: &dyn rawler::decoders::Decoder,
    source: &rawler::rawsource::RawSource,
    params: &rawler::decoders::RawDecodeParams,
) -> rawler::decoders::Orientation {
    decoder
        .raw_metadata(source, params)
        .ok()
        .and_then(|meta| meta.exif.orientation)
        .map_or(rawler::decoders::Orientation::Normal, rawler::decoders::Orientation::from_u16)
}

fn cfa_of(image: &rawler::RawImage) -> [u32; 4] {
    [
        image.camera.cfa.color_at(0, 0) as u32,
        image.camera.cfa.color_at(0, 1) as u32,
        image.camera.cfa.color_at(1, 0) as u32,
        image.camera.cfa.color_at(1, 1) as u32,
    ]
}

/// Black subtracted, normalised by the sensor's saturation, and white balanced, into the roughly
/// unit interval the demosaic's specification asks for.
///
/// **Black first, then white balance, then the demosaic.** The order is not free. The directional
/// statistic in RCD is built to be blind to a per-channel gain, so it does not care either way, but
/// the colour-difference stages assume the difference between a chroma channel and green is locally
/// smooth - and before white balance green sits about twice as high as red and blue, so that
/// difference carries the imbalance rather than the scene.
///
/// `samples` may be a region lifted out of the frame rather than the frame, in which case its origin
/// has to sit on a whole CFA site or every colour in it is relabelled.
///
/// On the GPU where there is one, which is where the halving is: the samples go up packed `u16`
/// where the mosaic they become is `f32`, 120MB against 241MB at 61MP. Both routes read
/// [`conditioned`] - the kernel through the table [`curve`] builds from it - so which one ran is a
/// matter of speed and not of picture, and `the_kernel_conditions_exactly_as_the_cpu_does` is what
/// says so. `condition.rs` says what it costs on a server, which is more than the CPU and nothing
/// the open can measure.
fn condition(
    gpu: Option<&'static crate::gpu::Gpu>,
    samples: &[u16],
    width: usize,
    height: usize,
    image: &rawler::RawImage,
    cfa: [u32; 4],
) -> Mosaic {
    let levels = Levels {
        black: per_channel_black(image),
        white: saturation_of(image),
        gains: white_balance_gains(image),
    };
    let (floor, range, gain) = coefficients(cfa, &levels);
    let kernel = gpu.and_then(|gpu| {
        let curve = curve(floor, range, gain);
        crate::condition::normalise(gpu, crate::condition::device(gpu), samples, width, height, &curve)
    });
    if let Some(mosaic) = kernel {
        return Mosaic::Device(mosaic);
    }
    // Announced for the reason `demosaic::cpu` announces itself: a fall-through nothing says out
    // loud is how a regression passes a whole fixture suite.
    crate::warn("rawshim: no GPU for the conditioning, so this mosaic is built on the CPU");
    let host = normalise(samples, width, height, floor, range, gain);
    match gpu {
        // The kernel declined but the device is there, and everything after this reads a buffer.
        // Uploading is what keeps RCD and GALOSH on the frame rather than making one refusal
        // cascade into a PPG decode.
        Some(gpu) => Mosaic::Device(crate::condition::Mosaic::upload(gpu, &host, width, height)),
        None => Mosaic::Host(host),
    }
}

/// What the file says about where the signal sits, read once for the frame.
struct Levels {
    /// By position in the 2x2, not by colour. See `per_channel_black`.
    black: [f32; 4],
    white: f32,
    /// By colour, which is what the two greens share.
    gains: [f32; 4],
}

/// The three tables the arithmetic actually runs over, all of them by position in the 2x2.
///
/// **Black by position and the gain by colour, which is not an inconsistency:** black is a property
/// of the photosite and the two greens have their own, while the white balance is a property of the
/// colour and they share it. Resolving the gain onto a position here is what lets both spellings
/// take the same three tables and lets the shader work without a CFA of its own.
fn coefficients(cfa: [u32; 4], levels: &Levels) -> ([f32; 4], [f32; 4], [f32; 4]) {
    let mut floor = [0f32; 4];
    let mut range = [1f32; 4];
    let mut gain = [1f32; 4];
    for position in 0..4 {
        floor[position] = levels.black[position];
        range[position] = (levels.white - floor[position]).max(1.0);
        gain[position] = levels.gains[cfa[position].min(3) as usize];
    }
    (floor, range, gain)
}

/// One sample conditioned, and the only place the arithmetic is written.
///
/// Clamped at zero because §2.2 of the specification requires it: a negative sample in the shadows
/// can drive the low-pass sum the green stage divides by through zero, and the epsilon there does
/// not save it.
///
/// And clamped at one, which §2.2 does not ask for because it does not white balance. Here it is
/// what keeps a blown highlight neutral: the gains put a saturated red or blue above one while
/// green lands on it exactly, so without this the three leave for the colour matrix unequal and the
/// highlight comes out with a hue. It has to happen before the matrix - clamping afterwards, which
/// is all `to_rec2020` can do, mixes the channels first and then clips one of them, which is a
/// colour cast rather than white.
#[inline]
fn conditioned(
    sample: u16,
    position: usize,
    floor: [f32; 4],
    range: [f32; 4],
    gain: [f32; 4],
) -> f32 {
    ((f32::from(sample) - floor[position]).max(0.0) / range[position] * gain[position]).min(1.0)
}

/// What [`conditioned`] answers for every level the sensor can report, at each of the four
/// positions, which is the whole domain of the conditioning.
///
/// **The kernel reads this rather than evaluating the expression, and that is not an
/// optimisation.** Vulkan requires only 2.5 ULP of `OpFDiv` and RADV takes it, lowering the divide
/// to a reciprocal and a multiply - measured, the shader's own arithmetic disagreed with this in
/// the last bit. Tabulating the domain leaves one spelling rather than two to hold together, and
/// 262144 entries is a millisecond and a megabyte.
fn curve(floor: [f32; 4], range: [f32; 4], gain: [f32; 4]) -> Vec<f32> {
    // The kernel sizes its binding by its own constant and declines a curve that is not that
    // length, which would be a silent return to the CPU rather than a failure.
    const _: () = assert!(crate::condition::CURVE == 4 * (u16::MAX as usize + 1));
    (0..4)
        .flat_map(|position| {
            (0..=u16::MAX).map(move |sample| conditioned(sample, position, floor, range, gain))
        })
        .collect()
}

/// The arithmetic of `condition` on the CPU, over coefficients already resolved.
///
/// Split from the read so that a test can state four black levels and see what becomes of each,
/// which is not something a `RawImage` can be talked into saying.
fn normalise(
    samples: &[u16],
    width: usize,
    height: usize,
    floor: [f32; 4],
    range: [f32; 4],
    gain: [f32; 4],
) -> Vec<f32> {
    let mut mosaic = vec![0f32; width * height];
    mosaic.par_chunks_mut(width).enumerate().for_each(|(row, out)| {
        let from = &samples[row * width..(row + 1) * width];
        for (col, (sample, slot)) in from.iter().zip(out).enumerate() {
            *slot = conditioned(*sample, (row & 1) * 2 + (col & 1), floor, range, gain);
        }
    });
    mosaic
}

/// The black level of each position in the 2x2, in sensor counts.
///
/// **By position, not by colour, and that distinction is the whole reason this exists.** A Bayer
/// sensor reports four and they are not equal; the two greens in particular can differ by enough to
/// leave a visible checkerboard. Indexing by colour cannot hold that, because the two greens are one
/// colour - it keeps whichever of them is written last and subtracts it from both.
fn per_channel_black(image: &rawler::RawImage) -> [f32; 4] {
    let levels = &image.blacklevel.levels;
    let mut out = [0f32; 4];
    for (position, slot) in out.iter_mut().enumerate() {
        *slot = match levels.len() >= 4 {
            true => levels[position].as_f32(),
            false => levels.first().map_or(0.0, |first| first.as_f32()),
        };
    }
    out
}

/// Where the sensor saturates, in raw counts.
///
/// The maker note's figure, except on Canon, where the largest sample present wins if it is higher.
///
/// **Canon's `SpecularWhiteLevel` is conservative by enough to cost picture.** An R8 states 14888
/// and its data runs to 16383, the full 14 bits; dividing by the stated figure puts everything above
/// it past one, where the clamp in `condition` flattens it into a single value. Bright water loses
/// its foam and turns cyan, red carrying the largest gain and so running out first. That is a tenth
/// of a stop of headroom and it is visible.
///
/// **Sony's is not, and is left alone.** An A7CR states 15360 against the same 14-bit ceiling: a
/// fifteenth of a stop, and although 4.4% of a frame exceeds it, none of that is highlight worth
/// recovering - searched for specifically, the regions where raising the level changes anything are
/// shadows, where it changes the noise. Taking the data's word there buys pixel noise and nothing
/// else, so the file's figure is better trusted.
fn stated_only(image: &rawler::RawImage) -> bool {
    !image.clean_make.eq_ignore_ascii_case("canon")
}
/// Set by the comparison harness to render the stated level and the sensor's cap from one process,
/// which is the only way to search a frame for where the choice between them matters.
static STATED_WHITE_LEVEL: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn use_stated_white_level(on: bool) {
    STATED_WHITE_LEVEL.store(on, std::sync::atomic::Ordering::Relaxed);
}

fn saturation_of(image: &rawler::RawImage) -> f32 {
    let reported = image.whitelevel.0.iter().copied().max().unwrap_or(65535) as u16;
    // Taking the maker note's figure at its word is what this did before, and what the pictures in
    // the log compare against. Kept as a seam rather than deleted: the difference between the two is
    // the argument for the line below it.
    let stated = stated_only(image)
        || STATED_WHITE_LEVEL.load(std::sync::atomic::Ordering::Relaxed)
        || std::env::var("BOWERBIRD_WHITE_LEVEL").is_ok_and(|value| value == "stated");
    if stated {
        return f32::from(reported);
    }
    // The converter's own ceiling, not the largest sample present. Both clear the stated level on
    // the Canon files, and this one is a property of the camera rather than of the frame: taken from
    // the data, a tile whose corner of the picture happens to hold no highlight would be scaled
    // differently from the frame around it, and the loupe would disagree with the render it is
    // magnifying.
    let ceiling = u16::try_from((1u32 << image.bps.min(16)) - 1).unwrap_or(u16::MAX);
    f32::from(reported.max(ceiling))
}

/// Per-channel gains, scaled so the smallest of them is unity.
///
/// **On the smallest, so that saturation lands exactly on one in the least amplified channel.** A
/// sensor sample at the white level says only "at least this bright" - its colour is unknown - so
/// every channel of a blown pixel has to come out equal or the highlight takes on a hue. Pairing
/// this with the clamp in `condition` is what does that: the least amplified channel reaches one
/// exactly at saturation, the others pass it and are clamped back, and all three arrive at the
/// colour matrix neutral.
///
/// Scaling on the largest instead was tried and is worse in a way that is easy to miss. Nothing
/// clips, so the counters look better, but a blown pixel then carries the gain ratios themselves -
/// red one, green a half, blue three quarters - and renders warm rather than white. Measured on a
/// blown highlight it came out (248, 216, 192) against LibRaw's (176, 173, 170).
fn white_balance_gains(image: &rawler::RawImage) -> [f32; 4] {
    let wb = image.wb_coeffs;
    let usable = |c: f32| c.is_finite() && c > 0.0;
    let smallest = wb.iter().copied().filter(|c| usable(*c)).fold(f32::INFINITY, f32::min);
    let scale = if smallest.is_finite() && smallest > 0.0 { smallest } else { 1.0 };
    let mut out = [1f32; 4];
    for (channel, slot) in out.iter_mut().enumerate() {
        let coefficient = wb[channel.min(3)];
        *slot = if usable(coefficient) { coefficient / scale } else { 1.0 };
    }
    out
}

/// The camera's XYZ matrix, as three rows of three.
///
/// **Not `xyz_to_cam`, which is dead.** That field is marked deprecated in rawler and comes back
/// all zeros for at least the Canon bodies here, which makes `cam_to_xyz_normalized` return NaN
/// and every pixel black. The live data is `color_matrix`, a flat row-major matrix per illuminant.
fn xyz_to_cam_of(image: &rawler::RawImage) -> Option<[[f32; 3]; 4]> {
    // D65 to agree with LibRaw, which references its `cam_xyz` to daylight, and by the enum's
    // ordering rather than the map's when there is no D65: `color_matrix` is a `HashMap` and its
    // iteration order is seeded per process, so taking whatever came first made the decode differ
    // between runs of the same binary on the same file.
    let illuminant = image
        .color_matrix
        .keys()
        .copied()
        .find(|i| *i == rawler::imgop::xyz::Illuminant::D65)
        .or_else(|| image.color_matrix.keys().copied().min_by_key(|i| *i as u16))?;
    let flat = image.color_matrix.get(&illuminant)?;
    if flat.len() < 9 || flat.len() % 3 != 0 {
        return None;
    }
    let mut out = [[0f32; 3]; 4];
    for row in 0..(flat.len() / 3).min(4) {
        for col in 0..3 {
            out[row][col] = flat[row * 3 + col];
        }
    }
    Some(out)
}

/// Camera native primaries to linear Rec.2020.
///
/// **The rows are normalised in sRGB, and moving that step is a colour cast.** A camera matrix has
/// an arbitrary per-row scale and something has to pin it; normalising `xyz_to_cam` where it stands
/// pins camera (1,1,1) to XYZ (1,1,1), which is not a colour anyone means by white - D65 is about
/// (0.9505, 1.0, 1.0890) - and the difference is a per-channel gain the white balance does not
/// undo. dcraw's `cam_xyz_coeff` multiplies through `xyz_rgb` first for exactly this reason, and
/// `xyz_rgb` there is sRGB's matrix whatever `output_color` eventually asks for. sRGB rather than
/// the Rec.2020 this returns, then, because every camera match ever fitted is against a frame that
/// came out of `cam_xyz_coeff`.
fn camera_to_rec2020(image: &rawler::RawImage) -> Option<[[f32; 3]; 3]> {
    camera_to_rec2020_from(xyz_to_cam_of(image)?)
}

fn camera_to_rec2020_from(xyz_to_cam: [[f32; 3]; 4]) -> Option<[[f32; 3]; 3]> {
    // Camera from sRGB: how much of each camera channel an sRGB primary excites.
    let mut cam_from_srgb = [[0f64; 3]; 3];
    for (row, slot) in cam_from_srgb.iter_mut().enumerate() {
        for (col, cell) in slot.iter_mut().enumerate() {
            for k in 0..3 {
                *cell += f64::from(xyz_to_cam[row][k]) * crate::hdr_fit::SRGB_TO_XYZ[k][col];
            }
        }
        let sum: f64 = slot.iter().sum();
        if sum.abs() > 1e-9 {
            for cell in slot.iter_mut() {
                *cell /= sum;
            }
        }
    }

    // Singular means the file described something impossible, and declining leaves the caller
    // without a frame rather than with one in invented colours.
    let srgb_from_cam = crate::hdr_fit::invert3(&cam_from_srgb)?;

    let rec2020_from_cam =
        crate::hdr_fit::multiply(&crate::hdr_fit::srgb_to_rec2020(), &srgb_from_cam);

    let mut out = [[0f32; 3]; 3];
    for (row, slot) in out.iter_mut().enumerate() {
        for (col, cell) in slot.iter_mut().enumerate() {
            *cell = rec2020_from_cam[row][col] as f32;
        }
    }
    Some(out)
}

/// Applies the colour transform over the cropped region, quantising to the 16-bit scene-linear the
/// rest of the pipeline reads. `crop` is (left, top, width, height) in the full frame's pixels.
///
/// `rgb` is the demosaic's own output buffer: interleaved triples of native-endian `f32`, `stride`
/// pixels to the row.
fn to_rec2020(rgb: &[u8], stride: usize, crop: (usize, usize, usize, usize), matrix: [[f32; 3]; 3]) -> Vec<u16> {
    let (left, top, width, height) = crop;
    let sample = |at: usize| f32::from_ne_bytes([rgb[at], rgb[at + 1], rgb[at + 2], rgb[at + 3]]);
    let mut out = vec![0u16; width * height * 3];
    out.par_chunks_mut(width * 3).enumerate().for_each(|(row, line)| {
        for (col, pixel) in line.chunks_exact_mut(3).enumerate() {
            let from = ((top + row) * stride + left + col) * 12;
            let (r, g, b) = (sample(from), sample(from + 4), sample(from + 8));
            for (channel, slot) in pixel.iter_mut().enumerate() {
                let value = matrix[channel][0] * r + matrix[channel][1] * g + matrix[channel][2] * b;
                *slot = (value * 65535.0).clamp(0.0, 65535.0) as u16;
            }
        }
    });
    out
}

/// Rewrites the frame upright, returning it with whatever dimensions that left.
///
/// The four transposing orientations swap width and height; the rest are in-place permutations.
fn orient<T: Copy + Default>(
    pixels: Vec<T>,
    width: usize,
    height: usize,
    orientation: rawler::decoders::Orientation,
) -> (Vec<T>, usize, usize) {
    use rawler::decoders::Orientation as O;
    // `Unknown` is left alone deliberately: a file that did not say is more likely to be upright
    // already than to want a guess, and guessing wrong rotates a whole shoot.
    if matches!(orientation, O::Normal | O::Unknown) {
        return (pixels, width, height);
    }

    let transposes = matches!(orientation, O::Transpose | O::Rotate90 | O::Transverse | O::Rotate270);
    let (out_w, out_h) = if transposes { (height, width) } else { (width, height) };
    let mut out = vec![T::default(); pixels.len()];
    for row in 0..height {
        for col in 0..width {
            let (to_col, to_row) = match orientation {
                O::HorizontalFlip => (width - 1 - col, row),
                O::Rotate180 => (width - 1 - col, height - 1 - row),
                O::VerticalFlip => (col, height - 1 - row),
                O::Transpose => (row, col),
                O::Rotate90 => (height - 1 - row, col),
                O::Transverse => (height - 1 - row, width - 1 - col),
                O::Rotate270 => (row, width - 1 - col),
                O::Normal | O::Unknown => (col, row),
            };
            let from = (row * width + col) * 3;
            let to = (to_row * out_w + to_col) * 3;
            out[to..to + 3].copy_from_slice(&pixels[from..from + 3]);
        }
    }
    (out, out_w, out_h)
}

/// The illuminant the decode balanced against.
///
/// `white_balance::as_shot` already takes the camera's multipliers and its XYZ matrix, which is
/// exactly what rawler carries, so this is a shape conversion and not a second implementation -
/// the temperature and tint a photograph reports must not depend on which decoder read it.
fn as_shot_of(image: &rawler::RawImage) -> Option<crate::white_balance::AsShot> {
    let wb = image.wb_coeffs;
    let cam_mul = [wb[0], wb[1], wb[2], wb[3]];
    crate::white_balance::as_shot(&cam_mul, &xyz_to_cam_of(image)?)
}

#[cfg(test)]
mod tests {
    /// Each of the four photosites has its own black level removed, the two greens included.
    ///
    /// **The bug this pins subtracted one green's black from both.** The four levels were read by
    /// position, correctly, and then reordered into an array indexed by colour - where the two
    /// greens are one entry, so whichever was written second won and the other's level was lost.
    /// The frame it produces has a residual of the difference on every other green, a checkerboard
    /// at the sensor's own pitch, worst in the shadows where it is the largest part of the signal.
    #[test]
    fn every_photosite_loses_its_own_black_level() {
        // The four positions of an RGGB site, so the two greens are colour 1 and the ones that
        // collapsed onto each other.
        let cfa = [0u32, 1, 1, 2];
        // The first green's black above the second's, deliberately. The collapse kept the second,
        // so the first would be handed a floor *below* its own - and a residual the other way round
        // is negative, which the clamp at zero swallows and the test never sees.
        let levels = super::Levels {
            black: [500.0, 528.0, 512.0, 516.0],
            white: 16383.0,
            gains: [1.0, 1.0, 1.0, 1.0],
        };
        // Every sample sits exactly on its own black level, so a correct subtraction is zero
        // everywhere and anything left is the wrong level having been used.
        let samples: Vec<u16> = (0..4)
            .flat_map(|row: usize| (0..4).map(move |col: usize| levels.black[(row & 1) * 2 + (col & 1)] as u16))
            .collect();

        let (floor, range, gain) = super::coefficients(cfa, &levels);
        let out = super::normalise(&samples, 4, 4, floor, range, gain);
        for (at, value) in out.iter().enumerate() {
            let (row, col) = (at / 4, at % 4);
            assert!(
                *value < 1e-6,
                "the sample at {row},{col} kept {value} of the black level at position {}",
                (row & 1) * 2 + (col & 1),
            );
        }
    }

    /// The kernel and the CPU produce the same mosaic, sample for sample, exactly.
    ///
    /// **Equality and not a bound**, since this frame is what every later stage and every rendition
    /// is built from: a drift here moves every picture rather than showing up as one failing
    /// assertion. `curve` is what makes equality reachable at all - the shader's own arithmetic was
    /// off by a ULP, because Vulkan requires only 2.5 of them from `OpFDiv`.
    ///
    /// So what is left to get wrong is the packing, and the sizes are the shapes that break it
    /// rather than a sample of ordinary ones. WGSL has no `u16`, so the samples travel two to a
    /// word; **an odd width then leaves every second row starting in the high half of a word**,
    /// which a kernel assuming a per-row stride shears subtly and a fixture suite of even-width
    /// sensors never notices. The last size is over four million samples, which is 70k workgroups
    /// against the 65535 a dispatch dimension allows - the one thing a small frame cannot say
    /// anything about.
    #[test]
    fn the_kernel_conditions_exactly_as_the_cpu_does() {
        let Some(gpu) = crate::gpu::device() else { return };
        let kernels = crate::condition::device(gpu);

        // RGGB, so the two greens are one colour on two positions with two black levels, which is
        // the distinction the tables exist to hold.
        let cfa = [0u32, 1, 1, 2];
        let levels = super::Levels {
            black: [500.0, 528.0, 512.0, 516.0],
            white: 16383.0,
            gains: [2.394, 1.0, 1.597, 1.0],
        };
        let (floor, range, gain) = super::coefficients(cfa, &levels);
        let curve = super::curve(floor, range, gain);

        // Under every black level, on each of them, across the range and past the white level, so
        // both clamps are exercised at every position; every fifth index, so they land on odd
        // columns as well as even ones. The rest is a spread wide enough that a mispacked sample
        // could not read its neighbour's level and agree by coincidence.
        let corners = [0u16, 499, 500, 512, 516, 528, 529, 8191, 16382, 16383, 16384, 32767, 65535];
        let sample = |at: usize| -> u16 {
            match at % 5 {
                0 => corners[at % corners.len()],
                _ => ((at * 7919) % 20011) as u16,
            }
        };

        for (width, height) in [(64usize, 48usize), (63, 47), (1, 1), (3, 2), (2049, 2201)] {
            let samples: Vec<u16> = (0..width * height).map(sample).collect();
            let theirs = super::normalise(&samples, width, height, floor, range, gain);
            let mine = pollster::block_on(
                crate::condition::normalise(gpu, kernels, &samples, width, height, &curve)
                    .expect("the kernel runs")
                    .read(gpu),
            )
            .expect("the mosaic reads back");

            let differs = mine
                .iter()
                .zip(&theirs)
                .position(|(mine, theirs)| mine != theirs)
                .map(|at| (at, mine[at], theirs[at]));
            assert_eq!(
                differs, None,
                "at {width}x{height}, sample {:?} at position {:?}",
                differs.map(|(at, _, _)| samples[at]),
                differs.map(|(at, _, _)| ((at / width) & 1) * 2 + ((at % width) & 1)),
            );
        }
    }

    /// A camera reading its own neutral is what the white balance hands the matrix, so this is the
    /// one colour the matrix is not free to choose: it has to come out grey.
    ///
    /// Normalising the camera matrix in XYZ instead of sRGB failed exactly here, and only here -
    /// a neutral came out scaled by (1.108, 0.966, 0.917), which is the Rec.2020 of XYZ (1,1,1),
    /// a 15% red-over-green cast that no saturated colour would have made as obvious.
    #[test]
    fn a_camera_neutral_stays_neutral() {
        // Canon R5, D65.
        let xyz_to_cam = [
            [0.7695, -0.2686, -0.0805],
            [-0.3428, 1.0964, 0.2861],
            [-0.0136, 0.0428, 0.6461],
            [0.0, 0.0, 0.0],
        ];
        let matrix = super::camera_to_rec2020_from(xyz_to_cam).expect("an invertible matrix");
        let neutral: Vec<f32> = (0..3)
            .map(|row| matrix[row][0] + matrix[row][1] + matrix[row][2])
            .collect();
        for channel in &neutral {
            assert!(
                (channel - neutral[1]).abs() < 1e-3,
                "camera white renders as {neutral:?}",
            );
        }
    }

    /// **A strip a few pixels wide is a decode that declines**, because the demosaic refuses a
    /// window narrower than twice its margin - and a loupe names the width, so one pixel past a
    /// whole tile is an ordinary request rather than a contrived one.
    #[test]
    fn no_tile_is_left_a_runt_strip() {
        for total in [1usize, 2047, 2048, 2049, 4096, 4097, 6024, 9504] {
            let spans: Vec<(usize, usize)> = super::spans(total).collect();
            assert_eq!(spans.first().map(|s| s.0), Some(0), "{total} starts short");
            assert_eq!(spans.last().map(|s| s.1), Some(total), "{total} ends short");
            for pair in spans.windows(2) {
                assert_eq!(pair[0].1, pair[1].0, "{total} leaves a gap");
            }
            let smallest = spans.iter().map(|(a, b)| b - a).min().expect("a span");
            assert!(smallest >= total.min(1024), "{total} cut a {smallest}-wide strip");
        }
    }

    #[test]
    fn a_singular_matrix_is_declined_rather_than_rendered() {
        let flat = [[1.0, 1.0, 1.0], [2.0, 2.0, 2.0], [3.0, 3.0, 3.0], [0.0; 3]];
        assert!(super::camera_to_rec2020_from(flat).is_none());
    }
}
