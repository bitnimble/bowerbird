import os
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
        self.layouts: dict[Path, tuple[tuple[int, ...], np.dtype, int]] = {}
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
        half = self.patch // 2
        side = self.layout(lows_path)[0][-1]
        if self.validation:
            y = x = (side - half) // 4 * 2
            variant, transpose = 0, False
        else:
            rng = np.random.default_rng()
            y, x = (int(rng.integers(0, (side - half) // 2 + 1)) * 2 for _ in range(2))
            variant, transpose = int(rng.integers(VARIANTS)), bool(rng.integers(2))
        low = self.rows(lows_path, (crop, variant, y), half)[:, x : x + half]
        high = self.rows(targets_path, (crop, 2 * y), self.patch)[:, 2 * x : 2 * x + self.patch]
        if transpose:
            low, high = low.T, high.T
        return torch.from_numpy(np.array(low, order="C"))[None], torch.from_numpy(np.array(high, order="C"))[None]

    def rows(self, path: Path, start: tuple[int, ...], count: int) -> np.ndarray:
        # 1 read a band: a memory map faults page by page, keeping each worker 1 request deep on the SSD.
        shape, dtype, offset = self.layout(path)
        first = int(np.ravel_multi_index((*start, 0), shape))
        width = shape[-1]
        fd = os.open(path, os.O_RDONLY)
        try:
            data = os.pread(fd, count * width * dtype.itemsize, offset + first * dtype.itemsize)
        finally:
            os.close(fd)
        return np.frombuffer(data, dtype).reshape(count, width)

    def layout(self, path: Path) -> tuple[tuple[int, ...], np.dtype, int]:
        if path not in self.layouts:
            array = np.load(path, mmap_mode="r")
            self.layouts[path] = (array.shape, array.dtype, array.offset)
        return self.layouts[path]
