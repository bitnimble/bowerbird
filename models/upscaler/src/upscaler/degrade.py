import math

import torch
import torch.nn.functional as F

from training.mosaic import add_noise, demosaic, pack_rgb, unpack

BLUR_TAPS = 9
BLUR_SIGMA_MIN = 0.3
BLUR_SIGMA_MAX = 1.6


def low(mosaic: torch.Tensor, gains: torch.Tensor, fit: dict | None) -> torch.Tensor:
    """(B, 1, H, W) RGGB mosaics of one photo to what a sensor of twice the pitch would record of the
    same scenes, (B, 1, H/2, W/2), with the photo's own noise where it had a fit."""
    scene = blur(demosaic(mosaic))
    recorded = unpack(pack_rgb(F.avg_pool2d(scene, 2)))
    if fit is None:
        return recorded
    return add_noise(recorded, gains, fit["alpha"], fit["sigmaSq"])


def blur(rgb: torch.Tensor) -> torch.Tensor:
    batch, channels, height, width = rgb.shape
    kernels = gaussian_kernels(batch, rgb.device).repeat_interleave(channels, 0)
    padded = F.pad(rgb.reshape(1, batch * channels, height, width), (BLUR_TAPS // 2,) * 4, mode="reflect")
    return F.conv2d(padded, kernels.to(rgb.dtype), groups=batch * channels).reshape(rgb.shape)


def gaussian_kernels(count: int, device: torch.device) -> torch.Tensor:
    sigma_x = BLUR_SIGMA_MIN + (BLUR_SIGMA_MAX - BLUR_SIGMA_MIN) * torch.rand(count, device=device)
    sigma_y = BLUR_SIGMA_MIN + (BLUR_SIGMA_MAX - BLUR_SIGMA_MIN) * torch.rand(count, device=device)
    angle = math.pi * torch.rand(count, device=device)
    cos, sin = torch.cos(angle), torch.sin(angle)
    offsets = torch.arange(BLUR_TAPS, device=device, dtype=torch.float32) - BLUR_TAPS // 2
    y, x = torch.meshgrid(offsets, offsets, indexing="ij")
    along = cos[:, None, None] * x + sin[:, None, None] * y
    across = -sin[:, None, None] * x + cos[:, None, None] * y
    weights = torch.exp(-0.5 * ((along / sigma_x[:, None, None]) ** 2 + (across / sigma_y[:, None, None]) ** 2))
    return (weights / weights.sum((1, 2), keepdim=True)).unsqueeze(1)
