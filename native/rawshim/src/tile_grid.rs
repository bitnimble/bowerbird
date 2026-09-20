//! The grid the editor holds a level of the picture in, and which squares of it a rectangle wants.
//!
//! **Arithmetic only, so that it is held where a test can reach it.** The tiles themselves are the
//! module's - it owns the device memory they sit in, so it is what answers which of them a viewport
//! is missing (`wasm::HeldRaw`) - but `wasm` is compiled for `wasm32` alone, where a `cargo test`
//! never reaches. The grid deciding one column wrong is a black stripe down a pan, so it lives on
//! this side of that boundary.

/// The side of a tile, in the pixels of the level it was cut from.
///
/// **The grid is the library's and not the page's**, which is why the page forwards one rectangle
/// rather than keeping a second copy of this arithmetic.
///
/// A thousand and twenty-four, which is six megabytes of samples: small enough that a pan costs
/// one or two, large enough that a prepare's fixed cost - a file open and a region decode for
/// every source it touches - is not paid per handful of pixels. Even, as every buffer here is,
/// since a frame is two samples to a word.
pub const TILE: usize = 1024;

/// The columns and rows a rectangle of a level touches, inclusive, held inside the level.
///
/// Half-open in the rectangle: a viewport flush with a boundary does not pull in the tile past it,
/// or every pan would fetch a column it never draws.
pub fn tiles_over(
    at: (usize, usize),
    size: (usize, usize),
    level: (usize, usize),
) -> ((usize, usize), (usize, usize)) {
    let span = |from: usize, span: usize, whole: usize| {
        let count = whole.div_ceil(TILE).max(1);
        let first = (from / TILE).min(count - 1);
        let last = ((from + span).div_ceil(TILE).saturating_sub(1)).clamp(first, count - 1);
        (first, last)
    };
    let (left, right) = span(at.0, size.0, level.0);
    let (top, bottom) = span(at.1, size.1, level.1);
    ((left, top), (right, bottom))
}

/// What one tile covers in its level's pixels, clipped to the level.
pub fn tile_rect(
    column: usize,
    row: usize,
    level: (usize, usize),
) -> ((usize, usize), (usize, usize)) {
    let at = (column * TILE, row * TILE);
    (at, (TILE.min(level.0.saturating_sub(at.0)), TILE.min(level.1.saturating_sub(at.1))))
}

#[cfg(test)]
mod tests {
    use super::{TILE, tile_rect, tiles_over};

    #[test]
    fn the_last_column_and_row_are_short_of_a_whole_tile() {
        let level = (TILE * 2 + 300, TILE + 7);
        assert_eq!(tile_rect(0, 0, level), ((0, 0), (TILE, TILE)));
        assert_eq!(tile_rect(2, 1, level), ((TILE * 2, TILE), (300, 7)));
        // Every square the grid names tiles the level exactly: a column short by a pixel is a
        // stripe of the picture nothing ever fetches, and the reader sees it black.
        let ((left, top), (right, bottom)) = tiles_over((0, 0), level, level);
        let mut covered = 0;
        for column in left..=right {
            for row in top..=bottom {
                let (_, size) = tile_rect(column, row, level);
                covered += size.0 * size.1;
            }
        }
        assert_eq!(covered, level.0 * level.1);
    }

    #[test]
    fn a_rectangle_flush_with_a_boundary_stops_at_it() {
        let level = (TILE * 4, TILE * 4);
        assert_eq!(tiles_over((0, 0), (TILE, TILE), level), ((0, 0), (0, 0)));
        // One pixel over, and the column past it is wanted.
        assert_eq!(tiles_over((0, 0), (TILE + 1, TILE), level), ((0, 0), (1, 0)));
        assert_eq!(tiles_over((TILE, TILE), (TILE * 2, TILE), level), ((1, 1), (2, 1)));
    }

    #[test]
    fn a_rectangle_past_the_level_names_squares_the_level_has() {
        let level = (TILE + 4, TILE + 4);
        // Two columns of a level that is one tile and a sliver: a rectangle running off the end
        // asks for what is there rather than for a column the draw would then read out of bounds.
        assert_eq!(tiles_over((TILE * 3, TILE * 3), (TILE, TILE), level), ((1, 1), (1, 1)));
        assert_eq!(tile_rect(1, 1, level), ((TILE, TILE), (4, 4)));
        // And nothing off it at all is still a square, because a request for none of a level is a
        // request this side never makes.
        assert_eq!(tile_rect(9, 9, level), ((TILE * 9, TILE * 9), (0, 0)));
    }

    #[test]
    fn a_level_smaller_than_one_tile_is_one_square() {
        let level = (640, 480);
        assert_eq!(tiles_over((0, 0), level, level), ((0, 0), (0, 0)));
        assert_eq!(tile_rect(0, 0, level), ((0, 0), (640, 480)));
    }

    #[test]
    fn an_empty_rectangle_names_the_square_it_sits_in() {
        let level = (TILE * 3, TILE * 3);
        assert_eq!(tiles_over((TILE + 5, 0), (0, 0), level), ((1, 0), (1, 0)));
    }
}
