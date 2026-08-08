//! Shows what the colour fit's correspondence search actually matched, as pictures.
//!
//! A confidently wrong match scores as well as a right one, so the score cannot say which
//! it was - only the two patches side by side can. Each tile is three panels: our render,
//! the camera at the same coordinate, and the camera at the offset the search chose. If
//! the search is working the third panel lines up with the first where the second does not.
//!
//! usage: matches <raw> <out-dir> [count]

use rawshim::image::resize;
use std::env;

/// Half-width of a tile, in wide-plane pixels. Wide enough to see what the patch sat on,
/// where the 7x7 the search itself judges would show nothing to a reader.
const HALF: usize = 48;

/// Nearest-neighbour, so a shift of one wide pixel is visible as a shift of four.
const ZOOM: usize = 4;

fn main() {
    let mut args = env::args().skip(1);
    let path = args.next().expect("raw path");
    let out = args.next().expect("out dir");
    let count: usize = args.next().and_then(|v| v.parse().ok()).unwrap_or(8);

    let decoded = rawshim::decode_frame(&path, 8, false, 0).expect("decode");
    let render = decoded.rgb8().expect("an 8-bit render");
    let profile = rawshim::fit_profile_for(&decoded, &path).expect("a fit");

    let preview = rawshim::decode_embedded_rgb(&path, rawshim::hdr_fit::sample_long_edge())
        .expect("a preview");
    let sampled = resize(render, preview.width, preview.height);

    // Scattered rather than random: a seeded walk over the plane, so the same call shows the
    // same points twice and a surprising tile can be looked at again.
    let (wide, tall) = (preview.width, preview.height);
    eprintln!("wide plane {wide}x{tall}");
    let asked: Vec<(usize, usize)> = args
        .map(|spec| {
            let n: Vec<usize> = spec.split(',').map(|v| v.parse().expect("a number")).collect();
            (n[0], n[1])
        })
        .collect();
    let mut points = asked.clone();
    let mut at = 7_919usize;
    while points.len() < count * 40 && asked.is_empty() {
        at = at.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        let p = (at >> 33) % (wide * tall);
        points.push((p % wide, p / wide));
    }

    let (ours, theirs, found) = rawshim::hdr_fit::correspondence_at(
        &sampled,
        &preview,
        &profile.lens(),
        &points,
    );

    let mut shown = 0;
    let (mut featureless, mut declined, mut searched) = (0, 0, 0);
    for ((x, y), what) in points.iter().zip(found.iter()) {
        let Some(what) = what else {
            declined += 1;
            continue;
        };
        if what.featureless {
            featureless += 1;
            if asked.is_empty() {
                continue;
            }
        } else {
            searched += 1;
        }
        if (shown >= count && asked.is_empty()) || *x < HALF + 8 || *y < HALF + 8 {
            continue;
        }
        shown += 1;
        let at = |p: &rawshim::hdr_fit::Plane, ox: isize, oy: isize| {
            let i = ((*y as isize + oy) as usize * p.width + (*x as isize + ox) as usize) * 3;
            format!(
                "{:.0}/{:.0}/{:.0}",
                p.data[i] * 255.0,
                p.data[i + 1] * 255.0,
                p.data[i + 2] * 255.0,
            )
        };
        eprintln!(
            "  ours {} camera {} (ceiling {:.0}, camera clip {:.0})",
            at(&ours, 0, 0),
            at(&theirs, what.dx, what.dy),
            rawshim::hdr_fit::TRUST_CEILING * 255.0,
            0.94 * 255.0,
        );
        let tile = tile(&ours, &theirs, *x, *y, what.dx, what.dy);
        let name = format!("{out}/match-{x}-{y}-peak{:.2}-d{}_{}.jpg", what.peak, what.dx, what.dy);
        let bytes = rawshim::jpeg::encode(tile.as_ref(), 95).expect("the tile encodes");
        std::fs::write(&name, bytes).expect("the tile writes");
        eprintln!("{name}");
    }
    eprintln!(
        "of {} points: {searched} searched, {featureless} featureless, {declined} declined",
        points.len(),
    );
}

/// Ours, the camera unshifted, and the camera at the found offset - in that order.
fn tile(
    ours: &rawshim::hdr_fit::Plane,
    theirs: &rawshim::hdr_fit::Plane,
    x: usize,
    y: usize,
    dx: isize,
    dy: isize,
) -> rawshim::rgb::Rgb {
    let side = HALF * 2 * ZOOM;
    let gap = 8;
    let width = side * 3 + gap * 2;
    let mut data = vec![255u8; width * side * 3];
    let panels = [(ours, 0isize, 0isize), (theirs, 0, 0), (theirs, dx, dy)];
    for (panel, (plane, ox, oy)) in panels.iter().enumerate() {
        let left = panel * (side + gap);
        for row in 0..side {
            for col in 0..side {
                // Nearest neighbour on purpose: interpolating would smooth away the one
                // pixel of shift these tiles exist to show.
                let sx = (x + col / ZOOM) as isize - HALF as isize + ox;
                let sy = (y + row / ZOOM) as isize - HALF as isize + oy;
                if sx < 0 || sy < 0 || sx >= plane.width as isize || sy >= plane.height as isize {
                    continue;
                }
                let from = (sy as usize * plane.width + sx as usize) * 3;
                let to = (row * width + left + col) * 3;
                for c in 0..3 {
                    data[to + c] = (plane.data[from + c].clamp(0.0, 1.0) * 255.0).round() as u8;
                }
            }
        }
    }
    // The three windows, so the sizes can be compared by eye rather than from the source:
    // the 3x3 the colour is actually read through, the 7x7 the match is judged on, and the
    // +-4 the search may move within.
    for panel in 0..3 {
        let left = panel * (side + gap);
        for (half, ink) in [(1usize, [255, 32, 32]), (3, [255, 220, 0]), (4 + 3, [0, 200, 255])] {
            outline(&mut data, width, left, half, ink);
        }
    }
    rawshim::rgb::Rgb { width, height: side, data }
}

/// A box of half-width `half` wide-plane pixels, centred on the tile's centre.
fn outline(data: &mut [u8], width: usize, left: usize, half: usize, ink: [u8; 3]) {
    let low = (HALF - half) * ZOOM;
    let high = (HALF + half + 1) * ZOOM;
    let mut ink_at = |x: usize, y: usize| {
        let at = (y * width + left + x) * 3;
        data[at..at + 3].copy_from_slice(&ink);
    };
    // Two pixels thick, or a one-pixel outline over foliage does not survive the JPEG it
    // gets looked at through.
    for t in 0..2 {
        for x in low..high {
            ink_at(x, low + t);
            ink_at(x, high - 1 - t);
        }
        for y in low..high {
            ink_at(low + t, y);
            ink_at(high - 1 - t, y);
        }
    }
}
