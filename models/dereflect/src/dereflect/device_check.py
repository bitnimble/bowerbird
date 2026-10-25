"""The device's network (`native/rawshim/examples/dereflect.rs`, `slang/lightrr.slang`) held against
torch on one cached frame.

    uv run python -m dereflect.device_check <record stem> [weights dir] [--cache dir]
"""

import argparse
import json
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import torch

from dereflect.frames import DEFAULT_FRAMES, frame_of
from dereflect.model import MULTIPLE, load
from training.metrics import psnr
from training.mosaic import stabilise
from training.pmrid import REPOSITORY, example_environment

EXAMPLE = REPOSITORY / "native" / "rawshim" / "target" / "quick" / "examples" / "dereflect"
BUILD = "bun run scripts/cargo.ts build --profile quick --manifest-path native/rawshim/Cargo.toml --example dereflect"
AGREEMENT_DB = 80.0


def main() -> None:
    if not EXAMPLE.exists():
        raise SystemExit(f"{EXAMPLE} is missing; build it from {REPOSITORY} with `{BUILD}`")
    parser = argparse.ArgumentParser(description="Hold the device's reflection remover against torch.")
    parser.add_argument("stem", help="a record under the frame cache")
    parser.add_argument("weights", type=Path, nargs="?", default=Path("runs/dereflect"))
    parser.add_argument("--cache", type=Path, default=DEFAULT_FRAMES)
    args = parser.parse_args()
    record_path = args.cache / f"{args.stem}.json"
    record = json.loads(record_path.read_text())
    frame = torch.from_numpy(frame_of(record_path, record).astype(np.float32))
    height, width = (side // MULTIPLE * MULTIPLE for side in frame.shape[1:])
    coded = stabilise(frame[:, :height, :width] / record["white"]).contiguous()
    with torch.no_grad():
        reference = load(args.weights.resolve()).cuda().eval()(coded[None].cuda())[0].cpu()
    # The device's own allocations come from the same card.
    torch.cuda.empty_cache()

    with tempfile.TemporaryDirectory() as scratch:
        given, answer = Path(scratch) / "in.f32", Path(scratch) / "out.f32"
        given.write_bytes(coded.numpy().astype("<f4").tobytes())
        command = [str(EXAMPLE), str(args.weights.resolve()), str(given), str(width), str(height), str(answer)]
        subprocess.run(command, check=True, env=example_environment())
        device = torch.from_numpy(np.fromfile(answer, "<f4").reshape(reference.shape))
    error = device - reference
    agreement = psnr(error.pow(2).mean())
    print(
        f"{width}x{height}: max |error| {float(error.abs().max()):.2e} of a reflection up to"
        f" {float(reference.abs().max()):.3f}, PSNR {agreement:.1f} dB"
    )
    if agreement < AGREEMENT_DB:
        raise SystemExit(f"the device disagrees with torch, under {AGREEMENT_DB} dB")


if __name__ == "__main__":
    main()
