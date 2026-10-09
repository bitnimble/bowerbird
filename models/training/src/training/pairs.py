"""Training pairs as whole crops: each model's inputs and targets made once from the cached crops and
stored crop after crop, so a sample costs 1 disk read of its target and 1 of its input. A sample is
a whole crop because a network sees each photosite with its full context only away from a sample's
edges.

Each kind of input and of target sits beside the crops under its own name, shared by every model
that trains on it."""

import json
import os
import random
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

HIGH_ISO = 1600
CLEAN_ISO = 400


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

    @property
    def side(self) -> int:
        return CROP // self.scale

    def path(self, record_path: Path) -> Path:
        """Raw `<f2` (crops, variants, side, side)."""
        return record_path.with_suffix(f".{self.name}-input-crops")


def datasets(
    data: Path, cache: Path, workers: int, inputs: Inputs, targets: Targets, batch: int
) -> tuple["CropPairs", dict[str, "CropPairs"]]:
    """The training pairs of the RAW files `data` names, cached and made first where they aren't,
    and the held-out pairs.

    Targets are every detailed crop of the photos at `CLEAN_ISO` or under, whose texture no denoise
    has taken, each given the noise of a photo drawn from every ISO. Held out: those photos with the
    noise of photos under and over `HIGH_ISO`, and the photos over it with their own noise, whose
    targets are denoised."""
    raws = sources(data)
    iso = isos(data)

    def clean(source: str) -> bool:
        return iso.get(source, 0) <= CLEAN_ISO

    def high(source: str) -> bool:
        return iso.get(source, 0) >= HIGH_ISO

    prepare(raws, cache, workers, lambda raw: clean(str(raw)))
    make_pairs(cache, raws, workers, inputs, targets, lambda source, held_out: clean(source) or (held_out and high(source)))

    low_noises = noise_fits(cache, raws, lambda s: not high(s))
    high_noises = noise_fits(cache, raws, high)
    if not low_noises or not high_noises:
        raise SystemExit(f"{len(low_noises)} photos under ISO {HIGH_ISO} and {len(high_noises)} over it to draw noise from")
    train_set = CropPairs(cache, raws, False, inputs, targets, clean, low_noises + high_noises)
    if len(train_set) < batch:
        raise SystemExit(f"{len(train_set)} usable crops under {cache}, fewer than a batch")
    return train_set, {
        f"ISO under {HIGH_ISO}": CropPairs(cache, raws, True, inputs, targets, clean, low_noises),
        f"ISO {HIGH_ISO} and over": CropPairs(cache, raws, True, inputs, targets, clean, high_noises),
        f"real ISO {HIGH_ISO} and over": CropPairs(cache, raws, True, inputs, targets, high),
    }


def noise_fits(cache: Path, raws: list[Path], keep: Callable[[str], bool]) -> list[tuple[float, float]]:
    """The `alpha` and `sigmaSq` of each cached photo `keep` admits, on both sides of the split."""
    return [
        (record["fit"]["alpha"], record["fit"]["sigmaSq"])
        for split in (False, True)
        for _, record in records(cache, raws, split)
        if keep(record["source"])
    ]


def make_pairs(
    cache: Path, raws: list[Path], workers: int, inputs: Inputs, targets: Targets, used: Callable[[str, bool], bool]
) -> None:
    """Makes pairs for the cached photos `used` admits, by source and whether it's held out."""
    held = [
        (path, record)
        for held_out in (False, True)
        for path, record in records(cache, raws, held_out)
        if used(record["source"], held_out)
    ]
    without_targets = [path for path, record in held if not complete_targets(path, record["crops"], targets)]
    print(f"pairs: {len(without_targets)} photos without {targets.name} targets", flush=True)
    each_with_pmrid(partial(make_targets, targets=targets), without_targets, workers, cache / ".scratch", "targets")
    without_inputs = [
        path
        for path, record in held
        if complete_targets(path, record["crops"], targets) and not complete_inputs(path, record["crops"], inputs)
    ]
    print(f"pairs: {len(without_inputs)} photos without {inputs.name} inputs", flush=True)
    # One worker: inputs may be made on the GPU, and each worker's CUDA context costs gigabytes of host memory.
    each_with_pmrid(partial(make_inputs, inputs=inputs), without_inputs, 1, cache / ".scratch", "inputs")


def make_targets(record_path: Path, targets: Targets) -> str:
    torch.set_num_threads(2)
    record = json.loads(record_path.read_text())
    crops = np.load(record_path.with_suffix(".npy"))
    seed(record_path, targets.name)
    made = targets.make(crops, record)
    if made.shape != crops.shape:
        raise ValueError(f"{targets.name} made {made.shape} from {crops.shape}")
    write_atomic(targets.path(record_path), lambda f: f.write(made.astype("<f2").tobytes()))
    return record_path.stem


def make_inputs(record_path: Path, inputs: Inputs) -> str:
    record = json.loads(record_path.read_text())
    crops = np.load(record_path.with_suffix(".npy"))
    seed(record_path, inputs.name)
    made = inputs.make(crops, record)
    if made.shape != (len(crops), inputs.variants, inputs.side, inputs.side):
        raise ValueError(f"{inputs.name} made {made.shape} from {crops.shape}")
    write_atomic(inputs.path(record_path), lambda f: f.write(made.astype("<f2").tobytes()))
    return record_path.stem


def seed(record_path: Path, name: str) -> None:
    value = int(record_path.stem[:8], 16) ^ zlib.crc32(name.encode())
    torch.manual_seed(value)
    np.random.seed(value)


def complete_targets(record_path: Path, crops: int, targets: Targets) -> bool:
    path = targets.path(record_path)
    return path.exists() and path.stat().st_size == crops * CROP * CROP * 2


def complete_inputs(record_path: Path, crops: int, inputs: Inputs) -> bool:
    path = inputs.path(record_path)
    return path.exists() and path.stat().st_size == crops * inputs.variants * inputs.side**2 * 2


def complete(record_path: Path, crops: int, inputs: Inputs, targets: Targets) -> bool:
    return complete_inputs(record_path, crops, inputs) and complete_targets(record_path, crops, targets)


class CropPairs(Dataset):
    """(1, side, side) inputs, their (1, CROP, CROP) targets, and the photo's `sensor`, its noise
    drawn from `noises` where given. Validation takes each crop's first input and the same draw, so
    it is the same every time.

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
        noises: list[tuple[float, float]] | None = None,
    ) -> None:
        self.validation = validation
        self.inputs = inputs
        self.noises = noises
        self.items = [
            (targets.path(path), inputs.path(path), crop, sensor(record))
            for path, record in records(cache, raws, validation)
            if keep(record["source"]) and complete(path, record["crops"], inputs, targets)
            for crop in range(record["crops"])
        ]

    def __len__(self) -> int:
        return len(self.items)

    def __getitem__(self, index: int) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        targets_path, inputs_path, crop, of_sensor = self.items[index]
        variants, side = self.inputs.variants, self.inputs.side
        if self.validation:
            variant, transpose = 0, False
        else:
            variant, transpose = (int(torch.randint(n, ())) for n in (variants, 2))
        target = read(targets_path, crop * CROP * CROP, CROP * CROP).reshape(CROP, CROP)
        given = read(inputs_path, (crop * variants + variant) * side * side, side * side).reshape(side, side)
        if transpose:
            given, target = given.T, target.T
        if self.noises is not None:
            drawn = random.Random(index).randrange(len(self.noises)) if self.validation else int(torch.randint(len(self.noises), ()))
            of_sensor = (*of_sensor[:3], *self.noises[drawn])
        return (
            torch.from_numpy(np.array(given, order="C"))[None],
            torch.from_numpy(np.array(target, order="C"))[None],
            torch.tensor(of_sensor),
        )


def sensor(record: dict) -> tuple[float, ...]:
    """R, G, B gains, then the noise fit's `alpha` and `sigmaSq`."""
    return (*record["gains"], record["fit"]["alpha"], record["fit"]["sigmaSq"])


def read(path: Path, first: int, count: int) -> np.ndarray:
    fd = os.open(path, os.O_RDONLY)
    try:
        data = os.pread(fd, count * 2, first * 2)
    finally:
        os.close(fd)
    return np.frombuffer(data, "<f2")
