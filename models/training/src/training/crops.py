"""Sharp crops of a RAW library's mosaics, decoded and denoised as the editor does, cached once for
every model to train on. Each photo's GALOSH noise fit is kept beside them."""

import csv
import hashlib
import json
import os
from collections.abc import Iterator
from pathlib import Path

import numpy as np

from training.files import write_atomic
from training.pmrid import Opened, Unreadable, each_with_pmrid, pmrid

DEFAULT_CACHE = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "bowerbird" / "denoised-crops"

RAW_SUFFIXES = {
    ".3fr", ".arw", ".cr2", ".cr3", ".dcr", ".dng", ".erf", ".iiq", ".kdc", ".mos", ".nef", ".nrw",
    ".orf", ".pef", ".raf", ".rw2", ".srw",
}  # fmt: skip

CROP = 512
CROPS_PER_PHOTO = 8
MAX_CLIPPED_SHARE = 0.1
MIN_DETAIL_SHARE = 0.5
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


def prepare(raws: list[Path], cache: Path, workers: int) -> None:
    cache.mkdir(parents=True, exist_ok=True)
    pending = [p for p in raws if not (cache / f"{key(p)}.json").exists()]
    print(f"prepare: {len(raws)} RAW files, {len(pending)} not yet cached", flush=True)
    outcomes = each_with_pmrid(prepare_one, [(p, cache) for p in pending], workers, cache / ".scratch")
    for done, outcome in enumerate(outcomes, 1):
        if done % 50 == 0 or done == len(pending):
            print(f"prepare: {done}/{len(pending)} ({outcome})", flush=True)


def key(path: Path) -> str:
    stat = path.stat()
    return hashlib.sha1(f"{path.resolve()}:{stat.st_size}:{stat.st_mtime_ns}".encode()).hexdigest()


def prepare_one(job: tuple[Path, Path]) -> str:
    path, cache = job
    name = key(path)
    record: dict[str, object] = {"source": str(path), "crops": 0}
    try:
        try:
            opened = pmrid().open(path)
        except RuntimeError:
            # Usually the GPU out of memory while other workers held large frames.
            opened = pmrid().open(path)
    except Unreadable as error:
        record["skipped"] = str(error)
    else:
        corners = sharp_crops(opened)
        if corners:
            crops = np.stack([opened.mosaic[y : y + CROP, x : x + CROP] for y, x in corners])
            write_atomic(cache / f"{name}.npy", lambda f: np.save(f, crops.astype(np.float16)))
        record.update(crops=len(corners), corners=corners, gains=opened.gains.tolist(), fit=opened.fit)
    write_atomic(cache / f"{name}.json", lambda f: f.write(json.dumps(record).encode()))
    return "skipped" if "skipped" in record else f"{record['crops']} crops"


def sharp_crops(opened: Opened) -> list[tuple[int, int]]:
    """Corners of the non-overlapping crops with the most detail, clipped ones left out."""
    mosaic = opened.mosaic
    ceilings = np.tile(opened.gains[[[0, 1], [1, 2]]] * 0.999, (CROP // 2, CROP // 2))
    green = np.sqrt(np.clip(0.5 * (mosaic[0::2, 1::2] + mosaic[1::2, 0::2]), 0, None))
    # Detail at a quarter of the mosaic's resolution, where photosite noise has mostly averaged out.
    quarter = green[: green.shape[0] // 2 * 2, : green.shape[1] // 2 * 2]
    quarter = quarter.reshape(quarter.shape[0] // 2, 2, quarter.shape[1] // 2, 2).mean((1, 3))
    laplacian = np.abs(
        4 * quarter[1:-1, 1:-1] - quarter[:-2, 1:-1] - quarter[2:, 1:-1] - quarter[1:-1, :-2] - quarter[1:-1, 2:]
    )
    side = CROP // 4
    scored = []
    for y in range(0, mosaic.shape[0] - CROP + 1, CROP):
        for x in range(0, mosaic.shape[1] - CROP + 1, CROP):
            if (mosaic[y : y + CROP, x : x + CROP] >= ceilings).mean() > MAX_CLIPPED_SHARE:
                continue
            detail = laplacian[y // 4 : y // 4 + side - 2, x // 4 : x // 4 + side - 2].mean()
            scored.append((float(detail), y, x))
    if not scored:
        return []
    scored.sort(reverse=True)
    floor = scored[0][0] * MIN_DETAIL_SHARE
    return [(y, x) for detail, y, x in scored[:CROPS_PER_PHOTO] if detail >= floor]


def records(cache: Path, raws: list[Path], validation: bool) -> Iterator[tuple[Path, dict]]:
    """Each cached photo of `raws` with crops, on its side of the validation split, as the path of
    its record and the record. Its crops are the record's path with `.npy` for a suffix."""
    wanted = {str(p) for p in raws}
    for record_path in sorted(cache.glob("*.json")):
        record = json.loads(record_path.read_text())
        source = record["source"]
        held_out = int(hashlib.sha1(source.encode()).hexdigest(), 16) % VALIDATION_ONE_IN == 0
        if record["crops"] and held_out == validation and source in wanted:
            yield record_path, record
