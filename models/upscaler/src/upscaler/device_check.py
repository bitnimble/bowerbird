"""Every arm of the device upscaler (`native/rawshim/src/upscale.rs`) held against torch on one cached
crop: natively through `examples/upscale_bench.rs`, whole and in tiles small enough to cross, and in
Chromium through `scripts/upscale-bench-browser.ts`.

    uv run python -m upscaler.device_check <record stem> <crop> [weights dir]
"""

import argparse
import json
import os
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import torch

from training.crops import DEFAULT_CACHE, crops_of
from training.metrics import psnr
from training.mosaic import stabilise
from training.pmrid import REPOSITORY
from upscaler.model import load, stabiliser, upscaled

BENCH = REPOSITORY / "native" / "rawshim" / "target" / "quick" / "examples" / "upscale_bench"
SMALL_TILE = 96


def main() -> None:
    parser = argparse.ArgumentParser(description="Hold the device upscaler's arms against torch.")
    parser.add_argument("stem", help="a record under the crop cache")
    parser.add_argument("crop", type=int)
    parser.add_argument("weights", type=Path, nargs="?", default=Path("runs/sharp-edges"))
    args = parser.parse_args()
    weights = args.weights.resolve()
    crop = crops_of(DEFAULT_CACHE / f"{args.stem}.json")[args.crop].astype(np.float32)
    record = json.loads((DEFAULT_CACHE / f"{args.stem}.json").read_text())
    height, width = crop.shape
    loaded = load(weights)
    under = stabiliser(loaded.plan, torch.tensor(record["gains"]), record["fit"])
    with torch.no_grad():
        reference = upscaled(loaded.net.eval(), torch.from_numpy(crop)[None, None], under)[0, 0]
    print(f"{width}x{height} crop, light {float(reference.min()):.4f} to {float(reference.max()):.4f}")

    with tempfile.TemporaryDirectory() as scratch:
        given = Path(scratch) / "in.f32"
        given.write_bytes(crop.astype("<f4").tobytes())
        sensor = [",".join(map(str, record["gains"])), f"{record['fit']['alpha']},{record['fit']['sigmaSq']}"]
        native = [str(BENCH), str(weights), "check", str(given), str(width), str(height), *sensor]
        # `gpu::leave` exits through `_exit` only under cargo's environment; without it NVIDIA faults at exit.
        environment = {**os.environ, "CARGO_MANIFEST_DIR": str(REPOSITORY / "native" / "rawshim")}
        for tile in (None, SMALL_TILE):
            folder = Path(scratch) / f"tile-{tile or 'whole'}"
            folder.mkdir()
            subprocess.run(
                native + [str(folder)] + ([str(tile)] if tile else []), check=True, capture_output=True, env=environment
            )
        browser = ["bun", "run", "scripts/upscale-bench-browser.ts", str(weights), "check", str(given)]
        subprocess.run(
            browser + [str(width), str(height), *sensor, str(Path(scratch) / "tile-whole")],
            check=True,
            capture_output=True,
            cwd=REPOSITORY,
        )
        for answer in sorted(Path(scratch).glob("tile-*/*.f32")):
            got = torch.from_numpy(np.fromfile(answer, "<f4").reshape(reference.shape))
            error = got - reference
            stabilised = stabilise(got) - stabilise(reference)
            print(
                f"{answer.parent.name} {answer.stem}: max |error| {float(error.abs().max()):.2e}, "
                f"PSNR {psnr(error.pow(2).mean()):.1f} dB, stabilised {psnr(stabilised.pow(2).mean()):.1f} dB"
            )


if __name__ == "__main__":
    main()
