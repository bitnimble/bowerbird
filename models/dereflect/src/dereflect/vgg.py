"""VGG19 (Simonyan and Zisserman, 2015) as a perceptual loss: how far apart two pictures are in what
its ImageNet-trained convolutions respond to, which an L1 between pixels misses on texture. The
weights are torchvision's port of the released ones, published under CC BY 4.0; training reads
them, nothing ships them."""

from pathlib import Path

import torch
import torch.nn.functional as F
from torch import nn

from dereflect.dino import MEAN, STD
from dereflect.images import srgb_from_light
from training.crops import DEFAULT_CACHE
from training.files import fetched
from training.preview import REC2020_TO_SRGB

SOURCE = "https://download.pytorch.org/models/vgg19-dcbb9e9d.pth"
HASH = "dcbb9e9dad569fff7a846263a77324fc34978fea2bfb039c012d710e1776ae44"
CHANNELS = [64, 64, "pool", 128, 128, "pool", 256, 256, 256, 256, "pool", 512, 512, 512, 512, "pool", 512]
TAPS = {1: 1 / 2.6, 6: 1 / 4.8, 11: 1 / 3.7, 20: 1 / 5.6, 29: 10 / 1.5}
"""Index in torchvision's `features` of the ReLU after conv1_1, conv2_1, conv3_1, conv4_1 and
conv5_1, with ERRNet's weights for them (Wei et al., CVPR 2019)."""


class Perceptual(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        layers: list[nn.Module] = []
        channels = 3
        for width in CHANNELS:
            if width == "pool":
                layers.append(nn.MaxPool2d(2))
                continue
            layers += [nn.Conv2d(channels, int(width), 3, padding=1), nn.ReLU()]
            channels = int(width)
        self.features = nn.Sequential(*layers[: max(TAPS) + 1])
        self.register_buffer("mean", torch.tensor(MEAN)[:, None, None], persistent=False)
        self.register_buffer("std", torch.tensor(STD)[:, None, None], persistent=False)
        self.register_buffer("to_srgb", REC2020_TO_SRGB, persistent=False)

    def forward(self, made: torch.Tensor, wanted: torch.Tensor) -> torch.Tensor:
        """Weighted L1 between the responses to two (B, 3, H, W) linear Rec.2020 pictures, each shown
        as an SDR display would show it, since that is what the network learned from."""
        with torch.no_grad():
            theirs = self.responses(wanted)
        return sum(TAPS[index] * F.l1_loss(ours, theirs[index]) for index, ours in self.responses(made).items())

    def responses(self, light: torch.Tensor) -> dict[int, torch.Tensor]:
        x = self.shown(light).contiguous(memory_format=torch.channels_last)
        tapped = {}
        for index, layer in enumerate(self.features):
            x = layer(x)
            if index in TAPS:
                tapped[index] = x
        return tapped

    def shown(self, light: torch.Tensor) -> torch.Tensor:
        with torch.autocast(light.device.type, enabled=False):
            srgb = torch.einsum("ij,bjhw->bihw", self.to_srgb, light.float()).clamp(0, 1)
        return (srgb_from_light(srgb) - self.mean) / self.std


def load() -> Perceptual:
    """The released weights, fetched once into the cache and checked against their pinned hash, frozen."""
    path = fetched(SOURCE, DEFAULT_CACHE.parent / "vgg" / Path(SOURCE).name, HASH)
    net = Perceptual()
    released = torch.load(path, map_location="cpu", weights_only=True)
    kept = {
        name: value
        for name, value in released.items()
        if name.startswith("features.") and int(name.split(".")[1]) < len(net.features)
    }
    net.load_state_dict(kept)
    return net.eval().requires_grad_(False)
