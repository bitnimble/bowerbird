import os
from collections.abc import Callable
from pathlib import Path

import numpy as np
import torch
from torch.utils.data import Dataset

from training.crops import records
from upscaler.pairs import CENTRE, PATCH, PLACES, VARIANTS, patches_of

HALF = PATCH // 2


class Pairs(Dataset):
    """Validation takes each crop's centre patch and its first input, so it is the same every time.

    Never flipped: restoring RGGB after a flip needs an odd shift on each side, and an odd shift of
    the input is an even shift of the target, so the pair would no longer line up."""

    def __init__(
        self,
        cache: Path,
        raws: list[Path],
        validation: bool,
        keep: Callable[[str], bool] = lambda _: True,
    ) -> None:
        self.validation = validation
        self.items = [
            (*patches_of(path), crop)
            for path, record in records(cache, raws, validation)
            if keep(record["source"]) and patches_of(path)[1].exists()
            for crop in range(record["crops"])
        ]

    def __len__(self) -> int:
        return len(self.items)

    def __getitem__(self, index: int) -> tuple[torch.Tensor, torch.Tensor]:
        targets_path, inputs_path, crop = self.items[index]
        if self.validation:
            place, variant, transpose = CENTRE, 0, False
        else:
            rng = np.random.default_rng()
            place, variant, transpose = int(rng.integers(PLACES)), int(rng.integers(VARIANTS)), bool(rng.integers(2))
        patch = crop * PLACES + place
        high = read(targets_path, patch * PATCH * PATCH, PATCH * PATCH).reshape(PATCH, PATCH)
        low = read(inputs_path, (patch * VARIANTS + variant) * HALF * HALF, HALF * HALF).reshape(HALF, HALF)
        if transpose:
            low, high = low.T, high.T
        return torch.from_numpy(np.array(low, order="C"))[None], torch.from_numpy(np.array(high, order="C"))[None]


def read(path: Path, first: int, count: int) -> np.ndarray:
    fd = os.open(path, os.O_RDONLY)
    try:
        data = os.pread(fd, count * 2, first * 2)
    finally:
        os.close(fd)
    return np.frombuffer(data, "<f2")
