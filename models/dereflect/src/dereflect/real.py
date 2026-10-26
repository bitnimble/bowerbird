"""Real photographs through glass, trained on beside the composites, each scene one photograph without
the reflection and one or more through the glass, from a tripod:

- `rrw`: RRW (Zhu et al., CVPR 2024), MIT, a folder of its zips: the reflection blocked by black cloth
  with the glass left in place, so the glass's own dimming stays in, and video frames as it changes.
- `pairs`: sets laid out as `.../blended/NAME` beside `.../transmission_layer/NAME`, in zips or folders:
  OpenRR-5k (Cai et al., NTIRE 2026), CC BY-NC-SA 4.0; DRR (Hu et al., "Dereflection Any Image", 2025),
  released with no licence; folders named for a public benchmark are skipped.
- `polargb`: PolaRGB's RGB frames (Yao et al., PolarFree, CVPR 2025), CC BY-NC 4.0, `gt/NN/` beside
  `input/NN/`.

All are processed sRGB, so they come back to light only approximately: through a generic camera's tone
curve and the sRGB curve (Brooks et al., CVPR 2019), then to Rec.2020, shrunk as the library's frames
are. Each set gets its own cache.

    uv run python -m dereflect.real <rrw|pairs|polargb> <source> --cache <dir>
"""

import argparse
import hashlib
import json
import math
import random
import zipfile
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from typing import NamedTuple

import numpy as np
import torch
import torch.nn.functional as F
from torch.utils.data import Dataset

from dereflect.composites import EXPOSURE_STOPS
from dereflect.frames import EDGE, shrunk, stale, white
from dereflect.images import codes, light_from_srgb
from training.crops import DATASETS
from training.files import write_atomic
from training.preview import REC2020_TO_SRGB

DEFAULT_REAL = DATASETS / "dereflect-real"
FRAMES_PER_SCENE = 24
CLIPPED_CODE = 250
VALIDATION_ONE_IN = 10
PICTURES = {".png", ".jpg", ".jpeg"}
SELECTION = f"{FRAMES_PER_SCENE} frames a scene, edge {EDGE}, inverse smoothstep then sRGB"
BENCHMARKS = ("real20", "solidobject", "postcard", "wildscene", "nature", "sir2")
"""Folder names of the public benchmarks `benchmark` scores on, which training must never see."""
MEASURED_FROM = 0.15
"""Of the clean frame's white: darker pixels' 8-bit steps are more than the gains being measured."""
GAIN_REACH = 0.7
GAIN_BINS = 280
DARKER_BY = 0.05
DARKER_LIMIT = 0.2
TRANSMISSION_MEASURE = (
    f"{SELECTION}; modal gain in {GAIN_BINS} bins within {GAIN_REACH} over {MEASURED_FROM} of white, darker by {DARKER_BY}"
)


class Picture(NamedTuple):
    """A picture file: `name` inside the zip `source`, or under the folder `source`."""

    source: Path
    name: str


class Scene(NamedTuple):
    clean: Picture
    through: list[Picture]
    key: str
    group: str
    cache: Path


def main() -> None:
    parser = argparse.ArgumentParser(description="Bring a set of real pairs into the cache training reads.")
    parser.add_argument("kind", choices=sorted(FINDERS))
    parser.add_argument("source", type=Path, help="the set's folder, of zips or of its pictures")
    parser.add_argument("--cache", type=Path, default=DEFAULT_REAL)
    parser.add_argument("--workers", type=int, default=3)
    args = parser.parse_args()
    prepare(FINDERS[args.kind](args.source, args.cache), args.cache, args.workers)


def prepare(found: list[Scene], cache: Path, workers: int) -> None:
    cache.mkdir(parents=True, exist_ok=True)
    pending = [scene for scene in found if stale(cache / f"{scene.key}.json", SELECTION)]
    print(f"{len(found)} scenes, {len(pending)} to prepare", flush=True)
    with ProcessPoolExecutor(workers) as pool:
        for done, name in enumerate(pool.map(prepare_scene, pending, chunksize=8), 1):
            if done % 100 == 0 or done == len(pending):
                print(f"{done}/{len(pending)} {name}", flush=True)


def rrw_scenes(folder: Path, cache: Path) -> list[Scene]:
    """Each scene in RRW's zips: its `_GT.png` and its folder of frames."""
    found = []
    for archive in sorted(folder.glob("*.zip")):
        names = [name for name in members(archive) if Path(name).suffix.lower() in PICTURES]
        truths = {Path(name).name.removesuffix("_GT.png"): name for name in names if name.endswith("_GT.png")}
        frames = defaultdict(list)
        for name in names:
            if not name.endswith("_GT.png"):
                frames[Path(name).parent.name].append(name)
        for scene, truth in sorted(truths.items()):
            shown = sorted(frames.get(scene, []))
            if shown:
                key = hashlib.sha1(f"{archive.stem}/{scene}".encode()).hexdigest()
                found.append(Scene(Picture(archive, truth), [Picture(archive, n) for n in chosen(shown)], key, key, cache))
    return found


def pair_scenes(folder: Path, cache: Path) -> list[Scene]:
    """Each `blended/NAME` under `folder`, its zips included, with the `transmission_layer/NAME` beside
    it, which may be in another zip; benchmarks' folders left out."""
    blended: dict[tuple[str, str], Picture] = {}
    transmitted: dict[tuple[str, str], Picture] = {}
    for picture in pictures_under(folder):
        parts = Path(picture.name).parts
        if len(parts) < 2 or any(benchmark in part.lower() for part in parts for benchmark in BENCHMARKS):
            continue
        at = (parts[-3] if len(parts) > 2 else "", parts[-1])
        if parts[-2] == "blended":
            blended[at] = picture
        elif parts[-2] == "transmission_layer":
            transmitted[at] = picture
    # OpenRR-5k zips its validation split as `val_300/blended` but bare `transmission_layer`.
    by_name = {name: picture for (_, name), picture in transmitted.items()}
    videos: dict[tuple[str, str], list[str]] = defaultdict(list)
    for split, name in sorted(blended):
        if (split, name) in transmitted or name in by_name:
            videos[split, name.split("_frame_")[0]].append(name)
    found = []
    for (split, video), names in sorted(videos.items()):
        # DRR's `<video>_frame_NNNN` are frames of one video, each with its own aligned transmission,
        # so they stay separate pairs but share a side of the held-out split.
        group = hashlib.sha1(f"{folder.name}/{split}/{video}".encode()).hexdigest()
        for name in chosen(names):
            clean = transmitted.get((split, name)) or by_name[name]
            key = hashlib.sha1(f"{folder.name}/{split}/{name}".encode()).hexdigest()
            found.append(Scene(clean, [blended[split, name]], key, group, cache))
    return found


def polargb_scenes(folder: Path, cache: Path) -> list[Scene]:
    """Each PolaRGB scene: `.../gt/NN/0000_rgb.png` and the `.../input/NN/*_rgb.png` beside it."""
    found = []
    for truth in sorted(folder.rglob("gt/*/*_rgb.png")):
        shown = sorted(truth.parent.parent.parent.glob(f"input/{truth.parent.name}/*_rgb.png"))
        if shown:
            scene = truth.parent.relative_to(folder)
            key = hashlib.sha1(f"polargb/{scene}".encode()).hexdigest()
            through = [Picture(folder, str(p.relative_to(folder))) for p in chosen(shown)]
            found.append(Scene(Picture(folder, str(truth.relative_to(folder))), through, key, key, cache))
    return found


FINDERS = {"rrw": rrw_scenes, "pairs": pair_scenes, "polargb": polargb_scenes}


def chosen(frames: list[str] | list[Path]) -> list:
    """Up to `FRAMES_PER_SCENE` of a scene's frames, spread evenly."""
    return [frames[round(i)] for i in np.linspace(0, len(frames) - 1, min(FRAMES_PER_SCENE, len(frames)))]


def members(archive: Path) -> list[str]:
    with zipfile.ZipFile(archive) as opened:
        return [name for name in opened.namelist() if "__MACOSX" not in name and not Path(name).name.startswith(".")]


def pictures_under(folder: Path) -> list[Picture]:
    """Every picture in `folder`, loose or inside one of its zips."""
    found = []
    for path in sorted(folder.rglob("*")):
        if path.suffix.lower() == ".zip":
            found += [Picture(path, name) for name in members(path) if Path(name).suffix.lower() in PICTURES]
        elif path.suffix.lower() in PICTURES and not path.name.startswith("."):
            found.append(Picture(folder, str(path.relative_to(folder))))
    return found


def read(picture: Picture) -> bytes:
    if picture.source.suffix.lower() == ".zip":
        with zipfile.ZipFile(picture.source) as opened:
            return opened.read(picture.name)
    return (picture.source / picture.name).read_bytes()


def prepare_scene(scene: Scene) -> str:
    pictures = [codes(read(picture)) for picture in [scene.clean, *scene.through]]
    sizes = {picture.shape for picture in pictures}
    if len(sizes) != 1:
        record = {"selection": SELECTION, "skipped": f"sizes {sorted(sizes)}"}
    else:
        light = torch.stack([lit(picture) for picture in pictures])
        clipped = torch.stack([shrunk((picture >= CLIPPED_CODE).any(0, keepdim=True).float()) > 0 for picture in pictures])
        write_atomic(scene.cache / f"{scene.key}.light.npy", lambda f: np.save(f, light.half().numpy()))
        write_atomic(scene.cache / f"{scene.key}.clipped.npy", lambda f: np.save(f, clipped[:, 0].numpy()))
        record = {
            "selection": SELECTION,
            "frames": len(scene.through),
            "held_out": is_held_out(scene.group),
            "size": list(light.shape[2:]),
        }
    write_atomic(scene.cache / f"{scene.key}.json", lambda f: f.write(json.dumps(record).encode()))
    return record.get("skipped", f"{len(scene.through)} frames")


def lit(coded: torch.Tensor) -> torch.Tensor:
    """(3, H, W) sRGB codes to Rec.2020 light, `EDGE` on the long side or less."""
    levels = (coded / 255).clamp(0, 1)
    untoned = 0.5 - torch.sin(torch.asin(1 - 2 * levels) / 3)
    srgb = shrunk(light_from_srgb(untoned))
    return torch.einsum("ij,jhw->ihw", torch.linalg.inv(REC2020_TO_SRGB), srgb).clamp(min=0)


def is_held_out(key: str) -> bool:
    return int(key, 16) % VALIDATION_ONE_IN == 0


def transmission(cache: Path) -> dict[str, tuple[list[float], float]]:
    """Per `<key>/<frame>`: each channel's gain from the clean frame to the scene through glass, and the
    share of the measured pixels the glass frame is darker than by `DARKER_BY` after it. A reflection
    only adds light, but RRW's frames are exposed a few percent apart, so without the gain the
    difference holds a copy of the scene. Kept beside the pairs once measured."""
    sidecar = cache / "transmission.json"
    saved = json.loads(sidecar.read_text()) if sidecar.exists() else {}
    known = saved.get("pairs", {}) if saved.get("measure") == TRANSMISSION_MEASURE else {}
    keys = [
        path.name.removesuffix(".json")
        for path in sorted(cache.glob("*.json"))
        if path.name != sidecar.name and "skipped" not in json.loads(path.read_text())
    ]
    missing = [key for key in keys if f"{key}/1" not in known]
    for done, key in enumerate(missing, 1):
        light = torch.from_numpy(np.load(cache / f"{key}.light.npy").astype(np.float32))
        clipped = torch.from_numpy(np.load(cache / f"{key}.clipped.npy"))
        clean = light[0]
        bright = clean.mean(0) > MEASURED_FROM * clean.mean(0).quantile(0.99)
        for frame in range(1, len(light)):
            measured = bright & ~(clipped[frame] | clipped[0])
            mixed = light[frame]
            gains = [modal((mixed[c] / clean[c].clamp(min=1e-6))[measured]) for c in range(3)]
            through = clean * torch.tensor(gains)[:, None, None]
            darker = mixed.mean(0)[measured] < (1 - DARKER_BY) * through.mean(0)[measured]
            known[f"{key}/{frame}"] = (gains, float(darker.float().mean()) if darker.numel() else 1.0)
        if done % 20 == 0 or done == len(missing):
            print(f"transmission: {done}/{len(missing)} scenes", flush=True)
            saved = {"measure": TRANSMISSION_MEASURE, "pairs": known}
            write_atomic(sidecar, lambda f: f.write(json.dumps(saved).encode()))
    return known


def modal(ratio: torch.Tensor) -> float:
    """The most common of `ratio`, in `GAIN_BINS` of its logarithm within `GAIN_REACH`, smoothed."""
    logs = ratio.log()
    logs = logs[logs.abs() < GAIN_REACH]
    if not logs.numel():
        return 1.0
    counts = torch.histc(logs, bins=GAIN_BINS, min=-GAIN_REACH, max=GAIN_REACH)
    counts = F.avg_pool1d(counts[None, None], 5, 1, 2)[0, 0]
    return math.exp(-GAIN_REACH + (float(counts.argmax()) + 0.5) * 2 * GAIN_REACH / GAIN_BINS)


class RealPairs(Dataset):
    """A (3, crop, crop) view of a real photograph through glass and the same view with the reflection
    blocked, scaled by `transmission`'s gains, both normalised to the photograph's white and exposed
    alike, and (1, crop, crop) where neither clipped. Pairs the glass darkens in places over `DARKER_LIMIT`
    are left out. Validation draws the same views every time."""

    def __init__(self, cache: Path, validation: bool, crop: int) -> None:
        self.cache, self.validation, self.crop = cache, validation, crop
        self.items: list[tuple[str, int]] = []
        measured = transmission(cache)
        self.gains: dict[tuple[str, int], torch.Tensor] = {}
        for record_path in sorted(cache.glob("*.json")):
            record = json.loads(record_path.read_text())
            if record.get("selection") != SELECTION or "skipped" in record or record["held_out"] != validation:
                continue
            key = record_path.name.removesuffix(".json")
            if min(record["size"]) < crop:
                continue
            for frame in range(1, record["frames"] + 1):
                gains, darker = measured[f"{key}/{frame}"]
                if darker <= DARKER_LIMIT:
                    self.items.append((key, frame))
                    self.gains[key, frame] = torch.tensor(gains)

    def __len__(self) -> int:
        return len(self.items)

    def __getitem__(self, index: int) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        rng = random.Random(index if self.validation else int(torch.randint(2**62, ())))
        key, frame = self.items[index]
        light = np.load(self.cache / f"{key}.light.npy", mmap_mode="r")
        clipped = np.load(self.cache / f"{key}.clipped.npy", mmap_mode="r")
        height, width = light.shape[2:]
        y, x = rng.randrange(height - self.crop + 1), rng.randrange(width - self.crop + 1)
        window = (slice(y, y + self.crop), slice(x, x + self.crop))
        mixed = torch.from_numpy(np.array(light[frame][:, window[0], window[1]], np.float32))
        clean = torch.from_numpy(np.array(light[0][:, window[0], window[1]], np.float32))
        clean = clean * self.gains[key, frame][:, None, None]
        kept = torch.from_numpy(~(clipped[frame][window] | clipped[0][window]))[None]
        scale = 2 ** rng.uniform(*EXPOSURE_STOPS) / white(mixed).clamp(min=1e-6)
        return mixed * scale, clean * scale, kept


if __name__ == "__main__":
    main()
