from pathlib import Path
from typing import NamedTuple

import torch
import torch.nn.functional as F
from torch import nn

from training.export import load_exported
from training.mosaic import FIT_STABILISER, Stabiliser, fit_stabiliser, pack, stabilised, unpack, unstabilised

PRELU_INITIAL_SLOPE = 0.25

GRAIN_SHARE = 0.25
"""Share of the weights' calibrated grain variance the editor adds by default: Luminance 75
(`upscale::LUMINANCE` in `native/rawshim/src/upscale.rs`)."""
SHARPEN = 0.35
"""The editor's RL sharpen amount over the upscale, `src/schemas/sharpening.ts` as a slider position.
Both chosen by eye."""


class MultiScale(nn.Module):
    """Stabilised RGGB planes (B, 4, h, w) to the planes of a mosaic twice the size, (B, 4, 2h, 2w),
    through a body at a level of plane resolution for each of `encoder_blocks`, halving from full,
    `channels` wide at full and doubling at each halving; h and w must be multiples of
    2 ** (levels - 1). `decoder_blocks` holds one count fewer, from full."""

    def __init__(self, channels: int, encoder_blocks: list[int], decoder_blocks: list[int]) -> None:
        super().__init__()
        if len(decoder_blocks) != len(encoder_blocks) - 1:
            raise ValueError(f"{len(encoder_blocks)} levels need {len(encoder_blocks) - 1} decoder counts")
        widths = [channels * 2**level for level in range(len(encoder_blocks))]
        self.encoders = nn.ModuleList(
            nn.Sequential(*stage(given, width, blocks))
            for given, width, blocks in zip([4, *widths[:-1]], widths, encoder_blocks)
        )
        self.rises = nn.ModuleList(nn.Conv2d(widths[level + 1], widths[level], 1) for level in range(len(widths) - 1))
        self.decoders = nn.ModuleList(
            nn.Sequential(*stage(width, width, blocks - 1)) for width, blocks in zip(widths, decoder_blocks)
        )
        self.out = nn.Conv2d(channels, 4 * 4, 3, padding=1)
        initialise(self, zeroed=[*self.rises, self.out])

    def forward(self, planes: torch.Tensor) -> torch.Tensor:
        levels = []
        features = planes
        for level, encoder in enumerate(self.encoders):
            features = encoder(F.avg_pool2d(features, 2) if level else features)
            levels.append(features)
        for level in reversed(range(len(self.rises))):
            risen = F.interpolate(self.rises[level](features), scale_factor=2, mode="bilinear", align_corners=False)
            features = self.decoders[level](levels[level] + risen)
        return F.pixel_shuffle(self.out(features), 2) + F.interpolate(planes, scale_factor=2, mode="nearest")


def stage(given: int, width: int, blocks: int) -> list[nn.Module]:
    """A conv from `given` channels to `width`, then `blocks` more at `width`, each under a PReLU."""
    layers: list[nn.Module] = []
    for channels in [given] + [width] * blocks:
        layers += [nn.Conv2d(channels, width, 3, padding=1), nn.PReLU(width, PRELU_INITIAL_SLOPE)]
    return layers


def initialise(net: nn.Module, zeroed: list[nn.Conv2d]) -> None:
    """Kaiming for PReLU on every conv but `zeroed`, which start at zero so the net starts as the
    nearest-neighbour residual."""
    for conv in net.modules():
        if not isinstance(conv, nn.Conv2d):
            continue
        # Torch's default init shrinks the signal about 5.6x a layer under PReLU's 0.25: past 16 layers
        # the body's output and gradient vanish and it never leaves the residual.
        nn.init.kaiming_normal_(conv.weight, a=PRELU_INITIAL_SLOPE, nonlinearity="leaky_relu")
        nn.init.zeros_(conv.bias)
    for conv in zeroed:
        nn.init.zeros_(conv.weight)


def build(plan: dict) -> MultiScale:
    return MultiScale(plan["channels"], plan["encoder_blocks"], plan["decoder_blocks"])


class Loaded(NamedTuple):
    net: MultiScale
    plan: dict
    """`weights.json` as exported, plus whatever `calibrate` added."""
    digest: str
    """SHA-256 of `weights.bin`."""


def load(weights: Path) -> Loaded:
    """The exported weights in the folder `weights`."""
    exported = load_exported(weights)
    plan = exported.plan
    if plan.get("stabiliser") != FIT_STABILISER:
        raise SystemExit(f"{weights} was trained with a stabiliser of {plan.get('stabiliser')}")
    net = build(plan)
    net.load_state_dict(exported.state)
    return Loaded(net, plan, exported.digest)


def stabiliser(gains: torch.Tensor, fit: dict | None) -> Stabiliser:
    """What the weights take a photo's planes through, from its noise `fit`."""
    if fit is None:
        raise ValueError("these weights take the photo's noise fit, and it has none")
    return fit_stabiliser(gains, fit["alpha"], fit["sigmaSq"])


def upscaled(net: MultiScale, mosaic: torch.Tensor, under: Stabiliser) -> torch.Tensor:
    """(B, 1, H, W) RGGB mosaics to (B, 1, 2H, 2W). The planes are padded on the right and bottom by
    edge replication to the net's multiple, as the device pads them."""
    planes = stabilised(pack(mosaic), under)
    height, width = planes.shape[-2:]
    multiple = 2 ** (len(net.encoders) - 1)
    padded = F.pad(planes, (0, -width % multiple, 0, -height % multiple), mode="replicate")
    return unpack(unstabilised(net(padded)[..., : 2 * height, : 2 * width], under))
