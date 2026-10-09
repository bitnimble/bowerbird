"""Grain put back over an upscale: the network averages away noise and texture it can't predict, so its
output is cleaner than the photo it came from. The grain follows the photo's own noise fit, at the
strength of the noise its input holds times the weights' calibration, which makes up for the noise
the network carries through and the texture it smooths."""

import torch
import torch.nn.functional as F

from training.mosaic import add_noise, demosaic, noise_variance, pack_rgb, plane_gains, raw_planes, unpack

CHI_SQUARED_1_MEDIAN = 0.455
SITES_PER_QUAD = 4


def grained(
    small: torch.Tensor,
    high: torch.Tensor,
    gains: torch.Tensor,
    fit: dict | None,
    calibration: float,
    luma_only: bool = False,
) -> torch.Tensor:
    """`high`, the upscale of `small`, with grain added. `calibration` is the weights' own, from
    `calibrate`. `luma_only` grain changes each pixel's brightness and keeps its colour. Draws from the
    global RNG."""
    if fit is None:
        return high
    strength = calibration * estimate(small, high, gains, fit)
    if luma_only:
        return add_luma_noise(high, gains, strength * fit["alpha"], strength * fit["sigmaSq"])
    return add_noise(high, gains, strength * fit["alpha"], strength * fit["sigmaSq"])


def add_luma_noise(mosaic: torch.Tensor, gains: torch.Tensor, alpha: float, sigma_sq: float) -> torch.Tensor:
    """`add_noise`'s grain as one factor over each RGGB quad, which scales the quad's light without
    changing its colour, its quad means as spread as `add_noise`'s."""
    raw = raw_planes(mosaic, gains)
    level = raw.mean(1, keepdim=True).clamp(min=1e-6)
    spread = (noise_variance(raw, gains, alpha, sigma_sq).mean(1, keepdim=True) / SITES_PER_QUAD).sqrt()
    factor = 1 + torch.randn_like(level) * spread / level
    return unpack(raw * factor * plane_gains(gains, raw))


def estimate(small: torch.Tensor, high: torch.Tensor, gains: torch.Tensor, fit: dict) -> float:
    """The share of the fit's noise `small` holds over `high` brought back to its size. Biased low,
    since the upscale carries some of the noise through."""
    return kept(small, unpack(pack_rgb(F.avg_pool2d(demosaic(high), 2))), gains, fit)


def kept(noisy: torch.Tensor, clean: torch.Tensor, gains: torch.Tensor, fit: dict) -> float:
    """The share of the fit's noise variance `noisy` holds over `clean`, robust to edges."""
    level = raw_planes(clean, gains)
    variance = noise_variance(level, gains, fit["alpha"], fit["sigmaSq"])
    residual = raw_planes(noisy, gains) - level
    return float((residual**2 / variance).median()) / CHI_SQUARED_1_MEDIAN
