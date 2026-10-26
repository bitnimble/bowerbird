"""JPEGs and PNGs, as the public reflection sets ship, decoded by ffmpeg, and the sRGB curve both ways."""

import subprocess

import numpy as np
import torch


def codes(data: bytes) -> torch.Tensor:
    """(3, h, w) 0 to 255 sRGB codes of an encoded picture."""
    ppm = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", "-", "-f", "image2pipe", "-vcodec", "ppm", "-pix_fmt", "rgb24", "-"],
        input=data,
        check=True,
        capture_output=True,
    ).stdout
    magic, width, height = ppm.split(maxsplit=3)[:3]
    assert magic == b"P6"
    size = int(width) * int(height) * 3
    # By length: the first pixel bytes can be whitespace, which `split` would eat.
    pixels = np.frombuffer(ppm[-size:], np.uint8).reshape(int(height), int(width), 3)
    return torch.from_numpy(pixels.copy()).permute(2, 0, 1).float()


def light_from_srgb(coded: torch.Tensor) -> torch.Tensor:
    return torch.where(coded <= 0.04045, coded / 12.92, ((coded + 0.055) / 1.055) ** 2.4)


def srgb_from_light(light: torch.Tensor) -> torch.Tensor:
    # Clamped inside the power: its gradient at 0 is infinite, and NaN through the unused branch.
    return torch.where(light <= 0.0031308, 12.92 * light, 1.055 * light.clamp(min=0.0031308) ** (1 / 2.4) - 0.055)
