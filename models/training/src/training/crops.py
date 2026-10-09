"""Sharp crops of a RAW library's mosaics, decoded and denoised as the editor does, cached once for
every model to train on. Each photo's GALOSH noise fit is kept beside them."""

import csv
import hashlib
import json
import os
from collections.abc import Callable, Iterator
from pathlib import Path

import numpy as np
import torch

from training import packed
from training.files import write_atomic
from training.metrics import detail
from training.mosaic import pack, stabilise
from training.pmrid import Opened, Unreadable, each_with_pmrid, pmrid

DEFAULT_CACHE = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "bowerbird" / "denoised-crops"

RAW_SUFFIXES = {
    ".3fr", ".arw", ".cr2", ".cr3", ".dcr", ".dng", ".erf", ".iiq", ".kdc", ".mos", ".nef", ".nrw",
    ".orf", ".pef", ".raf", ".rw2", ".srw",
}  # fmt: skip

CROP = 512
CAPPED_CROPS = 8
MAX_CLIPPED_SHARE = 0.1
DETAIL_CUTOFF = 0.25
"""Cycles a plane pixel: past it lies what only a 2x upscale can put there."""
DETAIL_FLOOR = 0.0018
"""Mean amplitude past `DETAIL_CUTOFF` of a crop's stabilised planes, chosen by eye: under it a crop is
flat or out of focus, with nothing for an upscale to learn from."""
SELECTION = f"amplitude past {DETAIL_CUTOFF} at least {DETAIL_FLOOR}"
VALIDATION_ONE_IN = 50


def sources(data: Path) -> list[Path]:
    """The RAW files under a folder, or those named by a CSV's `path` column."""
    if data.is_file():
        with data.open(newline="") as f:
            return [Path(row["path"]) for row in csv.DictReader(f)]
    return sorted(p for p in data.rglob("*") if p.suffix.lower() in RAW_SUFFIXES and p.is_file())


def isos(data: Path) -> dict[str, float]:
    """Each file's ISO from a `filelist` CSV; nothing for a folder."""
    if not data.is_file():
        return {}
    with data.open(newline="") as f:
        return {row["path"]: float(row["iso"]) for row in csv.DictReader(f)}


def prepare(raws: list[Path], cache: Path, workers: int, uncapped: Callable[[Path], bool]) -> None:
    """Caches each of `raws`, keeping every crop with detail of those `uncapped` admits and the
    `CAPPED_CROPS` most detailed of the rest. An uncapped photo cached by another selection is cached
    again."""
    cache.mkdir(parents=True, exist_ok=True)
    present = [p for p in raws if p.exists()]
    pending = [(p, uncapped(p)) for p in present if stale(cache / f"{key(p)}.json", uncapped(p))]
    print(f"prepare: {len(raws)} RAW files, {len(raws) - len(present)} missing, {len(pending)} to cache", flush=True)
    each_with_pmrid(prepare_one, [(p, cache, whole) for p, whole in pending], workers, cache / ".scratch", "prepare")


def stale(record_path: Path, uncapped: bool) -> bool:
    if not record_path.exists():
        return True
    return uncapped and json.loads(record_path.read_text()).get("selection") != SELECTION


def key(path: Path) -> str:
    stat = path.stat()
    return hashlib.sha1(f"{path.resolve()}:{stat.st_size}:{stat.st_mtime_ns}".encode()).hexdigest()


def prepare_one(job: tuple[Path, Path, bool]) -> str:
    path, cache, uncapped = job
    torch.set_num_threads(2)
    name = key(path)
    # Pairs made from the crops this replaces would otherwise pass for this photo's if the count matched.
    for derived in cache.glob(f"{name}.*-crops"):
        derived.unlink()
    record: dict[str, object] = {"source": str(path), "crops": 0, "selection": SELECTION}
    try:
        opened = pmrid().open(path)
    except Unreadable as error:
        record["skipped"] = str(error)
    else:
        if opened.fit is None:
            # Undenoised, so its targets would hold the noise its inputs are made without.
            record["skipped"] = "no usable noise fit"
        else:
            corners = sharp_crops(opened, None if uncapped else CAPPED_CROPS)
            if corners:
                packed.write(cache / f"{name}.crops", np.stack([opened.mosaic[y : y + CROP, x : x + CROP] for y, x in corners]))
            record.update(crops=len(corners), corners=corners, gains=opened.gains.tolist(), fit=opened.fit)
    write_atomic(cache / f"{name}.json", lambda f: f.write(json.dumps(record).encode()))
    return "skipped" if "skipped" in record else f"{record['crops']} crops"


def sharp_crops(opened: Opened, limit: int | None) -> list[tuple[int, int]]:
    """Corners of the non-overlapping crops of at least `DETAIL_FLOOR` detail, most detailed first and
    at most `limit` of them, clipped ones left out."""
    mosaic = opened.mosaic
    ceilings = np.tile(opened.gains[[[0, 1], [1, 2]]] * 0.999, (CROP // 2, CROP // 2))
    scored = []
    for y in range(0, mosaic.shape[0] - CROP + 1, CROP):
        for x in range(0, mosaic.shape[1] - CROP + 1, CROP):
            crop = mosaic[y : y + CROP, x : x + CROP]
            if (crop >= ceilings).mean() > MAX_CLIPPED_SHARE:
                continue
            planes = stabilise(pack(torch.from_numpy(np.ascontiguousarray(crop))[None, None]))
            amplitude = float(detail(planes, DETAIL_CUTOFF)) / planes.numel()
            if amplitude >= DETAIL_FLOOR:
                scored.append((amplitude, y, x))
    scored.sort(reverse=True)
    return [(y, x) for _, y, x in scored[:limit]]


def records(cache: Path, raws: list[Path], validation: bool) -> Iterator[tuple[Path, dict]]:
    """Each cached photo of `raws`, as the file is now, with crops, on its side of the validation
    split, as the path of its record and the record; `crops_of` reads its crops."""
    current = {key(p) for p in raws if p.exists()}
    for record_path in sorted(cache.glob("*.json")):
        if record_path.stem not in current:
            continue
        record = json.loads(record_path.read_text())
        held_out = int(hashlib.sha1(record["source"].encode()).hexdigest(), 16) % VALIDATION_ONE_IN == 0
        if record["crops"] and held_out == validation:
            yield record_path, record


def crops_of(record_path: Path) -> np.ndarray:
    """The cached photo's float16 (crops, CROP, CROP) crops."""
    return packed.read_all(record_path.with_suffix(".crops")).reshape(-1, CROP, CROP)
