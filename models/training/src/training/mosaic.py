"""Operations on batches of conditioned RGGB mosaics, (B, 1, H, W) with H and W even."""

import math

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


def add_noise(mosaic: torch.Tensor, gains: torch.Tensor, alpha: float, sigma_sq: float) -> torch.Tensor:
    """The noise of the sensor GALOSH fitted, whose green reads variance `alpha * s + sigma_sq` in
    conditioned units, added to (B, 1, H, W) mosaics conditioned with R, G, B `gains`. Draws from
    the global RNG."""
    raw = raw_planes(mosaic, gains)
    noise = torch.randn_like(raw) * noise_variance(raw, gains, alpha, sigma_sq).sqrt()
    return unpack((raw + noise) * gains[[0, 1, 1, 2], None, None])


def raw_planes(mosaic: torch.Tensor, gains: torch.Tensor) -> torch.Tensor:
    """Packed planes with the conditioning's gains divided back out."""
    return pack(mosaic) / gains[[0, 1, 1, 2], None, None]


def noise_variance(raw: torch.Tensor, gains: torch.Tensor, alpha: float, sigma_sq: float) -> torch.Tensor:
    """The fitted noise's variance at each of `raw_planes`' levels."""
    green = float(gains[1])
    # A fit can read no read noise at all, which leaves black with none and a ratio over it infinite.
    return ((alpha / green) * raw.clamp(min=0) + sigma_sq / green**2).clamp(min=1e-12)
