"""Grain put back over an upscale: the network averages away noise it can't predict, so its output is
cleaner than the photo it came from. The grain follows the photo's own noise fit, as strong as the
noise its input still holds after the editor's denoise."""

import torch
import torch.nn.functional as F

from training.mosaic import add_noise, demosaic, pack, pack_rgb, unpack

# Held-out photos' true strength over the estimate: median 2.5, quartiles 1.9 to 3.8, flat across ISO.
CALIBRATION = 2.5


def grained(small: torch.Tensor, high: torch.Tensor, gains: torch.Tensor, fit: dict | None) -> torch.Tensor:
    """`high`, the upscale of `small`, with grain added. Draws from the global RNG."""
    if fit is None:
        return high
    back = unpack(pack_rgb(F.avg_pool2d(demosaic(high), 2)))
    strength = CALIBRATION * kept(small, back, gains, fit)
    return add_noise(high, gains, strength * fit["alpha"], strength * fit["sigmaSq"])


def kept(noisy: torch.Tensor, clean: torch.Tensor, gains: torch.Tensor, fit: dict) -> float:
    """How much of the sensor's noise variance `noisy` holds over `clean`, robust to edges."""
    planes = gains[[0, 1, 1, 2], None, None]
    level = (pack(clean) / planes).clamp(min=0)
    variance = (fit["alpha"] / float(gains[1])) * level + fit["sigmaSq"] / float(gains[1]) ** 2
    residual = pack(noisy - clean) / planes
    # Median of a chi-squared variable with 1 degree of freedom: turns the median ratio into a mean.
    return float((residual**2 / variance).median()) / 0.455
