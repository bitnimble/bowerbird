"""Measures a set of weights' grain calibration on the held-out crops, and writes it into their
`weights.json` with the digest of the weights it belongs to. The grain is matched to the original's
texture where the picture is flat, as the editor renders both: anywhere else the original also
holds detail the upscale missed, which grain can't stand in for."""

import argparse
import json
import math
from collections import defaultdict
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

from training.crops import DEFAULT_CACHE, sources
from training.files import write_atomic
from training.mosaic import add_noise, pack, raw_planes, stabilise
from training.patches import PatchPairs
from training.pmrid import serve
from training.targets import PLAIN, SHARPENED
from upscaler.grain import estimate
from upscaler.model import load, upscaled
from upscaler.pairs import INPUTS

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
    pairs = PatchPairs(args.cache, sources(args.data), True, INPUTS, PLAIN)
    by_photo: dict[Path, list[int]] = defaultdict(list)
    for index, (targets_path, _, _) in enumerate(pairs.items):
        by_photo[targets_path].append(index)

    ratios, unmeasured = [], 0
    for targets_path, indices in by_photo.items():
        record = json.loads(targets_path.with_suffix(".json").read_text())
        gains, fit = torch.tensor(record["gains"]), record["fit"]
        small, original = (torch.stack(batch).float() for batch in zip(*(pairs[index] for index in indices)))
        with torch.no_grad():
            ours = upscaled(net, small.cuda()).cpu()
        torch.manual_seed(0)
        unit_grain = add_noise(ours, gains, fit["alpha"], fit["sigmaSq"])
        try:
            shown = rendered(torch.cat([original, ours, unit_grain]), record)
        except ValueError:
            unmeasured += 1
            continue
        shown_original, shown_ours, shown_grain = shown.split(len(ours))
        flat = flattest(shown_ours)
        ours_texture = texture(shown_ours, gains, flat)
        needed = (texture(shown_original, gains, flat) - ours_texture) / (texture(shown_grain, gains, flat) - ours_texture)
        ratios.append(needed / estimate(small, ours, gains, fit))
    if unmeasured:
        print(f"{unmeasured} photos too dark to render")

    calibration = float(np.median(ratios)) if ratios else math.nan
    if not math.isfinite(calibration):
        raise SystemExit(f"no calibration from {len(ratios)} held-out photos under {args.cache}")
    quartiles = np.percentile(ratios, [25, 75])
    print(f"{len(ratios)} photos: calibration {calibration:.2f}, quartiles {quartiles[0]:.2f} to {quartiles[1]:.2f}")
    plan = {**loaded.plan, "grain_calibration": calibration, "grain_weights_sha256": loaded.digest}
    write_atomic(args.weights / "weights.json", lambda f: f.write((json.dumps(plan, indent=2) + "\n").encode()))


def rendered(mosaics: torch.Tensor, record: dict) -> torch.Tensor:
    """(B, 1, H, W) mosaics of one photo as the editor renders it unedited, defringed and sharpened."""
    return torch.from_numpy(SHARPENED.make(mosaics[:, 0].numpy(), record))[:, None]


def flattest(mosaics: torch.Tensor) -> torch.Tensor:
    """Which plane sites lie in the flattest `FLAT_SHARE` of `mosaics`, by their neighbouring differences."""
    planes = stabilise(pack(mosaics))
    slope = planes.diff(dim=-1)[..., :-1, :].abs() + planes.diff(dim=-2)[..., :, :-1].abs()
    slope = F.pad(slope, (0, 1, 0, 1), mode="replicate")
    return slope <= slope.flatten().quantile(FLAT_SHARE)


def texture(mosaics: torch.Tensor, gains: torch.Tensor, where: torch.Tensor) -> float:
    """The median squared departure of each plane site from its 3 x 3 mean, over `where`."""
    planes = raw_planes(mosaics, gains)
    return float((planes - F.avg_pool2d(planes, 3, 1, 1, count_include_pad=False))[where].pow(2).median())


if __name__ == "__main__":
    main()
