//! Which way up a file says its picture goes, in the one numbering the shaders switch on.
//!
//! **Two decoders and two shaders read this, so it is written once.** A RAW is turned as
//! `assemble.slang` writes the demosaic's tiles; a finished picture is turned as
//! `linearise.slang` writes its own; and both hosts name a region in the *upright* picture and
//! have to find it in the stored one. Those are the same eight cases four times over, and the
//! failure when two of them disagree is not a crash - it is a photograph assembled out of the
//! right pixels in the wrong places.
//!
//! `Unknown` is `Normal` throughout, deliberately: a file that did not say is more likely to be
//! upright already than to want a guess, and guessing wrong rotates a whole shoot.

use rawler::decoders::Orientation as O;

/// The number `assemble.slang` and `linearise.slang` both switch on.
pub fn code(orientation: rawler::decoders::Orientation) -> u32 {
    match orientation {
        O::HorizontalFlip => 1,
        O::Rotate180 => 2,
        O::VerticalFlip => 3,
        O::Transpose => 4,
        O::Rotate90 => 5,
        O::Transverse => 6,
        O::Rotate270 => 7,
        O::Normal | O::Unknown => 0,
    }
}

/// A HEIF container's turn, in rawler's terms.
pub fn of_heif(turn: heif::Orientation) -> rawler::decoders::Orientation {
    use heif::Orientation as H;
    match turn {
        H::Normal => O::Normal,
        H::HorizontalFlip => O::HorizontalFlip,
        H::Rotate180 => O::Rotate180,
        H::VerticalFlip => O::VerticalFlip,
        H::Transpose => O::Transpose,
        H::Rotate90 => O::Rotate90,
        H::Transverse => O::Transverse,
        H::Rotate270 => O::Rotate270,
    }
}

/// Whether this turn swaps the picture's axes.
pub fn transposes(orientation: rawler::decoders::Orientation) -> bool {
    matches!(orientation, O::Transpose | O::Rotate90 | O::Transverse | O::Rotate270)
}

/// A rectangle named in the upright picture, as the rectangle of the stored one it reads.
///
/// **The mistake this exists to prevent is a tile of the right size showing the wrong place.** A
/// caller names a window where a reader sees it; the bytes are in the orientation the file stored
/// them in, and on a portrait frame those are not the same rectangle at all.
///
/// `width` and `height` are the *stored* picture's, before the turn - which is the space the
/// shaders' `frame_width` and `frame_height` are in too.
pub fn unoriented_rect(
    tile: crate::Tile,
    width: usize,
    height: usize,
    orientation: rawler::decoders::Orientation,
) -> crate::Tile {
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

/// Rewrites a frame upright on the host, returning it with whatever dimensions that left.
///
/// The shaders do this as part of their own write; what still needs it here is the embedded
/// preview, which is decoded on the CPU and never reaches a kernel.
pub fn orient<T: Copy + Default>(
    pixels: Vec<T>,
    width: usize,
    height: usize,
    orientation: rawler::decoders::Orientation,
) -> (Vec<T>, usize, usize) {
    if matches!(orientation, O::Normal | O::Unknown) {
        return (pixels, width, height);
    }

    let (out_w, out_h) = match transposes(orientation) {
        true => (height, width),
        false => (width, height),
    };
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

/// [`orient`] by the code the shaders take, for the test that holds a shader's inverse against
/// this permutation.
#[cfg(test)]
pub(crate) fn orient_for_test(
    pixels: Vec<u16>,
    width: usize,
    height: usize,
    code: u32,
) -> (Vec<u16>, usize, usize) {
    let orientation = match code {
        1 => O::HorizontalFlip,
        2 => O::Rotate180,
        3 => O::VerticalFlip,
        4 => O::Transpose,
        5 => O::Rotate90,
        6 => O::Transverse,
        7 => O::Rotate270,
        _ => O::Normal,
    };
    orient(pixels, width, height, orientation)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The corner walk and the pixel walk are inverses, which is the only thing holding a window
    /// named upright to the bytes it actually reads.
    #[test]
    fn a_window_of_the_upright_picture_finds_itself_in_the_stored_one() {
        let (width, height) = (7usize, 4usize);
        for code in 0..8u32 {
            let turn = match code {
                1 => O::HorizontalFlip,
                2 => O::Rotate180,
                3 => O::VerticalFlip,
                4 => O::Transpose,
                5 => O::Rotate90,
                6 => O::Transverse,
                7 => O::Rotate270,
                _ => O::Normal,
            };
            // A picture whose every pixel names where it came from, turned.
            let stored: Vec<u16> =
                (0..width * height).flat_map(|at| [at as u16, 0, 0]).collect();
            let (turned, out_w, _) = orient(stored, width, height, turn);

            // One pixel of the upright picture, found in the stored raster by the corner walk.
            let (ox, oy) = (2usize, 1usize);
            let window = crate::Tile { left: ox, top: oy, width: 1, height: 1 };
            let back = unoriented_rect(window, width, height, turn);
            assert_eq!(
                turned[(oy * out_w + ox) * 3],
                (back.top * width + back.left) as u16,
                "{turn:?} disagrees with itself",
            );
        }
    }

    #[test]
    fn only_a_quarter_turn_swaps_the_axes() {
        for turn in [O::Normal, O::HorizontalFlip, O::Rotate180, O::VerticalFlip] {
            assert!(!transposes(turn), "{turn:?}");
        }
        for turn in [O::Transpose, O::Rotate90, O::Transverse, O::Rotate270] {
            assert!(transposes(turn), "{turn:?}");
        }
    }
}
