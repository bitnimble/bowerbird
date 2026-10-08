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


class Upscaler(nn.Module):
    """Stabilised RGGB planes (B, 4, h, w) to the planes of a mosaic twice the size, (B, 4, 2h, 2w)."""

    def __init__(self, channels: int, blocks: int) -> None:
        super().__init__()
        layers: list[nn.Module] = [nn.Conv2d(4, channels, 3, padding=1), nn.PReLU(channels, PRELU_INITIAL_SLOPE)]
        for _ in range(blocks):
            layers += [nn.Conv2d(channels, channels, 3, padding=1), nn.PReLU(channels, PRELU_INITIAL_SLOPE)]
        layers.append(nn.Conv2d(channels, 4 * 4, 3, padding=1))
        self.body = nn.Sequential(*layers)
        convs = [layer for layer in layers if isinstance(layer, nn.Conv2d)]
        # Torch's default init shrinks the signal about 5.6x a layer under PReLU's 0.25: past 16 layers
        # the body's output and gradient vanish and it never leaves the residual.
        for conv in convs[:-1]:
            nn.init.kaiming_normal_(conv.weight, a=PRELU_INITIAL_SLOPE, nonlinearity="leaky_relu")
            nn.init.zeros_(conv.bias)
        nn.init.zeros_(convs[-1].weight)
        nn.init.zeros_(convs[-1].bias)

    def forward(self, planes: torch.Tensor) -> torch.Tensor:
        return F.pixel_shuffle(self.body(planes), 2) + F.interpolate(planes, scale_factor=2, mode="nearest")


class Loaded(NamedTuple):
    net: Upscaler
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
    net = Upscaler(plan["channels"], plan["blocks"])
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


def upscaled(net: Upscaler, mosaic: torch.Tensor, under: Stabiliser) -> torch.Tensor:
    """(B, 1, H, W) RGGB mosaics to (B, 1, 2H, 2W)."""
    return unpack(unstabilised(net(stabilised(pack(mosaic), under)), under))
