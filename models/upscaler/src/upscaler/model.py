from pathlib import Path
from typing import NamedTuple

import torch
import torch.nn.functional as F
from torch import nn

from training.export import load_exported
from training.mosaic import (
    FIT_STABILISER,
    STABILISER_FLOOR,
    Stabiliser,
    fit_stabiliser,
    fixed_stabiliser,
    pack,
    stabilised,
    unpack,
    unstabilised,
)


PRELU_INITIAL_SLOPE = 0.25
MULTISCALE_ENCODER_BLOCKS = (2, 3, 4)
MULTISCALE_DECODER_BLOCKS = (2, 2)


class Upscaler(nn.Module):
    """Stabilised RGGB planes (B, 4, h, w) to the planes of a mosaic twice the size, (B, 4, 2h, 2w)."""

    def __init__(self, channels: int, blocks: int) -> None:
        super().__init__()
        self.body = nn.Sequential(*stage(4, channels, blocks), nn.Conv2d(channels, 4 * 4, 3, padding=1))
        initialise(self, zeroed=[self.body[-1]])

    def forward(self, planes: torch.Tensor) -> torch.Tensor:
        return F.pixel_shuffle(self.body(planes), 2) + F.interpolate(planes, scale_factor=2, mode="nearest")


class MultiScale(nn.Module):
    """`Upscaler`'s mapping, through a body at full, half and quarter plane resolution, `channels` wide
    at full and doubling at each halving; h and w must be multiples of 4."""

    def __init__(self, channels: int) -> None:
        super().__init__()
        widths = [channels * 2**level for level in range(len(MULTISCALE_ENCODER_BLOCKS))]
        self.encoders = nn.ModuleList(
            nn.Sequential(*stage(given, width, blocks))
            for given, width, blocks in zip([4, *widths[:-1]], widths, MULTISCALE_ENCODER_BLOCKS)
        )
        self.rises = nn.ModuleList(nn.Conv2d(widths[level + 1], widths[level], 1) for level in range(len(widths) - 1))
        self.decoders = nn.ModuleList(
            nn.Sequential(*stage(width, width, blocks - 1)) for width, blocks in zip(widths, MULTISCALE_DECODER_BLOCKS)
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


def build(plan: dict) -> nn.Module:
    if plan.get("arch") == "multiscale":
        return MultiScale(plan["channels"])
    return Upscaler(plan["channels"], plan["blocks"])


class Loaded(NamedTuple):
    net: nn.Module
    plan: dict
    """`weights.json` as exported, plus whatever `calibrate` added."""
    digest: str
    """SHA-256 of `weights.bin`."""


def load(weights: Path) -> Loaded:
    """The exported weights in the folder `weights`."""
    exported = load_exported(weights)
    plan = exported.plan
    if "stabiliser_floor" in plan and plan["stabiliser_floor"] != STABILISER_FLOOR:
        raise SystemExit(f"{weights} was trained with a stabiliser floor of {plan['stabiliser_floor']}")
    if "stabiliser" in plan and plan["stabiliser"] != FIT_STABILISER:
        raise SystemExit(f"{weights} was trained with a stabiliser of {plan['stabiliser']}")
    net = build(plan)
    net.load_state_dict(exported.state)
    return Loaded(net, plan, exported.digest)


class Look(NamedTuple):
    grain: float
    """Strength for `grain.grained`."""
    sharpen: float | None
    """The editor's sharpen over the upscale; None for its default."""


LOOKS = {"plain": (1.0, None), "sharpened": (0.25, 0.25)}
"""By the kind of target the weights trained toward, the share of their calibrated grain variance and
the sharpen they're shown with, chosen by eye."""


def look(loaded: Loaded) -> Look:
    """How these weights' upscale is shown, from the grain calibration `calibrate` measured for them."""
    if loaded.plan.get("grain_weights_sha256") != loaded.digest:
        raise SystemExit("these weights have no grain calibration of their own: run `calibrate` on them")
    share, sharpen = LOOKS[loaded.plan["targets"]]
    return Look(share * loaded.plan["grain_calibration"], sharpen)


def stabiliser(plan: dict, gains: torch.Tensor, fit: dict | None) -> Stabiliser:
    """What weights exported with `plan` take a photo's planes through, from its noise `fit`."""
    if "stabiliser_floor" in plan:
        return fixed_stabiliser(plan["stabiliser_floor"])
    if fit is None:
        raise ValueError("these weights take the photo's noise fit, and it has none")
    return fit_stabiliser(gains, fit["alpha"], fit["sigmaSq"])


def upscaled(net: nn.Module, mosaic: torch.Tensor, under: Stabiliser) -> torch.Tensor:
    """(B, 1, H, W) RGGB mosaics to (B, 1, 2H, 2W)."""
    return unpack(unstabilised(net(stabilised(pack(mosaic), under)), under))
