"""Measures a set of weights' grain calibration on the held-out crops, and writes it into their
`weights.json` with the digest of the weights it belongs to. The grain is matched to the original's
texture where the picture is flat, as the editor shows both: anywhere else the original also holds
detail the upscale missed, which grain can't stand in for."""

import argparse
import json
import math
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

from training.crops import DEFAULT_CACHE, crops_of, records, sources
from training.files import write_atomic
from training.mosaic import add_noise, stabilise
from training.pmrid import serve
from training.targets import PLAIN, editor_light, measured
from upscaler.degrade import low
from upscaler.grain import estimate
from upscaler.model import load, stabiliser, upscaled

CPU_THREADS = 2
FLAT_SHARE = 0.25


def main() -> None:
    parser = argparse.ArgumentParser(description="Measure the grain calibration of trained weights.")
    parser.add_argument("data", type=Path, help="folder of RAW files, or a `filelist` CSV of them")
    parser.add_argument("--weights", type=Path, default=Path("runs/wide"), help="folder of weights.json and .bin")
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    args = parser.parse_args()
    torch.set_num_threads(CPU_THREADS)

    loaded = load(args.weights)
    net = loaded.net.cuda().eval()
    serve(args.cache / ".scratch")

    # Weights trained toward the editor's sharpen already carry it, so the editor shows them unsharpened.
    sharpened_by_editor = loaded.plan["targets"] == PLAIN.name
    ratios = []
    for record_path, record in records(args.cache, sources(args.data), True):
        gains, fit = torch.tensor(record["gains"]), record["fit"]
        original = torch.from_numpy(crops_of(record_path).astype(np.float32))[:, None]
        torch.manual_seed(0)
        with torch.no_grad():
            small = low(original, gains, fit, measured(Path(record["source"]))["capture_blur"])
            ours = upscaled(net, small.cuda(), stabiliser(loaded.plan, gains, fit)).cpu()
        torch.manual_seed(0)
        unit_grain = add_noise(ours, gains, fit["alpha"], fit["sigmaSq"])
        chain = editor_light(torch.cat([original, ours, unit_grain])[:, 0].numpy(), record)
        count = len(ours)
        shown_original = rgb(chain.sharpened[:count])
        shown_ours, shown_grain = rgb((chain.sharpened if sharpened_by_editor else chain.plain)[count:]).split(count)
        flat = flattest(shown_ours)
        ours_texture = texture(shown_ours, flat)
        needed = (texture(shown_original, flat) - ours_texture) / (texture(shown_grain, flat) - ours_texture)
        ratios.append(needed / estimate(small, ours, gains, fit))

    calibration = float(np.median(ratios)) if ratios else math.nan
    if not math.isfinite(calibration):
        raise SystemExit(f"no calibration from {len(ratios)} held-out photos under {args.cache}")
    quartiles = np.percentile(ratios, [25, 75])
    print(f"{len(ratios)} photos: calibration {calibration:.2f}, quartiles {quartiles[0]:.2f} to {quartiles[1]:.2f}")
    plan = {**loaded.plan, "grain_calibration": calibration, "grain_weights_sha256": loaded.digest}
    write_atomic(args.weights / "weights.json", lambda f: f.write((json.dumps(plan, indent=2) + "\n").encode()))


def rgb(light: np.ndarray) -> torch.Tensor:
    return torch.from_numpy(np.ascontiguousarray(light)).permute(0, 3, 1, 2)


def flattest(light: torch.Tensor) -> torch.Tensor:
    """Which pixels of (B, 3, H, W) light lie in its flattest `FLAT_SHARE`, by neighbouring differences."""
    level = stabilise(light.mean(1, keepdim=True))
    slope = level.diff(dim=-1)[..., :-1, :].abs() + level.diff(dim=-2)[..., :, :-1].abs()
    slope = F.pad(slope, (0, 1, 0, 1), mode="replicate")
    return (slope <= slope.flatten().quantile(FLAT_SHARE)).expand_as(light)


def texture(light: torch.Tensor, where: torch.Tensor) -> float:
    """The median squared departure of each pixel's channels from their 3 x 3 mean, over `where`."""
    return float((light - F.avg_pool2d(light, 3, 1, 1, count_include_pad=False))[where].pow(2).median())


if __name__ == "__main__":
    main()
