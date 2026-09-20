//! What an assembly is: a composition's geometry, and the tiles across it that each take one frame.
//! A recipe, not a picture, for [`crate::composition`]'s reasons.

use crate::composition::Composition;
use crate::light::Gain;
use crate::px::Share;
use serde::{Deserialize, Serialize};

/// What a tile asks the frame it picks for.
///
/// **The whole of the difference between replacing a thing and removing one.** A tile taking
/// [`Takes::Subject`] reads its frame where the thing under the reader's click went, so a person
/// who moved between frames is taken as they stand there; one taking [`Takes::Ground`] reads it
/// in place, so what comes back is whatever stands there instead.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Takes {
    #[default]
    Subject,
    Ground,
}

/// A composition with tiles across it, each of which takes its pixels from one source.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Assembly {
    #[serde(flatten)]
    pub spec: Composition,
    /// Canvas pixels the tile loops are drawn from.
    pub vertices: Vec<[f32; 2]>,
    /// One loop of vertex indices a tile: the least of what its pick takes (`assembly_seams`).
    pub tiles: Vec<Vec<u32>>,
    /// Which source each tile takes.
    pub pick: Vec<usize>,
    /// What each tile asks that source for. Shorter than [`Assembly::tiles`], or absent, where the
    /// recipe was written before a tile could ask for anything but its subject.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub takes: Vec<Takes>,
    /// The source every pixel outside every tile comes from. One more pick, not a fallback: every
    /// tile has one.
    pub base: usize,
    /// The most §5.2's `W(x)` may be anywhere, as a share of the long edge: the reader's.
    #[serde(default = "default_feather")]
    pub feather: f32,
    /// Where the picked frames actually meet, solved for `pick` and `base` (`assembly_seams`).
    /// Absent, the tiles are the seams.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seams: Option<crate::assembly_seams::Seams>,
}

fn default_feather() -> f32 {
    crate::assembly_weight::FEATHER.raw() as f32
}

impl Assembly {
    /// A recipe over `spec` with no tiles yet, every pixel taking its reference.
    pub fn untiled(spec: Composition) -> Assembly {
        Assembly {
            base: spec.reference,
            vertices: Vec::new(),
            tiles: Vec::new(),
            pick: Vec::new(),
            takes: Vec::new(),
            feather: default_feather(),
            seams: None,
            spec,
        }
    }

    /// The recipe as a render draws it: the solved pieces, each under its own warp and balance, or
    /// the tiles themselves where nothing was solved.
    pub fn rendered(&self) -> Result<Drawing, String> {
        let drawing = |vertices, tiles, pick, corridor, warp, gain| Drawing {
            spec: self.spec.clone(),
            vertices,
            tiles,
            pick,
            base: self.base,
            corridor,
            warp,
            gain,
            feather: self.feather,
        };
        let Some(seams) = &self.seams else {
            let tiles = self.tiles.len();
            // A tile has no corridor of its own, so its blend is the narrowest the render draws.
            return Ok(drawing(
                self.vertices.clone(),
                self.tiles.clone(),
                self.pick.clone(),
                vec![0.0; tiles],
                vec![crate::composition::no_warp().map(|at| at as f32); tiles],
                vec![Gain::ONE; tiles],
            ));
        };
        // The takes as well as the picks: a tile flipped between its subject and the ground names
        // the same frame, and the seams that follow are a different shape entirely. Compared tile
        // by tile, since a list left empty and one naming every subject mean the same recipe.
        let takes_differ = (0..self.tiles.len()).any(|tile| {
            let solved = seams.takes.get(tile).copied().unwrap_or_default();
            solved != self.takes(tile)
        });
        if seams.pick != self.pick || seams.base != self.base || takes_differ {
            return Err("the seams were solved for other picks than the recipe's".into());
        }
        Ok(drawing(
            seams.vertices.clone(),
            seams.tiles.clone(),
            seams.source.clone(),
            seams.corridor.clone(),
            seams.warp.clone(),
            seams
                .exposure
                .iter()
                .map(|&gain| Gain::of_ratio(f64::from(gain)))
                .collect(),
        ))
    }

    /// [`Assembly::feather`] as the share it is.
    pub fn feather(&self) -> Share {
        Share::measured(f64::from(self.feather), 1.0)
    }

    /// What tile `tile` asks its pick for.
    pub fn takes(&self, tile: usize) -> Takes {
        self.takes.get(tile).copied().unwrap_or_default()
    }
}

/// An assembly as a render draws it: pieces, each taking one frame through its own warp and gain.
#[derive(Clone, Debug)]
pub struct Drawing {
    pub spec: Composition,
    /// Canvas pixels the piece loops are drawn from.
    pub vertices: Vec<[f32; 2]>,
    pub tiles: Vec<Vec<u32>>,
    /// Which source each piece takes.
    pub pick: Vec<usize>,
    /// The source every pixel outside every piece comes from.
    pub base: usize,
    /// Per piece, the room its seam has, **as a share of the long edge**, capped at the piece's own
    /// inradius so that §5.2's feather cannot be wider than the piece is deep. What `W(x)` is built
    /// from.
    pub corridor: Vec<f32>,
    /// Per piece, the affine over the **canvas** that says where its frame is read -
    /// `[a, b, c, d, tx, ty]` of `[a b; c d] * p + t` - so that what it shows lands where the base
    /// showed it.
    pub warp: Vec<[f32; 6]>,
    /// Per piece, what its frame's light is multiplied by to meet what lies across its seams.
    pub gain: Vec<Gain>,
    /// As [`Assembly::feather`].
    pub feather: f32,
}

impl Drawing {
    /// [`Drawing::feather`] as the share it is.
    pub fn feather(&self) -> Share {
        Share::measured(f64::from(self.feather), 1.0)
    }

    /// Piece `tile`'s warp, in `f64`.
    pub fn warp_of(&self, tile: usize) -> [f64; 6] {
        self.warp[tile].map(f64::from)
    }

    /// The base first, then every other distinct pick ascending.
    ///
    /// The order is the render's: §5.2's mask strides by it, so a second ordering anywhere is a
    /// picture taking the wrong frame.
    pub fn sources_used(&self) -> Vec<usize> {
        let mut rest: Vec<usize> = self
            .pick
            .iter()
            .copied()
            .filter(|&p| p != self.base)
            .collect();
        rest.sort_unstable();
        rest.dedup();
        std::iter::once(self.base).chain(rest).collect()
    }
}
