"""Part of a RAW upscaled by trained weights beside bilinear, as PNGs to look at.

`native.png`: the photo's own mosaic at 2x, as the editor would use it. Original, bilinear, then each
of `--weights` with grain.
`synthetic.png`: the same area made half size as in training, then upscaled back, so there is an
answer to compare with. Input, bilinear, each of `--weights` with grain, the original, then the
original as each other kind of target the weights were trained on shows it.

Colours are white-balanced camera RGB with no colour matrix: good for judging detail, not colour."""

import argparse
from pathlib import Path

import torch
import torch.nn.functional as F

from training.metrics import psnr
from training.mosaic import bilinear, demosaic, pack, pack_rgb, stabilise
from training.pmrid import serve
from training.preview import panels, write_png
from training.targets import TARGETS
from upscaler.degrade import low
from upscaler.grain import grained
from upscaler.model import load, stored, upscaled

MARGIN = 32


def main() -> None:
    args = parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    device = torch.device("cuda")
    models = []
    for weights in args.weights:
        loaded = load(weights)
        models.append((weights, loaded.net.to(device).eval(), stored(loaded), loaded.plan["targets"]))
    pmrid = serve(args.out / ".scratch")
    opened = pmrid.open(args.raw)
    mosaic = torch.from_numpy(opened.mosaic)[None, None]
    height, width = opened.mosaic.shape
    size = args.size
    if min(height, width) < size + 2 * MARGIN:
        raise SystemExit(f"{args.raw} is {width}x{height}, too small for --size {size}")
    y, x = args.at or ((height - size) // 2, (width - size) // 2)
    y, x = (min(max(v // 4 * 4, MARGIN), limit - size - MARGIN) // 4 * 4 for v, limit in ((y, height), (x, width)))
    region = mosaic[..., y - MARGIN : y + size + MARGIN, x - MARGIN : x + size + MARGIN]
    inside = (..., slice(MARGIN, MARGIN + size), slice(MARGIN, MARGIN + size))
    print(f"{height}x{width} mosaic, {size}x{size} at {y},{x}, ISO fit {'yes' if opened.fit else 'none'}")

    with torch.no_grad():
        original = demosaic(region)[inside]
        scale = 1 / float(original.amax(1).flatten().quantile(0.995))
        doubled = (..., slice(2 * MARGIN, 2 * (MARGIN + size)), slice(2 * MARGIN, 2 * (MARGIN + size)))
        gains = torch.from_numpy(opened.gains)
        native = [F.interpolate(original, scale_factor=2, mode="nearest"), bilinear(region)[doubled]]
        for _, net, calibration, _ in models:
            torch.manual_seed(1)
            high = upscaled(net, region.to(device)).cpu()
            native.append(demosaic(grained(region, high, gains, opened.fit, calibration))[doubled])
        write_png(args.out / "native.png", panels(native, scale))
        print(f"wrote {args.out / 'native.png'}")
        if opened.fit is None:
            print("no synthetic view: the photo has no usable noise fit to make its input with")
            return

        torch.manual_seed(0)
        noisy = low(region, gains, opened.fit)
        small = torch.from_numpy(pmrid.denoise(noisy[:, 0].numpy(), opened.gains, opened.fit))[:, None]
        half = (..., slice(MARGIN // 2, (MARGIN + size) // 2), slice(MARGIN // 2, (MARGIN + size) // 2))
        record = {"source": str(args.raw), "gains": opened.gains.tolist()}
        kinds = ["plain"] + sorted({kind for *_, kind in models} - {"plain"})
        originals = {kind: torch.from_numpy(TARGETS[kind].make(region[0].numpy(), record))[None] for kind in kinds}
        targets = {kind: stabilise(pack(original))[half] for kind, original in originals.items()}
        classical = bilinear(small)
        for kind, target in targets.items():
            print(f"synthetic bilinear against {kind}: PSNR {psnr(F.mse_loss(stabilise(pack_rgb(classical))[half], target)):.2f} dB")
        synthetic = [F.interpolate(demosaic(small)[half], scale_factor=2, mode="nearest"), classical[inside]]
        for weights, net, calibration, kind in models:
            ours = upscaled(net, small.to(device)).cpu()
            print(f"synthetic {weights} against {kind}: PSNR {psnr(F.mse_loss(stabilise(pack(ours))[half], targets[kind])):.2f} dB")
            torch.manual_seed(1)
            synthetic.append(demosaic(grained(small, ours, gains, opened.fit, calibration))[inside])
        synthetic += [demosaic(original)[inside] for original in originals.values()]
        write_png(args.out / "synthetic.png", panels(synthetic, scale))
    print(f"wrote {args.out / 'synthetic.png'}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Upscale part of a RAW with trained weights.")
    parser.add_argument("raw", type=Path)
    parser.add_argument(
        "--weights", type=Path, nargs="+", default=[Path("runs/wide")], help="folders of weights.json and .bin"
    )
    parser.add_argument("--out", type=Path, default=Path("runs/upscaled"))
    parser.add_argument("--at", type=corner, help="top,left in the mosaic")
    parser.add_argument("--size", type=int, default=256, help="mosaic side to upscale, divisible by 4")
    args = parser.parse_args()
    if args.size % 4:
        parser.error("--size must be divisible by 4")
    return args


def corner(text: str) -> tuple[int, int]:
    top, left = (int(v) for v in text.split(","))
    return top, left


if __name__ == "__main__":
    main()
