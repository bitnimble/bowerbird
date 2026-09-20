//! What each piece's frame is multiplied by to meet the light across its seams.

use crate::assembly_labelling::{Reader, four};
use crate::assembly_seam::{TINT_NOISE, TINT_SIGNIFICANT, beyond};
use crate::light::{Gain, Stops};

/// By frame and the drawn tile it is read through, what that frame's light is multiplied by.
pub(crate) type Balance = std::collections::BTreeMap<(usize, u32), Gain>;

/// The largest correction [`balanced`] answers, either way.
const MOST_BALANCE: f32 = 2.0;

/// How far, in stops, a reading across a seam may be off the gain before it counts for less: what
/// moved across a seam disagrees by far more than an exposure drifted, and is outvoted.
const BALANCE_SCALE: f32 = 0.25;

const BALANCE_SWEEPS: usize = 30;

/// Per piece of `label`, the gain that makes its frame meet what lies across its seams: both frames
/// read at every cell within `band` of a seam, weighted as §5.2 mixes them there, least squares over
/// every seam at once so two taken pieces meeting each other agree too, the base held where it is.
pub(crate) fn balanced(reader: &Reader, label: &[usize], base: usize, band: usize) -> Balance {
    let (w, h) = reader.volume.shrunk;
    let sources = reader.volume.field.sources;
    let field = &reader.volume.field;
    let key = |p: usize| {
        (label[p] != base).then(|| (label[p], reader.shifted_by[p * sources + label[p]]))
    };
    let mut keys: Vec<(usize, u32)> = (0..w * h).filter_map(key).collect();
    keys.sort_unstable();
    keys.dedup();
    let node: Vec<Option<usize>> = (0..w * h)
        .map(|p| key(p).map(|k| keys.binary_search(&k).expect("a key of the labelling")))
        .collect();
    let source = |n: Option<usize>| n.map_or(base, |k| keys[k].0);

    // Each cell within `band` of a seam, by the nearest seam on its own side: the piece across it,
    // and how many cells off it.
    let mut across: Vec<Option<(Option<usize>, usize)>> = vec![None; w * h];
    let mut front = Vec::new();
    for p in 0..w * h {
        if let Some(q) = four(p, (w, h)).find(|&q| node[q] != node[p]) {
            across[p] = Some((node[q], 0));
            front.push(p);
        }
    }
    for step in 1..band {
        let mut next = Vec::new();
        for p in front {
            let Some((other, _)) = across[p] else {
                continue;
            };
            for q in four(p, (w, h)) {
                if across[q].is_none() && node[q] == node[p] {
                    across[q] = Some((other, step));
                    next.push(q);
                }
            }
        }
        front = next;
    }

    // Per piece, what its gain is pulled towards: another's plus a difference, at a weight, and
    // whether the reading is on the seam itself.
    let half = band.max(1) as f32;
    let mut toward: Vec<Vec<(Option<usize>, f32, f32, bool)>> = vec![Vec::new(); keys.len()];
    for p in 0..w * h {
        let Some((other, off)) = across[p] else {
            continue;
        };
        let own = node[p];
        let (Some((light_a, from_a)), Some((light_b, from_b))) =
            (reader.read(p, source(own)), reader.read(p, source(other)))
        else {
            continue;
        };
        let [au, av] = field.tint(from_a, source(own));
        let [bu, bv] = field.tint(from_b, source(other));
        let colour = (au.raw() - bu.raw()).hypot(av.raw() - bv.raw()) as f32;
        // The other frame's share of §5.2's `smoothstep(-W, W, d)`, one at the seam.
        let at = ((off as f32 + 0.5 + half) / (2.0 * half)).clamp(0.0, 1.0);
        let mixed = 2.0 * (1.0 - at * at * (3.0 - 2.0 * at));
        let weight = (1.0 - beyond(colour, TINT_NOISE, TINT_SIGNIFICANT)) * mixed;
        if weight <= 0.0 {
            continue;
        }
        // `light_a + g_a = light_b + g_b`.
        let gap = light_a - light_b;
        if let Some(a) = own {
            toward[a].push((other, -gap, weight, off == 0));
        }
        if let Some(b) = other {
            toward[b].push((own, gap, weight, off == 0));
        }
    }

    // Gauss-Seidel over the pieces, each reading reweighted by how far it is off the current answer
    // as it goes (Cauchy's). The seam's own cells first: the solve put the frames in agreement there,
    // and a piece is mostly what its frame changes, so the band alone can outvote the answer.
    let mut stops = vec![0f32; keys.len()];
    for seam_only in [true, false] {
        for _ in 0..BALANCE_SWEEPS {
            for k in 0..keys.len() {
                let (mut sum, mut total) = (0f32, 0f32);
                for &(other, gap, weight, on_seam) in &toward[k] {
                    if seam_only && !on_seam {
                        continue;
                    }
                    let want = other.map_or(0.0, |o| stops[o]) + gap;
                    let off = (stops[k] - want) / BALANCE_SCALE;
                    let weight = weight / (1.0 + off * off);
                    sum += weight * want;
                    total += weight;
                }
                if total > 0.0 {
                    stops[k] = (sum / total).clamp(-MOST_BALANCE, MOST_BALANCE);
                }
            }
        }
    }
    keys.into_iter()
        .zip(stops)
        .map(|(k, s)| (k, Gain::of(Stops::measured(f64::from(s)))))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assembly_labelling::{RING, stamped};
    use crate::assembly_seams::tests::{SIZE, burst, drawn, untiled};
    use crate::px::{Shrunk, Span};

    #[test]
    fn a_piece_is_balanced_over_the_band_its_seam_is_blended_across() {
        // The other frame is a fifth of a stop brighter everywhere but the cells either side of the
        // seam, which alone would say it needs nothing.
        let (w, h) = SIZE;
        let inside = |p: usize| (100..140).contains(&(p % w)) && (80..120).contains(&(p / w));
        let mut volume = burst([0, 0, 0, 0]);
        let label: Vec<usize> = (0..w * h).map(|p| usize::from(inside(p))).collect();
        for p in 0..w * h {
            if !four(p, (w, h)).any(|q| inside(q) != inside(p)) {
                volume.field.level[p * 3 + 2] += 0.2;
            }
        }
        let recipe = drawn(untiled(), [118, 98, 121, 101], 1);
        let ring = RING.over(Span::<Shrunk>::exact(w)).raw();
        let stamp = stamped(&recipe, &volume, ring, Some(&[[0.0; 2]]));
        let reader = Reader {
            volume: &volume,
            shift: &stamp.shift,
            shifted_by: &stamp.shifted_by,
        };
        let stops = |band: usize| {
            let gain = balanced(&reader, &label, recipe.base, band);
            Stops::of(*gain.values().next().expect("the piece's gain")).raw()
        };

        let (narrow, wide) = (stops(1), stops(10));
        assert!(narrow.abs() < 0.02, "a one-cell band balanced by {narrow}");
        assert!(wide < -0.1, "a ten-cell band balanced by only {wide}");
    }
}
