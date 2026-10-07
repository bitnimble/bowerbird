import hashlib
import json
import math
from pathlib import Path
from typing import NamedTuple

import numpy as np
import torch
import torch.nn.functional as F
from torch import nn

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
    plan = json.loads((weights / "weights.json").read_text())
    if plan["stabiliser_floor"] != STABILISER_FLOOR:
        raise SystemExit(f"{weights} was trained with a stabiliser floor of {plan['stabiliser_floor']}")
    blob = (weights / "weights.bin").read_bytes()
    floats = np.frombuffer(blob, "<f4").copy()
    if floats.size != plan["floats"]:
        raise SystemExit(f"{weights} holds {floats.size} floats where its manifest has {plan['floats']}")
    net = Upscaler(plan["channels"], plan["blocks"])
    net.load_state_dict(
        {
            t["name"]: torch.from_numpy(floats[t["offset"] : t["offset"] + math.prod(t["shape"])].reshape(t["shape"]))
            for t in plan["tensors"]
        }
    )
    return Loaded(net, plan, hashlib.sha256(blob).hexdigest())


def upscaled(net: Upscaler, mosaic: torch.Tensor) -> torch.Tensor:
    """(B, 1, H, W) RGGB mosaics to (B, 1, 2H, 2W)."""
    return unpack(unstabilise(net(stabilise(pack(mosaic)))))
