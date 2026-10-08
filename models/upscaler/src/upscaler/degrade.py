import math

import torch
import torch.nn.functional as F

from training.mosaic import add_noise, demosaic, pack_rgb, unpack

TYPICAL_CAPTURE_BLUR = 0.88
BLUR_JITTER = 0.2
MIN_ADDED_BLUR = 0.3


def low(mosaic: torch.Tensor, gains: torch.Tensor, fit: dict, capture_blur: float | None) -> torch.Tensor:
    """`recorded`, with the photo's own noise."""
    return add_noise(recorded(mosaic, capture_blur), gains, fit["alpha"], fit["sigmaSq"])


def recorded(mosaic: torch.Tensor, capture_blur: float | None) -> torch.Tensor:
    """(B, 1, H, W) RGGB mosaics of one photo to what a noiseless sensor of twice the pitch would
    record of the same scenes, (B, 1, H/2, W/2), with, in its own pixels, the photo's `capture_blur`
    (sigma in sensor pixels, as the editor measures it; None for a typical lens)."""
    scene = blur(demosaic(mosaic), added_blur(capture_blur))
    return unpack(pack_rgb(F.avg_pool2d(scene, 2)))


def added_blur(capture_blur: float | None) -> float:
    capture = TYPICAL_CAPTURE_BLUR if capture_blur is None else capture_blur
    # The same blur spans twice as many of these pixels, 4 capture^2, of which the photo already holds
    # capture^2 and the 2 x 2 pooling adds a quarter.
    return math.sqrt(max(3 * capture**2 - 0.25, MIN_ADDED_BLUR**2))


def blur(rgb: torch.Tensor, sigma: float) -> torch.Tensor:
    batch, channels, height, width = rgb.shape
    reach = math.ceil(3 * sigma * (1 + BLUR_JITTER))
    kernels = gaussian_kernels(batch, sigma, reach, rgb.device).repeat_interleave(channels, 0)
    padded = F.pad(rgb.reshape(1, batch * channels, height, width), (reach,) * 4, mode="reflect")
    return F.conv2d(padded, kernels.to(rgb.dtype), groups=batch * channels).reshape(rgb.shape)


def gaussian_kernels(count: int, sigma: float, reach: int, device: torch.device) -> torch.Tensor:
    """`count` (1, 2 reach + 1, 2 reach + 1) kernels, each axis's sigma within `BLUR_JITTER` of `sigma`
    and turned at random."""
    sigma_x, sigma_y = (sigma * (1 + BLUR_JITTER * (2 * torch.rand(count, device=device) - 1)) for _ in range(2))
    angle = math.pi * torch.rand(count, device=device)
    cos, sin = torch.cos(angle), torch.sin(angle)
    offsets = torch.arange(-reach, reach + 1, device=device, dtype=torch.float32)
    y, x = torch.meshgrid(offsets, offsets, indexing="ij")
    along = cos[:, None, None] * x + sin[:, None, None] * y
    across = -sin[:, None, None] * x + cos[:, None, None] * y
    weights = torch.exp(-0.5 * ((along / sigma_x[:, None, None]) ** 2 + (across / sigma_y[:, None, None]) ** 2))
    return (weights / weights.sum((1, 2), keepdim=True)).unsqueeze(1)
