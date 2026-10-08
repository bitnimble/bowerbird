"""What a model is trained to produce from the cached crops."""

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

from training.pmrid import pmrid

MEASURABLE = 0.01
MIN_MEASURABLE_SITES = 10_000
MAX_SPREAD = 0.01
UNFAITHFUL_SHARE = 0.1
UNFAITHFUL_FLOOR = 2e-3
SHARPEN_REACH = 8
MIRRORED = 16
CHANNEL_OF_SITE = np.array([[0, 1], [1, 2]])


@dataclass(frozen=True)
class Targets:
    """`make` turns a photo's float16 (crops, CROP, CROP) crops and its record into targets of the same
    shape; it runs as `Inputs.make` does."""

    name: str
    """Change it whenever `make` changes: targets already made are never made again."""
    make: Callable[[np.ndarray, dict], np.ndarray]

    def path(self, record_path: Path) -> Path:
        """Raw `<f2` (crops, PLACES, PATCH, PATCH)."""
        return record_path.with_suffix(f".{self.name}-targets")


def plain(crops: np.ndarray, record: dict) -> np.ndarray:
    return crops


def sharpened(crops: np.ndarray, record: dict) -> np.ndarray:
    """The crops as the editor shows the photo unedited: defringed and capture-sharpened, brought
    back to the mosaic through the camera matrix."""
    crops = crops.astype(np.float32)
    gains = np.asarray(record["gains"], np.float32)
    # Mirrored, which keeps the RGGB phase, so the demosaic and the sharpen meet no edge inside a crop.
    padded = np.pad(crops, ((0, 0), (MIRRORED, MIRRORED), (MIRRORED, MIRRORED)), mode="reflect")
    chain = pmrid().sharpen(Path(record["source"]), padded, gains)
    _, height, width = crops.shape
    channel = np.tile(CHANNEL_OF_SITE, (height // 2, width // 2))
    rows, columns = np.indices((height, width))
    inverse = np.linalg.inv(chain.matrix).T
    plain_sites = (chain.plain @ inverse)[:, rows + MIRRORED, columns + MIRRORED, channel]
    sharpened_sites = (chain.sharpened @ inverse)[:, rows + MIRRORED, columns + MIRRORED, channel]
    # The demosaic and the coding scale light by a constant of the photo's, a median so that light
    # past the coding's peak can't pull it.
    unclipped = crops < 0.9 * gains[channel]
    measurable = unclipped & (crops > MEASURABLE)
    if measurable.sum() < MIN_MEASURABLE_SITES:
        raise ValueError(f"{measurable.sum()} sites bright enough to measure the chain by")
    ratios = crops[measurable] / plain_sites[measurable]
    scale = np.median(ratios)
    spread = np.median(np.abs(ratios / scale - 1))
    if not spread < MAX_SPREAD:
        raise ValueError(f"the chain's plain light is {spread:.1e} off the crops")
    off = np.abs(crops - scale * plain_sites)
    # Clipped photosites and light past the coding's peak have no faithful sharpen to carry over.
    unfaithful = ~unclipped | ((off > UNFAITHFUL_SHARE * crops + UNFAITHFUL_FLOOR) & (crops > 0))
    near = F.max_pool2d(torch.from_numpy(unfaithful).float()[:, None], 2 * SHARPEN_REACH + 1, 1, SHARPEN_REACH)
    kept = near[:, 0].numpy() == 0
    return crops + kept * scale * (sharpened_sites - plain_sites)


PLAIN = Targets("plain", plain)
SHARPENED = Targets("sharpened", sharpened)
TARGETS = {targets.name: targets for targets in (PLAIN, SHARPENED)}
