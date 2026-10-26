"""Exported weights scored on the held-out pairs as training validates them, composited with `started`'s defaults.

    uv run python -m dereflect.evaluate <data> <weights dir>... [--cache dir]
"""

import argparse
from pathlib import Path

import torch

from dereflect import frames
from dereflect.composites import CROP, Pairs
from dereflect.model import load
from dereflect.train import held_out, measure
from training.crops import sources
from training.pmrid import serve
from training.runtime import Forward, cuda


def main() -> None:
    parser = argparse.ArgumentParser(description="Score exported reflection removers on the held-out pairs.")
    parser.add_argument("data", type=Path, help="folder of RAW files, or a `filelist` CSV of them")
    parser.add_argument("weights", type=Path, nargs="+")
    parser.add_argument("--cache", type=Path, default=frames.DEFAULT_FRAMES)
    parser.add_argument("--crop", type=int, default=CROP, help="side of the held-out crops")
    args = parser.parse_args()
    pairs = Pairs(args.cache, sources(args.data), True, crop=args.crop)
    if len(pairs) < 2:
        raise SystemExit(f"{len(pairs)} held-out pairs of {args.data} under {args.cache}, fewer than 2")
    device, bf16 = cuda()
    serve(args.cache / ".scratch")
    validation = held_out(pairs, device, {})
    for weights in args.weights:
        net = load(weights).to(device, memory_format=torch.channels_last).eval()
        print(f"{weights}: {measure(forwarding(net, bf16), validation, device)}", flush=True)


def forwarding(net: torch.nn.Module, bf16: bool) -> Forward:
    def forward(given: torch.Tensor) -> torch.Tensor:
        with torch.autocast("cuda", dtype=torch.bfloat16, enabled=bf16):
            return net(given.contiguous(memory_format=torch.channels_last)).float()

    return forward


if __name__ == "__main__":
    main()
