from pathlib import Path
from typing import NamedTuple

import torch
import torch.nn.functional as F
from torch import nn

from training.export import load_exported
from training.mosaic import STABILISER_FLOOR, pack, stabilise, unpack, unstabilise


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
    if plan["stabiliser_floor"] != STABILISER_FLOOR:
        raise SystemExit(f"{weights} was trained with a stabiliser floor of {plan['stabiliser_floor']}")
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


def upscaled(net: Upscaler, mosaic: torch.Tensor) -> torch.Tensor:
    """(B, 1, H, W) RGGB mosaics to (B, 1, 2H, 2W)."""
    return unpack(unstabilise(net(stabilise(pack(mosaic)))))
