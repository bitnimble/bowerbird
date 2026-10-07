"""Measures a set of weights' grain calibration on the held-out crops, where the targets show the true
noise, and writes it into their `weights.json` as `grain_calibration`. Rerun after every training."""

import argparse
import json
from collections import defaultdict
from pathlib import Path

import numpy as np
import torch

from training.crops import DEFAULT_CACHE, sources
from training.files import write_atomic
from upscaler.data import Pairs
from upscaler.grain import estimate, kept
from upscaler.upscale import load, upscaled


def main() -> None:
    parser = argparse.ArgumentParser(description="Measure the grain calibration of trained weights.")
    parser.add_argument("data", type=Path, help="folder of RAW files, or a `filelist` CSV of them")
    parser.add_argument("--weights", type=Path, default=Path("runs/wide"), help="folder of weights.json and .bin")
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    args = parser.parse_args()

    net, _ = load(args.weights)
    net = net.cuda().eval()
    pairs = Pairs(args.cache, sources(args.data), validation=True)
    by_photo: dict[Path, list[int]] = defaultdict(list)
    for index, (targets_path, _, _) in enumerate(pairs.items):
        by_photo[targets_path].append(index)

    ratios = []
    for targets_path, indices in by_photo.items():
        record = json.loads(targets_path.with_suffix(".json").read_text())
        if record["fit"] is None:
            continue
        gains = torch.tensor(record["gains"])
        truths, guesses = [], []
        for index in indices:
            small, high = (t[None].float() for t in pairs[index])
            with torch.no_grad():
                ours = upscaled(net, small.cuda()).cpu()
            truths.append(kept(high, ours, gains, record["fit"]))
            guesses.append(estimate(small, ours, gains, record["fit"]))
        ratios.append(np.median(truths) / np.median(guesses))

    calibration = float(np.median(ratios))
    quartiles = np.percentile(ratios, [25, 75])
    print(f"{len(ratios)} photos: calibration {calibration:.2f}, quartiles {quartiles[0]:.2f} to {quartiles[1]:.2f}")
    manifest = args.weights / "weights.json"
    plan = json.loads(manifest.read_text())
    plan["grain_calibration"] = calibration
    write_atomic(manifest, lambda f: f.write((json.dumps(plan, indent=2) + "\n").encode()))


if __name__ == "__main__":
    main()
