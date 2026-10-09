"""Operations on batches of conditioned RGGB mosaics, (B, 1, H, W) with H and W even."""

import math
from typing import NamedTuple

import torch
import torch.nn.functional as F

STABILISER_FLOOR = 2e-3

# Malvar, He and Cutler's 5x5 demosaic, in eighths: what each response estimates is named by
# where the missing colour sits relative to the photosite.
_MHC = (
    torch.tensor(
        [
            [[0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 8, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0]],
            [[0, 0, -1, 0, 0], [0, 0, 2, 0, 0], [-1, 2, 4, 2, -1], [0, 0, 2, 0, 0], [0, 0, -1, 0, 0]],
            [
                [0, 0, 0.5, 0, 0],
                [0, -1, 0, -1, 0],
                [-1, 4, 5, 4, -1],
                [0, -1, 0, -1, 0],
                [0, 0, 0.5, 0, 0],
            ],
            [
                [0, 0, -1, 0, 0],
                [0, -1, 4, -1, 0],
                [0.5, 0, 5, 0, 0.5],
                [0, -1, 4, -1, 0],
                [0, 0, -1, 0, 0],
            ],
            [
                [0, 0, -1.5, 0, 0],
                [0, 2, 0, 2, 0],
                [-1.5, 0, 6, 0, -1.5],
                [0, 2, 0, 2, 0],
                [0, 0, -1.5, 0, 0],
            ],
        ]
    ).unsqueeze(1)
    / 8
)
_SAME, _GREEN_AT_RB, _ON_ROW, _ON_COLUMN, _DIAGONAL = range(5)
# Per channel, which response each RGGB phase (R, Gr, Gb, B) takes.
_RESPONSE_OF_PHASE = (
    (_SAME, _ON_ROW, _ON_COLUMN, _DIAGONAL),
    (_GREEN_AT_RB, _SAME, _SAME, _GREEN_AT_RB),
    (_DIAGONAL, _ON_COLUMN, _ON_ROW, _SAME),
)


def pack(mosaic: torch.Tensor) -> torch.Tensor:
    """(B, 1, H, W) mosaic to (B, 4, H/2, W/2) planes ordered R, Gr, Gb, B."""
    return F.pixel_unshuffle(mosaic, 2)


def unpack(planes: torch.Tensor) -> torch.Tensor:
    return F.pixel_shuffle(planes, 2)


def pack_rgb(rgb: torch.Tensor) -> torch.Tensor:
    """(B, 3, H, W) to the planes of the RGGB mosaic a sensor would record of it."""
    return torch.stack(
        [rgb[:, 0, 0::2, 0::2], rgb[:, 1, 0::2, 1::2], rgb[:, 1, 1::2, 0::2], rgb[:, 2, 1::2, 1::2]],
        1,
    )


Fit = float | torch.Tensor
"""A noise fit's term: one for the whole batch, or (B,), one per mosaic."""

FIT_STABILISER = {"reference_alpha": 1e-4, "max_scale": 4.0, "min_floor": 2e-4, "max_floor": 2e-2}
"""How `fit_stabiliser` takes a noise fit to each plane's floor and scale; weights record it."""


class Stabiliser(NamedTuple):
    """Each plane's floor and scale, (1 or B, 4, 1, 1): `stabilised` takes light x to
    (sqrt(x + floor) - sqrt(floor)) * scale."""

    floors: torch.Tensor
    scales: torch.Tensor


def fit_stabiliser(gains: torch.Tensor, alpha: Fit, sigma_sq: Fit) -> Stabiliser:
    """The stabiliser under which the noise of `add_noise`'s fit has the same spread at every level and
    every ISO: each plane's variance a x + b is floored at the read noise, and scaled to the variance
    `reference_alpha` x. `gains` are (3,) or (B, 3)."""
    gains = gains.float().reshape(-1, 3)
    per_plane = gains[:, [0, 1, 1, 2]]
    green = gains[:, 1:2]
    alpha, sigma_sq = (torch.as_tensor(term, dtype=torch.float32, device=gains.device).reshape(-1, 1) for term in (alpha, sigma_sq))
    settings = FIT_STABILISER
    a = (alpha * per_plane / green).clamp(min=settings["reference_alpha"] / settings["max_scale"] ** 2)
    b = sigma_sq * per_plane**2 / green**2
    # Floored below by 3 standard deviations of read noise, so black's noise isn't clamped away.
    floors = torch.maximum(b / a, 3 * b.sqrt()).clamp(settings["min_floor"], settings["max_floor"])
    scales = (settings["reference_alpha"] / a).sqrt()
    return Stabiliser(floors.reshape(-1, 4, 1, 1), scales.reshape(-1, 4, 1, 1))


def stabilised(planes: torch.Tensor, stabiliser: Stabiliser) -> torch.Tensor:
    floors, scales = stabiliser.floors.to(planes), stabiliser.scales.to(planes)
    return (torch.sqrt(torch.clamp(planes + floors, min=0)) - floors.sqrt()) * scales


def unstabilised(stabilised_planes: torch.Tensor, stabiliser: Stabiliser) -> torch.Tensor:
    floors, scales = stabiliser.floors.to(stabilised_planes), stabiliser.scales.to(stabilised_planes)
    return (stabilised_planes / scales + floors.sqrt()).clamp(min=0) ** 2 - floors


def stabilise(light: torch.Tensor) -> torch.Tensor:
    return torch.sqrt(torch.clamp(light + STABILISER_FLOOR, min=0)) - math.sqrt(STABILISER_FLOOR)


def unstabilise(stabilised: torch.Tensor) -> torch.Tensor:
    return (stabilised + math.sqrt(STABILISER_FLOOR)).clamp(min=0) ** 2 - STABILISER_FLOOR


def bilinear(mosaic: torch.Tensor) -> torch.Tensor:
    """(B, 1, H, W) mosaics demosaiced and upscaled 2x bilinearly to (B, 3, 2H, 2W): the classical
    answer an upscale is measured against."""
    return F.interpolate(demosaic(mosaic), scale_factor=2, mode="bilinear", align_corners=False)


def demosaic(mosaic: torch.Tensor) -> torch.Tensor:
    responses = F.conv2d(F.pad(mosaic, (2, 2, 2, 2), mode="reflect"), _MHC.to(mosaic))
    phases = F.pixel_unshuffle(responses, 2).unflatten(1, (5, 4))
    channels = [
        torch.stack([phases[:, response, phase] for phase, response in enumerate(of_phase)], 1)
        for of_phase in _RESPONSE_OF_PHASE
    ]
    return F.pixel_shuffle(torch.cat(channels, 1), 2)


def add_noise(mosaic: torch.Tensor, gains: torch.Tensor, alpha: Fit, sigma_sq: Fit) -> torch.Tensor:
    """The noise of the sensor GALOSH fitted, whose green reads variance `alpha * s + sigma_sq` in
    conditioned units, added to (B, 1, H, W) mosaics conditioned with R, G, B `gains`, (3,) or
    (B, 3). Draws from the global RNG."""
    raw = raw_planes(mosaic, gains)
    noise = torch.randn_like(raw) * noise_variance(raw, gains, alpha, sigma_sq).sqrt()
    return unpack((raw + noise) * plane_gains(gains, raw))


def raw_planes(mosaic: torch.Tensor, gains: torch.Tensor) -> torch.Tensor:
    """Packed planes with the conditioning's gains divided back out."""
    planes = pack(mosaic)
    return planes / plane_gains(gains, planes)


def noise_variance(raw: torch.Tensor, gains: torch.Tensor, alpha: Fit, sigma_sq: Fit) -> torch.Tensor:
    """The fitted noise's variance at each of `raw_planes`' levels."""
    green = plane_gains(gains, raw)[:, 1:2]
    alpha, sigma_sq = (torch.as_tensor(term, dtype=raw.dtype, device=raw.device).reshape(-1, 1, 1, 1) for term in (alpha, sigma_sq))
    # A fit can read no read noise at all, which leaves black with none and a ratio over it infinite.
    return ((alpha / green) * raw.clamp(min=0) + sigma_sq / green**2).clamp(min=1e-12)


def plane_gains(gains: torch.Tensor, planes: torch.Tensor) -> torch.Tensor:
    """(3,) or (B, 3) R, G, B gains as (1 or B, 4, 1, 1), to scale `pack`'s planes by."""
    return gains.to(planes).reshape(-1, 3)[:, [0, 1, 1, 2], None, None]
