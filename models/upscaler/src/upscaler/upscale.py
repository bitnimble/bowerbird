"""Part of a RAW upscaled by trained weights beside bilinear, as PNGs to look at.

`native.png`: the photo's own mosaic at 2x, as the editor would use it. Original, bilinear, model.
`synthetic.png`: the same area made half size as in training, then upscaled back, so there is an
answer to compare with. Input, bilinear, model, original.

Colours are white-balanced camera RGB with no colour matrix: good for judging detail, not colour."""

import argparse
import json
import math
import struct
import zlib
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

from training.mosaic import STABILISER_FLOOR, demosaic, pack, pack_rgb, stabilise, unpack
from training.pmrid import Pmrid
from upscaler.degrade import low
from upscaler.model import Upscaler

MARGIN = 32
GAP = 8


def main() -> None:
    args = parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    device = torch.device("cuda")
    net = load(args.weights).to(device).eval()
    pmrid = Pmrid(args.out / ".scratch")
    opened = pmrid.open(args.raw)
    mosaic = torch.from_numpy(opened.mosaic)[None, None]
    height, width = opened.mosaic.shape
    size = args.size
    y, x = args.at or ((height - size) // 2, (width - size) // 2)
    y, x = (min(max(v // 4 * 4, MARGIN), limit - size - MARGIN) // 4 * 4 for v, limit in ((y, height), (x, width)))
    region = mosaic[..., y - MARGIN : y + size + MARGIN, x - MARGIN : x + size + MARGIN]
    inside = (..., slice(MARGIN, MARGIN + size), slice(MARGIN, MARGIN + size))
    print(f"{height}x{width} mosaic, {size}x{size} at {y},{x}, ISO fit {'yes' if opened.fit else 'none'}")

    with torch.no_grad():
        original = demosaic(region)[inside]
        scale = 1 / float(original.amax(1).flatten().quantile(0.995))
        doubled = (..., slice(2 * MARGIN, 2 * (MARGIN + size)), slice(2 * MARGIN, 2 * (MARGIN + size)))
        native = [
            F.interpolate(original, scale_factor=2, mode="nearest"),
            F.interpolate(demosaic(region), scale_factor=2, mode="bilinear", align_corners=False)[doubled],
            demosaic(upscaled(net, region.to(device)).cpu())[doubled],
        ]
        write_png(args.out / "native.png", panels(native, scale))

        torch.manual_seed(0)
        noisy = low(region, torch.from_numpy(opened.gains), opened.fit)
        small = torch.from_numpy(pmrid.denoise(noisy[:, 0].numpy(), opened.gains, opened.fit))[:, None]
        half = (..., slice(MARGIN // 2, (MARGIN + size) // 2), slice(MARGIN // 2, (MARGIN + size) // 2))
        bilinear = F.interpolate(demosaic(small), scale_factor=2, mode="bilinear", align_corners=False)
        ours = upscaled(net, small.to(device)).cpu()
        target = stabilise(pack(region))[half]
        for name, guess in (("bilinear", stabilise(pack_rgb(bilinear))), ("model", stabilise(pack(ours)))):
            error = F.mse_loss(guess[half], target)
            print(f"synthetic {name}: PSNR {float(-10 * torch.log10(error)):.2f} dB")
        synthetic = [
            F.interpolate(demosaic(small)[half], scale_factor=2, mode="nearest"),
            bilinear[inside],
            demosaic(ours)[inside],
            original,
        ]
        write_png(args.out / "synthetic.png", panels(synthetic, scale))
    print(f"wrote {args.out / 'native.png'} and {args.out / 'synthetic.png'}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Upscale part of a RAW with trained weights.")
    parser.add_argument("raw", type=Path)
    parser.add_argument("--weights", type=Path, default=Path("runs/wide"), help="folder of weights.json and .bin")
    parser.add_argument("--out", type=Path, default=Path("runs/upscaled"))
    parser.add_argument("--at", type=lambda s: tuple(int(v) for v in s.split(",")), help="top,left in the mosaic")
    parser.add_argument("--size", type=int, default=256, help="mosaic side to upscale, divisible by 4")
    args = parser.parse_args()
    if args.size % 4:
        parser.error("--size must be divisible by 4")
    return args


def load(weights: Path) -> Upscaler:
    plan = json.loads((weights / "weights.json").read_text())
    if plan["stabiliser_floor"] != STABILISER_FLOOR:
        raise SystemExit(f"{weights} was trained with a stabiliser floor of {plan['stabiliser_floor']}")
    floats = np.fromfile(weights / "weights.bin", "<f4")
    net = Upscaler(plan["channels"], plan["blocks"])
    net.load_state_dict(
        {
            t["name"]: torch.from_numpy(floats[t["offset"] : t["offset"] + math.prod(t["shape"])].reshape(t["shape"]))
            for t in plan["tensors"]
        }
    )
    return net


def upscaled(net: Upscaler, mosaic: torch.Tensor) -> torch.Tensor:
    root = math.sqrt(STABILISER_FLOOR)
    return unpack((net(stabilise(pack(mosaic))) + root) ** 2 - STABILISER_FLOOR)


def panels(images: list[torch.Tensor], scale: float) -> np.ndarray:
    rows = [srgb(image[0] * scale) for image in images]
    gap = np.full((rows[0].shape[0], GAP, 3), 255, np.uint8)
    return np.concatenate([part for row in rows for part in (row, gap)][:-1], 1)


def srgb(rgb: torch.Tensor) -> np.ndarray:
    light = rgb.clamp(0, 1).permute(1, 2, 0).numpy()
    coded = np.where(light <= 0.0031308, 12.92 * light, 1.055 * light ** (1 / 2.4) - 0.055)
    return np.round(coded * 255).astype(np.uint8)


def write_png(path: Path, rgb: np.ndarray) -> None:
    height, width, _ = rgb.shape

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    rows = b"".join(b"\0" + rgb[row].tobytes() for row in range(height))
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")
    )


if __name__ == "__main__":
    main()
