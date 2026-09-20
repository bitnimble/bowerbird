//! What a job asks of an assembly that renders nothing: analyse a burst into a recipe and the seam
//! volume beside it, or solve seams over that volume for the reader's picks.

use crate::assembly::Assembly;
use crate::assembly_seams::{Layout, Seams};
use crate::assembly_volume::Volume;
use crate::composite_job::CompositeJob;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// A set of photographs analysed for an assembly: the recipe, with the seam volume the reader's
/// tiles are solved over written to `volume_path`.
pub fn analyse(pano: &CompositeJob, volume_path: &str) -> Result<String, String> {
    let (headers, models) = crate::composite_job::headers_of(pano);
    let sources = crate::composite_job::sources_of(pano, &headers, &models)?;

    use crate::assembly_analysis::Refused;
    let analysed = match pollster::block_on(crate::assembly_analysis::analyse(&sources)) {
        Ok(analysed) => analysed,
        // An answer rather than a failure: the caller fits these lenses and asks again, which is
        // cheaper than an align of its own run first to find out.
        Err(Refused::Lensless(at)) => {
            let named: Vec<&str> = at
                .iter()
                .filter_map(|&i| sources.get(i))
                .map(|s| s.photo_id)
                .collect();
            return serde_json::to_string(&serde_json::json!({ "lensless": named }))
                .map_err(|error| error.to_string());
        }
        Err(Refused::Cancelled) => return Err(crate::assembly_planes::CANCELLED.to_string()),
        Err(other) => return Err(format!("{other:?}")),
    };
    std::fs::write(volume_path, analysed.volume.to_bytes())
        .map_err(|error| format!("could not write the seam volume: {error}"))?;
    serde_json::to_string(&serde_json::json!({
        "recipe": analysed.assembly,
        "unaligned": analysed.unaligned,
        "warnings": analysed.warnings,
    }))
    .map_err(|error| error.to_string())
}

/// `recipe`'s seams for each of `picks` in its own place, in parallel over one read of the volume:
/// a JSON array, `null` where that set's solve was refused.
pub fn seams(recipe: &Assembly, volume_path: &str, picks: &[Vec<usize>]) -> Result<String, String> {
    use rayon::prelude::*;
    let volume = volume_at(Path::new(volume_path))?;
    let solved: Vec<Option<Seams>> = picks
        .par_iter()
        .map(|pick| {
            let recipe = Assembly {
                pick: pick.clone(),
                ..recipe.clone()
            };
            let layout = layout_for(&volume, &recipe).ok()?;
            Some(crate::assembly_seams::balance(&recipe, &volume, &layout))
        })
        .collect();
    serde_json::to_string(&solved).map_err(|error| error.to_string())
}

/// Layouts held for the volume last solved over, the oldest dropped past it.
const KEPT_LAYOUTS: usize = 64;

type HeldLayout = (Arc<Volume>, String, Arc<Layout>);

/// `recipe`'s layout over `volume`, cut once for everything but the feather: a reader moving it
/// asks again for every pick set on the page, and only the balance moves.
fn layout_for(volume: &Arc<Volume>, recipe: &Assembly) -> Result<Arc<Layout>, String> {
    static HELD: Mutex<VecDeque<HeldLayout>> = Mutex::new(VecDeque::new());
    let key = serde_json::to_string(&Assembly {
        feather: 0.0,
        seams: None,
        ..recipe.clone()
    })
    .map_err(|error| error.to_string())?;
    let found = |held: &VecDeque<HeldLayout>| {
        held.iter()
            .find(|(at, named, _)| Arc::ptr_eq(at, volume) && *named == key)
            .map(|(_, _, layout)| layout.clone())
    };
    let lock = || HELD.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(layout) = found(&lock()) {
        return Ok(layout);
    }
    let layout = Arc::new(crate::assembly_seams::layout(recipe, volume)?);
    let mut held = lock();
    // ponytail: one volume's layouts at a time; two merges open side by side cut again on each switch.
    held.retain(|(at, _, _)| Arc::ptr_eq(at, volume));
    held.push_back((volume.clone(), key, layout.clone()));
    if held.len() > KEPT_LAYOUTS {
        held.pop_front();
    }
    Ok(layout)
}

type Held = (PathBuf, std::time::SystemTime, u64);

/// The seam volume at `path`, read once while the file stays as it was: a reader clicking through
/// a merge solves over the same one on every click.
fn volume_at(path: &Path) -> Result<Arc<Volume>, String> {
    static HELD: Mutex<Option<(Held, Arc<Volume>)>> = Mutex::new(None);
    let unreadable = |error: std::io::Error| format!("could not read the seam volume: {error}");
    let meta = std::fs::metadata(path).map_err(unreadable)?;
    let key = (
        path.to_path_buf(),
        meta.modified().map_err(unreadable)?,
        meta.len(),
    );
    let mut held = HELD.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some((at, volume)) = held.as_ref()
        && *at == key
    {
        return Ok(volume.clone());
    }
    let bytes = std::fs::read(path).map_err(unreadable)?;
    let volume = Arc::new(Volume::from_bytes(&bytes)?);
    *held = Some((key, volume.clone()));
    Ok(volume)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A strip of `cells` over one frame.
    fn volume(cells: usize) -> Volume {
        Volume {
            plane: (cells * 4, 4),
            shrunk: (cells, 1),
            field: crate::assembly_seam::SeamField {
                level: vec![0.0; cells * 2],
                tint: vec![0.0; cells * 2],
                sources: 1,
            },
        }
    }

    /// The shapes `worker_command.ts` writes, and the one a seam solve cannot run without.
    #[test]
    fn a_job_names_what_its_want_needs_and_is_refused_without_it() {
        use crate::composite_job::{CompositeJob, Want};
        let recipe = serde_json::to_value(Assembly::untiled(
            crate::composition::Composition::of_one([16, 4], crate::composition::LensSpec::none()),
        ))
        .unwrap();
        let read = |job: serde_json::Value| serde_json::from_value::<CompositeJob>(job);

        let seams = read(serde_json::json!({
            "want": "seams", "sources": [], "recipe": recipe, "volumePath": "v.bin", "picks": [[1, 0]],
        }))
        .expect("a seam solve");
        let Want::Seams {
            volume_path, picks, ..
        } = seams.want
        else {
            panic!("read as another want")
        };
        assert_eq!((volume_path.as_str(), picks), ("v.bin", vec![vec![1, 0]]));

        let analyse =
            read(serde_json::json!({ "want": "analyse", "sources": [], "volumePath": "v.bin" }));
        assert!(matches!(
            analyse.expect("an analysis").want,
            Want::Analyse { .. }
        ));
        assert!(
            read(
                serde_json::json!({ "want": "seams", "sources": [], "recipe": recipe, "picks": [] })
            )
            .is_err()
        );
        assert!(read(serde_json::json!({ "want": "render", "sources": [] })).is_err());
    }

    #[test]
    fn a_layout_is_cut_again_for_a_new_recipe_and_not_for_a_new_feather() {
        let volume = Arc::new(volume(4));
        let mut recipe = Assembly::untiled(crate::composition::Composition::of_one(
            [16, 4],
            crate::composition::LensSpec::none(),
        ));
        let first = layout_for(&volume, &recipe).expect("a layout");

        recipe.feather = 0.08;
        let wider = layout_for(&volume, &recipe).expect("a layout");
        recipe.vertices.push([1.0, 1.0]);
        let moved = layout_for(&volume, &recipe).expect("a layout");

        assert!(Arc::ptr_eq(&first, &wider));
        assert!(!Arc::ptr_eq(&first, &moved));
    }

    #[test]
    fn a_seam_volume_is_read_again_only_once_its_file_changes() {
        let path = std::env::temp_dir().join(format!("bowerbird-seams-{}.bin", std::process::id()));
        std::fs::write(&path, volume(2).to_bytes()).unwrap();

        let first = volume_at(&path).expect("a volume");
        let again = volume_at(&path).expect("a volume");
        std::fs::write(&path, volume(3).to_bytes()).unwrap();
        let changed = volume_at(&path).expect("a volume");
        std::fs::remove_file(&path).unwrap();

        assert!(Arc::ptr_eq(&first, &again));
        assert_eq!(changed.shrunk, (3, 1));
        assert!(volume_at(&path).is_err());
    }
}
