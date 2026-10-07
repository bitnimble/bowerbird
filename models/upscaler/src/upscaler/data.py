from collections.abc import Callable
from pathlib import Path

import numpy as np
import torch
from torch.utils.data import Dataset

from training.crops import records
from upscaler.pairs import VARIANTS, lows_of


class Pairs(Dataset):
    """Validation takes each crop's centre and its first input, so it is the same every time.

    Never flipped: restoring RGGB after a flip needs an odd shift on each side, and an odd shift of
    the input is an even shift of the target, so the pair would no longer line up."""

    def __init__(
        self,
        cache: Path,
        raws: list[Path],
        validation: bool,
        patch: int,
        keep: Callable[[str], bool] = lambda _: True,
    ) -> None:
        self.patch = patch
        self.validation = validation
        self.opened: dict[Path, np.ndarray] = {}
        self.items = [
            (path.with_suffix(".npy"), lows_of(path), crop)
            for path, record in records(cache, raws, validation)
            if keep(record["source"]) and lows_of(path).exists()
            for crop in range(record["crops"])
        ]

    def __len__(self) -> int:
        return len(self.items)

    def __getitem__(self, index: int) -> tuple[torch.Tensor, torch.Tensor]:
        targets_path, lows_path, crop = self.items[index]
        targets, lows = self.mapped(targets_path)[crop], self.mapped(lows_path)[crop]
        half = self.patch // 2
        if self.validation:
            y = x = (lows.shape[-1] - half) // 4 * 2
            variant, transpose = 0, False
        else:
            rng = np.random.default_rng()
            y, x = (int(rng.integers(0, (lows.shape[-1] - half) // 2 + 1)) * 2 for _ in range(2))
            variant, transpose = int(rng.integers(VARIANTS)), bool(rng.integers(2))
        low = lows[variant, y : y + half, x : x + half]
        high = targets[2 * y : 2 * y + self.patch, 2 * x : 2 * x + self.patch]
        if transpose:
            low, high = low.T, high.T
        return torch.from_numpy(np.array(low, order="C"))[None], torch.from_numpy(np.array(high, order="C"))[None]

    def mapped(self, path: Path) -> np.ndarray:
        if path not in self.opened:
            self.opened[path] = np.load(path, mmap_mode="r")
        return self.opened[path]
