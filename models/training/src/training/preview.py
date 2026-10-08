"""Side-by-side PNGs of a model's results, to look at rather than to ship: sRGB, 8 bits, SDR."""

import struct
import zlib
from pathlib import Path

import numpy as np
import torch

GAP = 8
REC2020_TO_SRGB = torch.tensor(
    [[1.6605, -0.5876, -0.0728], [-0.1246, 1.1329, -0.0083], [-0.0182, -0.1006, 1.1187]]
)


def from_rec2020(light: np.ndarray) -> torch.Tensor:
    """(N, H, W, 3) Rec.2020 light, as `targets.editor_light` gives it, as (N, 3, H, W) linear sRGB."""
    return (torch.from_numpy(np.ascontiguousarray(light)) @ REC2020_TO_SRGB.T).permute(0, 3, 1, 2)


def panels(images: list[torch.Tensor], scale: float) -> np.ndarray:
    """(1, 3, H, W) linear RGB images of one height, times `scale`, side by side with a white gap."""
    rows = [srgb(image[0] * scale) for image in images]
    gap = np.full((rows[0].shape[0], GAP, 3), 255, np.uint8)
    return np.concatenate([part for row in rows for part in (row, gap)][:-1], 1)


def srgb(rgb: torch.Tensor) -> np.ndarray:
    light = rgb.clamp(0, 1).permute(1, 2, 0).numpy()
    coded = np.where(light <= 0.0031308, 12.92 * light, 1.055 * light ** (1 / 2.4) - 0.055)
    return np.round(coded * 255).astype(np.uint8)


def write_png(path: Path, rgb: np.ndarray) -> None:
    height, width, _ = rgb.shape

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    rows = b"".join(b"\0" + rgb[row].tobytes() for row in range(height))
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")
    )
