"""Exported weights from one run averaged into one set: checkpoints a few thousand steps apart
disagree more than the moving average inside training smooths.

    uv run python -m dereflect.average <out dir> <weights dir>...
"""

import argparse
from pathlib import Path

import torch

from dereflect.model import load
from training.export import export, load_exported


def main() -> None:
    parser = argparse.ArgumentParser(description="Average exported reflection removers of one architecture.")
    parser.add_argument("out", type=Path)
    parser.add_argument("weights", type=Path, nargs="+")
    args = parser.parse_args()
    saved = [load_exported(folder) for folder in args.weights]
    names = saved[0].state.keys()
    if any(other.state.keys() != names for other in saved[1:]):
        raise SystemExit("the weights hold different tensors, so they aren't one architecture")
    net = load(args.weights[0])
    averaged = {name: torch.stack([s.state[name] for s in saved]).mean(0) for name in names}
    # Weights without a location gate average to none; `load` gave `net` an open one.
    missing = net.load_state_dict(averaged, strict=False).missing_keys
    if any(not name.startswith("locate.") for name in missing):
        raise SystemExit(f"the weights lack {missing}")
    plan = {key: value for key, value in saved[0].plan.items() if key not in ("floats", "tensors")}
    args.out.mkdir(parents=True, exist_ok=True)
    export(net, {**plan, "averaged": [str(folder) for folder in args.weights]}, args.out)
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
