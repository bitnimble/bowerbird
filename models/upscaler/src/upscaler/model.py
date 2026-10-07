import torch
import torch.nn.functional as F
from torch import nn


class Upscaler(nn.Module):
    """Stabilised RGGB planes (B, 4, h, w) to the planes of a mosaic twice the size, (B, 4, 2h, 2w)."""

    def __init__(self, channels: int, blocks: int) -> None:
        super().__init__()
        layers: list[nn.Module] = [nn.Conv2d(4, channels, 3, padding=1), nn.PReLU(channels)]
        for _ in range(blocks):
            layers += [nn.Conv2d(channels, channels, 3, padding=1), nn.PReLU(channels)]
        layers.append(nn.Conv2d(channels, 4 * 4, 3, padding=1))
        self.body = nn.Sequential(*layers)

    def forward(self, planes: torch.Tensor) -> torch.Tensor:
        return F.pixel_shuffle(self.body(planes), 2) + F.interpolate(planes, scale_factor=2, mode="nearest")
