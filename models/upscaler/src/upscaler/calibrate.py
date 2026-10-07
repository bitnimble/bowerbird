"""Measures a set of weights' grain calibration on the held-out crops, where the targets show the true
noise, and writes it into their `weights.json` with the digest of the weights it belongs to."""

import argparse
import json
import math
from collections import defaultdict
from pathlib import Path

import numpy as np
import torch

from training.crops import DEFAULT_CACHE, sources
from training.files import write_atomic
from training.patches import PatchPairs
from upscaler.grain import estimate, kept
from upscaler.model import Loaded, load, upscaled
from upscaler.pairs import INPUTS

CPU_THREADS = 2


def main() -> None:
    parser = argparse.ArgumentParser(description="Measure the grain calibration of trained weights.")
    parser.add_argument("data", type=Path, help="folder of RAW files, or a `filelist` CSV of them")
    parser.add_argument("--weights", type=Path, default=Path("runs/wide"), help="folder of weights.json and .bin")
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    args = parser.parse_args()
    torch.set_num_threads(CPU_THREADS)

    loaded = load(args.weights)
    net = loaded.net.cuda().eval()
    pairs = PatchPairs(args.cache, sources(args.data), True, INPUTS)
    by_photo: dict[Path, list[int]] = defaultdict(list)
    for index, (targets_path, _, _) in enumerate(pairs.items):
        by_photo[targets_path].append(index)

    ratios = []
    for targets_path, indices in by_photo.items():
        record = json.loads(targets_path.with_suffix(".json").read_text())
        gains = torch.tensor(record["gains"])
        small, high = (torch.stack(batch).float() for batch in zip(*(pairs[index] for index in indices)))
        with torch.no_grad():
            ours = upscaled(net, small.cuda()).cpu()
        ratios.append(kept(high, ours, gains, record["fit"]) / estimate(small, ours, gains, record["fit"]))

    calibration = float(np.median(ratios)) if ratios else math.nan
    if not math.isfinite(calibration):
        raise SystemExit(f"no calibration from {len(ratios)} held-out photos under {args.cache}")
    quartiles = np.percentile(ratios, [25, 75])
    print(f"{len(ratios)} photos: calibration {calibration:.2f}, quartiles {quartiles[0]:.2f} to {quartiles[1]:.2f}")
    plan = {**loaded.plan, "grain_calibration": calibration, "grain_weights_sha256": loaded.digest}
    write_atomic(args.weights / "weights.json", lambda f: f.write((json.dumps(plan, indent=2) + "\n").encode()))


def stored(loaded: Loaded) -> float:
    """The calibration `main` measured for exactly these weights."""
    if loaded.plan.get("grain_weights_sha256") != loaded.digest:
        raise SystemExit("these weights have no grain calibration of their own: run `calibrate` on them")
    return loaded.plan["grain_calibration"]


if __name__ == "__main__":
    main()
