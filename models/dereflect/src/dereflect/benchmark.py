"""Exported weights scored on the public through-glass benchmarks the published removers report:
Real20, SIR² Objects, Postcard and Wild, and Nature, as DSRNet's `eval_sirs.py` scores them. Each pair
is resized to a multiple of 32, and PSNR and SSIM are skimage's defaults per channel, averaged.
These sets are sRGB JPEGs and PNGs, so the photograph goes in decoded to linear Rec.2020 and
normalised to its white, as `remove` hands a RAW's decode in. Their licences allow research
only: score on them, never train on them.

    uv run python -m dereflect.benchmark <test dir> <weights dir>...

The test dir is DSRNet's data release's `reflection-removal/test`. Decoding needs `ffmpeg`.
"""

import argparse
from collections.abc import Iterator
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

from dereflect.frames import white
from dereflect.images import codes, light_from_srgb, srgb_from_light
from dereflect.model import load, removing
from training.metrics import ssim_map
from training.mosaic import stabilise
from training.preview import REC2020_TO_SRGB
from training.runtime import cuda

SETS = {
    "Real20": "real20_420",
    "Objects": "SIR2/SolidObjectDataset",
    "Postcard": "SIR2/PostcardDataset",
    "Wild": "SIR2/WildSceneDataset",
}
EXTRA = {"Nature": "Nature"}
ALIGN = 32
PEAK = 255.0


def main() -> None:
    parser = argparse.ArgumentParser(description="Score exported reflection removers on the public benchmarks.")
    parser.add_argument("test", type=Path, help="the benchmark release's test folder")
    parser.add_argument("weights", type=Path, nargs="+")
    args = parser.parse_args()
    device, bf16 = cuda()
    pairs = {name: list(read_set(args.test / folder)) for name, folder in (SETS | EXTRA).items()}
    report("left alone", {name: [score(mixed, clean) for mixed, clean in items] for name, items in pairs.items()})
    for weights in args.weights:
        net = load(weights).to(device).eval()
        scores = {
            name: [score(removed(net, mixed, device, bf16), clean) for mixed, clean in items]
            for name, items in pairs.items()
        }
        report(str(weights), scores)


def read_set(folder: Path) -> Iterator[tuple[torch.Tensor, torch.Tensor]]:
    for path in sorted((folder / "blended").iterdir()):
        mixed, clean = codes(path.read_bytes()), codes((folder / "transmission_layer" / path.name).read_bytes())
        height, width = mixed.shape[1] // ALIGN * ALIGN, mixed.shape[2] // ALIGN * ALIGN
        yield aligned(mixed, height, width), aligned(clean, height, width)


def aligned(coded: torch.Tensor, height: int, width: int) -> torch.Tensor:
    if coded.shape[1:] == (height, width):
        return coded
    resized = F.interpolate(coded[None], (height, width), mode="bicubic", antialias=True, align_corners=False)
    return resized[0].round().clamp(0, PEAK)


def removed(net: torch.nn.Module, coded: torch.Tensor, device: torch.device, bf16: bool) -> torch.Tensor:
    rgb = torch.einsum("ij,jhw->ihw", torch.linalg.inv(REC2020_TO_SRGB), light_from_srgb(coded / PEAK)).to(device)
    light = white(rgb).clamp(min=1e-6)
    image = (rgb / light)[None]
    with torch.no_grad(), torch.autocast("cuda", dtype=torch.bfloat16, enabled=bf16):
        reflection = net(stabilise(image)).float()
    out = removing(image, reflection)[0].cpu() * light.cpu()
    return srgb_from_light(torch.einsum("ij,jhw->ihw", REC2020_TO_SRGB, out).clamp(0, 1)) * PEAK


def score(made: torch.Tensor, clean: torch.Tensor) -> tuple[float, float]:
    made, clean = made.double(), clean.double()
    mse = ((made - clean) ** 2).mean((1, 2))
    return float((10 * torch.log10(PEAK**2 / mse)).mean()), float(ssim_map(made[None], clean[None], PEAK).mean())


def report(label: str, scores: dict[str, list[tuple[float, float]]]) -> None:
    def mean(items: list[tuple[float, float]]) -> str:
        psnr, ssim_ = np.mean(items, 0)
        return f"{psnr:.2f}/{ssim_:.3f}"

    pooled = [item for name in SETS for item in scores[name]]
    columns = [f"{name} {mean(items)}" for name, items in scores.items()]
    print(f"{label}: {'  '.join(columns)}  average {mean(pooled)}", flush=True)


if __name__ == "__main__":
    main()
