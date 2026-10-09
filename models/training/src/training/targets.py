"""What a model is trained to produce from the cached crops."""

import json
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

from training.crops import DEFAULT_CACHE, key
from training.files import write_atomic
from training.pmrid import Sharpened, pmrid

MEASUREMENTS = DEFAULT_CACHE.parent / "editor-measurements"
MEASURABLE = 0.01
MIN_MEASURABLE_SITES = 10_000
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
        """`packed`, a (CROP, CROP) chunk for each crop."""
        return record_path.with_suffix(f".{self.name}-target-crops")


def plain(crops: np.ndarray, record: dict) -> np.ndarray:
    return crops


def sharpened(crops: np.ndarray, record: dict) -> np.ndarray:
    """The crops as the editor shows the photo unedited: defringed and capture-sharpened, brought
    back to the mosaic through the camera matrix."""
    crops = crops.astype(np.float32)
    gains = np.asarray(record["gains"], np.float32)
    chain = editor_light(crops, record)
    _, height, width = crops.shape
    channel = np.tile(CHANNEL_OF_SITE, (height // 2, width // 2))
    rows, columns = np.indices((height, width))
    inverse = np.linalg.inv(chain.matrix).T
    plain_sites = (chain.plain @ inverse)[:, rows, columns, channel]
    sharpened_sites = (chain.sharpened @ inverse)[:, rows, columns, channel]
    # The demosaic and the coding scale light by a constant of the photo's, a median so that light
    # past the coding's peak can't pull it.
    unclipped = crops < 0.9 * gains[channel]
    measurable = unclipped & (crops > MEASURABLE)
    if measurable.sum() < MIN_MEASURABLE_SITES:
        raise ValueError(f"{measurable.sum()} sites bright enough to measure the chain by")
    scale = np.median(crops[measurable] / plain_sites[measurable])
    off = np.abs(crops - scale * plain_sites)
    # Clipped photosites, light past the coding's peak and colours outside Rec.2020, which the chain
    # clamps, have no faithful sharpen to carry over.
    unfaithful = ~unclipped | ((off > UNFAITHFUL_SHARE * crops + UNFAITHFUL_FLOOR) & (crops > 0))
    near = F.max_pool2d(torch.from_numpy(unfaithful).float()[:, None], 2 * SHARPEN_REACH + 1, 1, SHARPEN_REACH)
    kept = near[:, 0].numpy() == 0
    return crops + kept * scale * (sharpened_sites - plain_sites)


def editor_light(
    mosaics: np.ndarray, record: dict, amount: float | None = None, scale: int = 1, supersampled: bool = False
) -> Sharpened:
    """(N, H, W) RGGB mosaics of the photo, `scale` pixels to each of its photosites, through the rest
    of the editor's chain, plain and sharpened at `amount`, the editor's default unless given.
    `supersampled` mosaics are 2x upscales the chain takes back to (H / 2, W / 2), as Sharpen's
    Quality does."""
    gains = np.asarray(record["gains"], np.float32)
    source = Path(record["source"])
    # Mirrored, which keeps the RGGB phase, so the demosaic and the sharpen meet no edge inside a crop.
    padded = np.pad(mosaics.astype(np.float32), ((0, 0), (MIRRORED, MIRRORED), (MIRRORED, MIRRORED)), mode="reflect")
    chain = pmrid().sharpen(source, padded, gains, measured(source), amount, scale, supersampled)
    margin = MIRRORED // 2 if supersampled else MIRRORED
    inside = (slice(None), slice(margin, -margin), slice(margin, -margin))
    return Sharpened(chain.plain[inside], chain.sharpened[inside], chain.matrix, chain.sigma)


def measured(source: Path) -> dict:
    """The server's `measure` of the RAW, kept on disk: it opens the photo whole, a second or more."""
    path = MEASUREMENTS / f"{key(source)}.json"
    if path.exists():
        return json.loads(path.read_text())
    found = pmrid().measure(source)
    MEASUREMENTS.mkdir(parents=True, exist_ok=True)
    write_atomic(path, lambda f: f.write(json.dumps(found).encode()))
    return found


PLAIN = Targets("plain", plain)
SHARPENED = Targets("sharpened", sharpened)
TARGETS = {targets.name: targets for targets in (PLAIN, SHARPENED)}
