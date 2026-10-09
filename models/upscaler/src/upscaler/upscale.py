"""Part of a RAW upscaled by trained weights beside bilinear, as PNGs to look at.

`native.png`: the photo's own mosaic upscaled and taken back to its size, as the editor's upscaler
denoiser shows it, at 2x zoom. Original, bilinear, then each of `--weights`.
`synthetic.png`: the same area made half size as in training, then upscaled back, so there is an
answer to compare with. Input, bilinear, each of `--weights`, the original, then the sharpened target.

The weights take the mosaic undenoised, as they're trained to; the input, the original and bilinear
are denoised by PMRID.

Every panel is the editor's own demosaic and coding. Bilinear is sharpened as the editor does by
default, each set of weights is grained at `GRAIN_SHARE` of its calibration and sharpened at
`SHARPEN`, and the input and the original are unsharpened."""

import argparse
from pathlib import Path

import torch
import torch.nn.functional as F

from training.metrics import psnr
from training.mosaic import bilinear, pack, pack_rgb, stabilise, unpack
from training.pmrid import serve
from training.preview import from_rec2020, panels, write_png
from training.targets import SHARPENED, editor_light, measured
from upscaler.degrade import low
from upscaler.grain import grained
from upscaler.model import GRAIN_SHARE, SHARPEN, Loaded, load, stabiliser, upscaled

MARGIN = 32
NATIVE_ZOOM = 2


def main() -> None:
    args = parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    device = torch.device("cuda")
    models = []
    for weights in args.weights:
        loaded = load(weights)
        models.append((weights, loaded.net.to(device).eval(), grain_strength(weights, loaded)))
    pmrid = serve(args.out / ".scratch")
    opened = pmrid.open(args.raw)
    mosaic = torch.from_numpy(opened.mosaic)[None, None]
    noisy_mosaic = torch.from_numpy(pmrid.open(args.raw, noisy=True).mosaic)[None, None]
    height, width = opened.mosaic.shape
    size = args.size
    if min(height, width) < size + 2 * MARGIN:
        raise SystemExit(f"{args.raw} is {width}x{height}, too small for --size {size}")
    y, x = args.at or ((height - size) // 2, (width - size) // 2)
    y, x = (min(max(v // 4 * 4, MARGIN), limit - size - MARGIN) // 4 * 4 for v, limit in ((y, height), (x, width)))
    window = (..., slice(y - MARGIN, y + size + MARGIN), slice(x - MARGIN, x + size + MARGIN))
    region, noisy_region = mosaic[window], noisy_mosaic[window]
    inside = (..., slice(MARGIN, MARGIN + size), slice(MARGIN, MARGIN + size))
    print(f"{height}x{width} mosaic, {size}x{size} at {y},{x}, ISO fit {'yes' if opened.fit else 'none'}")

    record = {"source": str(args.raw), "gains": opened.gains.tolist()}
    gains = torch.from_numpy(opened.gains)
    with torch.no_grad():
        chain = editor_light(region[:, 0].numpy(), record)
        original = from_rec2020(chain.plain)[inside]
        scale = 1 / float(original.amax(1).flatten().quantile(0.995))
        native = [original, shown(unpack(pack_rgb(bilinear(region))), record, supersampled=True)[inside]]
        for _, net, strength in models:
            high = upscaled(net, noisy_region.to(device), stabiliser(gains, opened.fit)).cpu()
            torch.manual_seed(1)
            native.append(shown(grained(high, gains, opened.fit, strength), record, SHARPEN, True)[inside])
        zoomed = [F.interpolate(image, scale_factor=NATIVE_ZOOM, mode="nearest") for image in native]
        write_png(args.out / "native.png", panels(zoomed, scale))
        print(f"wrote {args.out / 'native.png'}")
        if opened.fit is None:
            print("no synthetic view: the photo has no usable noise fit to make its input with")
            return

        torch.manual_seed(0)
        noisy = low(region, gains, opened.fit, measured(args.raw)["capture_blur"])
        small = torch.from_numpy(pmrid.denoise(noisy[:, 0].numpy(), opened.gains, opened.fit))[:, None]
        half = (..., slice(MARGIN // 2, (MARGIN + size) // 2), slice(MARGIN // 2, (MARGIN + size) // 2))
        target = stabilise(pack(torch.from_numpy(SHARPENED.make(region[0].numpy(), record))[None]))[half]
        classical = unpack(pack_rgb(bilinear(small)))
        print(f"synthetic bilinear: PSNR {psnr(F.mse_loss(stabilise(pack(classical))[half], target)):.2f} dB")
        shown_small = from_rec2020(editor_light(small[:, 0].numpy(), record).plain)[half]
        synthetic = [F.interpolate(shown_small, scale_factor=2, mode="nearest"), shown(classical, record)[inside]]
        for weights, net, strength in models:
            ours = upscaled(net, noisy.to(device), stabiliser(gains, opened.fit)).cpu()
            print(f"synthetic {weights}: PSNR {psnr(F.mse_loss(stabilise(pack(ours))[half], target)):.2f} dB")
            torch.manual_seed(1)
            synthetic.append(shown(grained(ours, gains, opened.fit, strength), record, SHARPEN)[inside])
        synthetic += [original, from_rec2020(chain.sharpened)[inside]]
        write_png(args.out / "synthetic.png", panels(synthetic, scale))
    print(f"wrote {args.out / 'synthetic.png'}")


def grain_strength(weights: Path, loaded: Loaded) -> float:
    """`grained`'s strength for these weights, from the grain calibration `calibrate` measured for them."""
    if "grain_calibration" not in loaded.plan or loaded.plan.get("grain_weights_sha256") != loaded.digest:
        raise SystemExit(f"{weights} has no grain calibration of its own: run `calibrate` on it")
    return GRAIN_SHARE * loaded.plan["grain_calibration"]


def shown(
    mosaics: torch.Tensor, record: dict, sharpen: float | None = None, supersampled: bool = False
) -> torch.Tensor:
    """(B, 1, H, W) mosaics as the editor shows them, sharpened at `sharpen`, its default unless given.
    `supersampled` mosaics are 2x upscales taken back to the photo's size, as the upscaler denoiser does."""
    return from_rec2020(editor_light(mosaics[:, 0].numpy(), record, sharpen, supersampled=supersampled).sharpened)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Upscale part of a RAW with trained weights.")
    parser.add_argument("raw", type=Path)
    parser.add_argument(
        "--weights",
        type=Path,
        nargs="+",
        default=[Path("runs/multiscale-data")],
        help="folders of weights.json and .bin",
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
