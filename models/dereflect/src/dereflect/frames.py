"""Whole frames of a RAW library for the reflection remover to composite: each RAW as the library
decodes it unedited for a rendition `EDGE` on its long edge, Rec.2020 light averaged down to `EDGE`,
cached once."""

import json
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

from training import packed
from training.crops import DATASETS, held_out, key
from training.files import write_atomic
from training.mosaic import stabilise
from training.pmrid import Decoded, Unreadable, each_with_pmrid, pmrid

DEFAULT_FRAMES = DATASETS / "dereflect-frames"
EDGE = 1024
WHITE_QUANTILE = 0.99
"""Of each pixel's mean channel: the light a frame is normalised to 1 by, for training and use alike."""
WINDOW = 256
SHARP_QUANTILE = 0.98
SELECTION = f"library decode, edge {EDGE}, white {WHITE_QUANTILE}, sharpness {SHARP_QUANTILE} of {WINDOW}"
VIVID_QUANTILE = 0.99
VIVID_POOL = 8
VIVID_MEASURE = f"{SELECTION}; spread quantile {VIVID_QUANTILE} over {VIVID_POOL} pixels"


def prepare(raws: list[Path], cache: Path, workers: int) -> None:
    cache.mkdir(parents=True, exist_ok=True)
    present = [p for p in raws if p.exists()]
    pending = [(p, cache) for p in present if stale(cache / f"{key(p)}.json", SELECTION)]
    print(f"frames: {len(raws)} RAW files, {len(raws) - len(present)} missing, {len(pending)} to cache", flush=True)
    each_with_pmrid(prepare_one, pending, workers, cache / ".scratch", "frames")
    unexposed = [(p, cache) for p in present if lacks_exposure(cache / f"{key(p)}.json")]
    each_with_pmrid(expose_one, unexposed, workers, cache / ".scratch", "exposures")


def stale(record_path: Path, selection: str) -> bool:
    return not record_path.exists() or json.loads(record_path.read_text()).get("selection") != selection


def lacks_exposure(record_path: Path) -> bool:
    record = json.loads(record_path.read_text()) if record_path.exists() else {}
    return "white" in record and "exposure" not in record


def expose_one(job: tuple[Path, Path]) -> str:
    path, cache = job
    record_path = cache / f"{key(path)}.json"
    record = json.loads(record_path.read_text())
    record["exposure"] = pmrid().header(path)
    write_atomic(record_path, lambda f: f.write(json.dumps(record).encode()))
    return "known" if radiance(record) is not None else "unknown"


def radiance(record: dict) -> float | None:
    """The light the frame's white stood for in the world, in units shared by every frame: its white
    over what the camera gathered, the sensitivity and exposure time over the f-number squared. None
    where the camera recorded no exposure."""
    iso, shutter, aperture = (record["exposure"][name] for name in ("iso", "shutter", "aperture"))
    if min(iso, shutter, aperture) <= 0:
        return None
    return record["white"] * aperture**2 / (iso * shutter)


def prepare_one(job: tuple[Path, Path]) -> str:
    path, cache = job
    torch.set_num_threads(2)
    name = key(path)
    record: dict[str, object] = {"source": str(path), "selection": SELECTION}
    try:
        decoded = pmrid().decode(path, EDGE)
    except Unreadable as error:
        record["skipped"] = str(error)
    else:
        rgb = shrunk(planar(decoded))
        light = float(white(rgb))
        if light <= 0:
            record["skipped"] = "black"
        elif min(rgb.shape[1:]) < WINDOW:
            record["skipped"] = "too small"
        else:
            packed.write(cache / f"{name}.frame", rgb.numpy()[None])
            record.update(
                height=rgb.shape[1],
                width=rgb.shape[2],
                ceilings=decoded.ceilings.tolist(),
                matrix=decoded.matrix.tolist(),
                white=light,
                sharpest=sharpest(rgb / light),
                exposure=pmrid().header(path),
            )
    write_atomic(cache / f"{name}.json", lambda f: f.write(json.dumps(record).encode()))
    return str(record["skipped"]) if "skipped" in record else f"{record['width']}x{record['height']}"


def planar(decoded: Decoded) -> torch.Tensor:
    return torch.from_numpy(np.ascontiguousarray(decoded.rgb.transpose(2, 0, 1), np.float32))


def shrunk(planes: torch.Tensor) -> torch.Tensor:
    """(C, H, W) `planes`, `EDGE` on the long side or less."""
    height, width = planes.shape[1:]
    shrink = max(1.0, max(height, width) / EDGE)
    size = (round(height / shrink), round(width / shrink))
    return F.interpolate(planes[None], size=size, mode="area")[0]


def white(rgb: torch.Tensor) -> torch.Tensor:
    return rgb.mean(-3).flatten(-2).quantile(WHITE_QUANTILE, dim=-1)


def detail(image: torch.Tensor) -> torch.Tensor:
    """(3, h, w) light normalised to its white, to (1, h, w): how far each pixel's coded brightness
    stands from its 3 x 3 neighbourhood's."""
    luma = stabilise(image.mean(0, keepdim=True))
    return (luma - F.avg_pool2d(luma, 3, 1, 1, count_include_pad=False)).abs()


def sharpness(image: torch.Tensor) -> float:
    return float(detail(image).flatten().quantile(SHARP_QUANTILE))


def sharpest(image: torch.Tensor) -> float:
    windows = F.unfold(detail(image)[None], WINDOW, stride=WINDOW // 2)[0]
    return float(windows.quantile(SHARP_QUANTILE, dim=0).max())


def records(cache: Path, raws: list[Path], validation: bool) -> list[tuple[Path, dict]]:
    """Each cached frame of `raws` current for `SELECTION`, on its side of the validation split."""
    found = []
    for raw in raws:
        if not raw.exists():
            continue
        record_path = cache / f"{key(raw)}.json"
        if not record_path.exists():
            continue
        record = json.loads(record_path.read_text())
        if not stale(record_path, SELECTION) and "skipped" not in record and held_out(record["source"]) == validation:
            found.append((record_path, record))
    return found


def colourfulness(items: list[tuple[Path, dict]]) -> list[float]:
    """Each cached frame's `VIVID_QUANTILE` of the spread between its brightest and darkest channel, in
    light normalised to its white and averaged over `VIVID_POOL` pixels square: high where something
    bright is strongly coloured. Kept beside the frames once measured."""
    if not items:
        return []
    sidecar = items[0][0].parent / "colourfulness.json"
    saved = json.loads(sidecar.read_text()) if sidecar.exists() else {}
    known = saved.get("scores", {}) if saved.get("measure") == VIVID_MEASURE else {}
    missing = [(path, record) for path, record in items if path.stem not in known]
    for done, (path, record) in enumerate(missing, 1):
        light = torch.from_numpy(frame_of(path, record).astype(np.float32))
        # Averaged first: a dark frame's chroma noise, scaled up to its white, would outscore real colour.
        rgb = F.avg_pool2d(light[None] / record["white"], VIVID_POOL)[0]
        known[path.stem] = float((rgb.amax(0) - rgb.amin(0)).flatten().quantile(VIVID_QUANTILE))
        if done % 1000 == 0 or done == len(missing):
            print(f"colourfulness: {done}/{len(missing)}", flush=True)
            saved = {"measure": VIVID_MEASURE, "scores": known}
            write_atomic(sidecar, lambda f: f.write(json.dumps(saved).encode()))
    return [known[path.stem] for path, _ in items]


def frame_of(record_path: Path, record: dict) -> np.ndarray:
    """The cached frame, (3, h, w)."""
    return packed.read(record_path.with_suffix(".frame"), 0).reshape(3, record["height"], record["width"])


def centred(frame: np.ndarray, record: dict, side: int) -> torch.Tensor:
    """The cached `frame`'s centre square, where a photograph puts its subject, shrunk to `side` and
    normalised to its white."""
    height, width = frame.shape[1:]
    short = min(height, width)
    y, x = (height - short) // 2, (width - short) // 2
    square = torch.from_numpy(np.ascontiguousarray(frame[:, y : y + short, x : x + short], np.float32))
    return F.interpolate(square[None], size=(side, side), mode="area")[0] / record["white"]
