"""Each cached crop's low-resolution inputs: recorded by a sensor of twice the pitch, given the
photo's own noise, and denoised by PMRID as the editor would hand them to the upscaler.

Stored as 3 x 3 overlapping patches half a patch apart, each target a 128KB ZFS record: 1 disk read
a sample. A coarser grid would leave photosites the network never sees with their full context."""

import json
from pathlib import Path

import numpy as np
import torch

from training.crops import CROP, records
from training.files import write_atomic
from training.pmrid import each_with_pmrid, pmrid
from upscaler.degrade import low

VARIANTS = 2
PATCH = CROP // 2
HALF = PATCH // 2
"""Input side."""
GRID = 3
PLACES = GRID * GRID
CENTRE = PLACES // 2


def patches_of(record_path: Path) -> tuple[Path, Path]:
    """Raw `<f2` files of (crops, PLACES, PATCH, PATCH) targets and (crops, PLACES, VARIANTS,
    PATCH / 2, PATCH / 2) inputs. The inputs are written last, so they mark a finished photo."""
    return record_path.with_suffix(".upscaler-targets"), record_path.with_suffix(".upscaler-inputs")


def make_pairs(cache: Path, raws: list[Path], workers: int) -> None:
    jobs = [
        path
        for split in (False, True)
        for path, record in records(cache, raws, split)
        if not complete(path, record["crops"])
    ]
    print(f"pairs: {len(jobs)} photos without inputs", flush=True)
    for done, outcome in enumerate(each_with_pmrid(make_one, jobs, workers, cache / ".scratch"), 1):
        if done % 50 == 0 or done == len(jobs):
            print(f"pairs: {done}/{len(jobs)} ({outcome})", flush=True)


def make_one(record_path: Path) -> str:
    torch.set_num_threads(2)
    torch.manual_seed(int(record_path.stem[:8], 16))
    record = json.loads(record_path.read_text())
    targets = np.load(record_path.with_suffix(".npy"))
    gains = np.asarray(record["gains"], np.float32)
    variants = []
    for _ in range(VARIANTS):
        with torch.no_grad():
            noisy = low(torch.from_numpy(targets.astype(np.float32))[:, None], torch.from_numpy(gains), record["fit"])
        try:
            variants.append(pmrid().denoise(noisy[:, 0].numpy(), gains, record["fit"]))
        except RuntimeError as error:
            return f"failed, left for the next run: {error}"
    write_patches(record_path, targets, np.stack(variants, 1))
    return record_path.stem


def write_patches(record_path: Path, targets: np.ndarray, inputs: np.ndarray) -> None:
    """(crops, CROP, CROP) targets and their (crops, VARIANTS, CROP / 2, CROP / 2) inputs."""
    corners = range(0, CROP - PATCH + 1, (CROP - PATCH) // (GRID - 1))
    places = [(y, x) for y in corners for x in corners]
    target_patches = np.stack([targets[:, y : y + PATCH, x : x + PATCH] for y, x in places], 1)
    input_patches = np.stack([inputs[:, :, y // 2 : y // 2 + HALF, x // 2 : x // 2 + HALF] for y, x in places], 1)
    targets_path, inputs_path = patches_of(record_path)
    write_atomic(targets_path, lambda f: f.write(target_patches.astype("<f2").tobytes()))
    write_atomic(inputs_path, lambda f: f.write(input_patches.astype("<f2").tobytes()))


def complete(record_path: Path, crops: int) -> bool:
    """Whether the photo's patch files are there, at the sizes its record's crops make."""
    targets_path, inputs_path = patches_of(record_path)
    if not inputs_path.exists():
        return False
    return (
        targets_path.stat().st_size == crops * PLACES * PATCH * PATCH * 2
        and inputs_path.stat().st_size == crops * PLACES * VARIANTS * HALF * HALF * 2
    )
