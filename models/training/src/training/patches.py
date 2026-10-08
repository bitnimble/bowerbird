"""Training pairs as record-sized patches: each model's inputs and targets made once from the cached
crops, and both stored as 3 x 3 overlapping patches half a patch apart, each target a 128KB ZFS
record, so a training sample costs 1 disk read of its target and 1 of its input. A coarser grid
would leave photosites a network never sees with their full context.

Each kind of input and of target sits beside the crops under its own name, shared by every model
that trains on it."""

import json
import os
import zlib
from collections.abc import Callable
from dataclasses import dataclass
from functools import partial
from pathlib import Path

import numpy as np
import torch
from torch.utils.data import Dataset

from training.crops import CROP, isos, prepare, records, sources
from training.files import write_atomic
from training.pmrid import each_with_pmrid
from training.targets import Targets

PATCH = CROP // 2
"""Target side."""
GRID = 3
PLACES = GRID * GRID
CENTRE = PLACES // 2
STRIDE = (CROP - PATCH) // (GRID - 1)
HIGH_ISO = 1600


@dataclass(frozen=True)
class Inputs:
    """One model's inputs. `make` turns a photo's float16 (crops, CROP, CROP) crops and its record
    into (crops, variants, CROP / scale, CROP / scale) inputs; it runs in a worker holding a PMRID
    server, seeded by the photo and `name`, and an exception from it leaves the photo for the next
    run. It must be a module-level function, since the workers are spawned."""

    name: str
    """Change it whenever `make` changes: inputs already made are never made again."""
    variants: int
    scale: int
    make: Callable[[np.ndarray, dict], np.ndarray]

    def __post_init__(self) -> None:
        if STRIDE % (2 * self.scale):
            raise ValueError(f"patches {STRIDE} apart lose the RGGB phase at 1 / {self.scale} scale")

    @property
    def side(self) -> int:
        return PATCH // self.scale

    def path(self, record_path: Path) -> Path:
        """Raw `<f2` (crops, PLACES, variants, side, side)."""
        return record_path.with_suffix(f".{self.name}-inputs")


def datasets(
    data: Path, cache: Path, workers: int, inputs: Inputs, targets: Targets, batch: int
) -> tuple["PatchPairs", dict[str, "PatchPairs"]]:
    """The training pairs of the RAW files `data` names, cached and made first where they aren't,
    and the held-out pairs by ISO."""
    raws = sources(data)
    prepare(raws, cache, workers)
    make_pairs(cache, raws, workers, inputs, targets)
    train_set = PatchPairs(cache, raws, False, inputs, targets)
    if len(train_set) < batch:
        raise SystemExit(f"{len(train_set)} usable crops under {cache}, fewer than a batch")
    iso = isos(data)
    return train_set, {
        f"ISO under {HIGH_ISO}": PatchPairs(cache, raws, True, inputs, targets, lambda s: iso.get(s, 0) < HIGH_ISO),
        f"ISO {HIGH_ISO} and over": PatchPairs(cache, raws, True, inputs, targets, lambda s: iso.get(s, 0) >= HIGH_ISO),
    }


def make_pairs(cache: Path, raws: list[Path], workers: int, inputs: Inputs, targets: Targets) -> None:
    jobs = [
        path
        for split in (False, True)
        for path, record in records(cache, raws, split)
        if not complete(path, record["crops"], inputs, targets)
    ]
    print(f"pairs: {len(jobs)} photos without {inputs.name} inputs or {targets.name} targets", flush=True)
    each_with_pmrid(partial(make_one, inputs=inputs, targets=targets), jobs, workers, cache / ".scratch", "pairs")


def make_one(record_path: Path, inputs: Inputs, targets: Targets) -> str:
    torch.set_num_threads(2)
    record = json.loads(record_path.read_text())
    crops = np.load(record_path.with_suffix(".npy"))
    places = [(y, x) for y in range(0, CROP - PATCH + 1, STRIDE) for x in range(0, CROP - PATCH + 1, STRIDE)]
    if not complete_targets(record_path, record["crops"], targets):
        seed(record_path, targets.name)
        made = targets.make(crops, record)
        if made.shape != crops.shape:
            raise ValueError(f"{targets.name} made {made.shape} from {crops.shape}")
        target_patches = np.stack([made[:, y : y + PATCH, x : x + PATCH] for y, x in places], 1)
        write_atomic(targets.path(record_path), lambda f: f.write(target_patches.astype("<f2").tobytes()))
    if not complete_inputs(record_path, record["crops"], inputs):
        seed(record_path, inputs.name)
        made = inputs.make(crops, record)
        size = CROP // inputs.scale
        if made.shape != (len(crops), inputs.variants, size, size):
            raise ValueError(f"{inputs.name} made {made.shape} from {crops.shape}")
        side, scale = inputs.side, inputs.scale
        input_patches = np.stack([made[:, :, y // scale : y // scale + side, x // scale : x // scale + side] for y, x in places], 1)
        write_atomic(inputs.path(record_path), lambda f: f.write(input_patches.astype("<f2").tobytes()))
    return record_path.stem


def seed(record_path: Path, name: str) -> None:
    value = int(record_path.stem[:8], 16) ^ zlib.crc32(name.encode())
    torch.manual_seed(value)
    np.random.seed(value)


def complete_targets(record_path: Path, crops: int, targets: Targets) -> bool:
    path = targets.path(record_path)
    return path.exists() and path.stat().st_size == crops * PLACES * PATCH * PATCH * 2


def complete_inputs(record_path: Path, crops: int, inputs: Inputs) -> bool:
    path = inputs.path(record_path)
    return path.exists() and path.stat().st_size == crops * PLACES * inputs.variants * inputs.side**2 * 2


def complete(record_path: Path, crops: int, inputs: Inputs, targets: Targets) -> bool:
    return complete_inputs(record_path, crops, inputs) and complete_targets(record_path, crops, targets)


class PatchPairs(Dataset):
    """(1, side, side) inputs and their (1, PATCH, PATCH) targets. Validation takes each crop's centre
    patch and its first input, so it is the same every time.

    Never flipped: restoring RGGB after a flip needs an odd shift on each side, and an odd shift of
    an input at half scale is an even shift of its target, so the pair would no longer line up."""

    def __init__(
        self,
        cache: Path,
        raws: list[Path],
        validation: bool,
        inputs: Inputs,
        targets: Targets,
        keep: Callable[[str], bool] = lambda _: True,
    ) -> None:
        self.validation = validation
        self.inputs = inputs
        self.items = [
            (targets.path(path), inputs.path(path), crop)
            for path, record in records(cache, raws, validation)
            if keep(record["source"]) and complete(path, record["crops"], inputs, targets)
            for crop in range(record["crops"])
        ]

    def __len__(self) -> int:
        return len(self.items)

    def __getitem__(self, index: int) -> tuple[torch.Tensor, torch.Tensor]:
        targets_path, inputs_path, crop = self.items[index]
        variants, side = self.inputs.variants, self.inputs.side
        if self.validation:
            place, variant, transpose = CENTRE, 0, False
        else:
            place, variant, transpose = (int(torch.randint(n, ())) for n in (PLACES, variants, 2))
        patch = crop * PLACES + place
        target = read(targets_path, patch * PATCH * PATCH, PATCH * PATCH).reshape(PATCH, PATCH)
        given = read(inputs_path, (patch * variants + variant) * side * side, side * side).reshape(side, side)
        if transpose:
            given, target = given.T, target.T
        return torch.from_numpy(np.array(given, order="C"))[None], torch.from_numpy(np.array(target, order="C"))[None]


def read(path: Path, first: int, count: int) -> np.ndarray:
    fd = os.open(path, os.O_RDONLY)
    try:
        data = os.pread(fd, count * 2, first * 2)
    finally:
        os.close(fd)
    return np.frombuffer(data, "<f2")
