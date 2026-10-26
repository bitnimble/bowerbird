"""Exported weights of one lineage averaged into one set, under the plan of the one holding the most tensors.

    uv run python -m dereflect.soup <out dir> <weights dir>... [--whole-hints]
"""

import argparse
from pathlib import Path

import torch

from training.export import export_state, load_exported


def main() -> None:
    parser = argparse.ArgumentParser(description="Average exported reflection removers of one lineage.")
    parser.add_argument("out", type=Path)
    parser.add_argument("weights", type=Path, nargs="+")
    parser.add_argument(
        "--whole-hints",
        action="store_true",
        help="average the hint tokenizer over only the weights that have one, rather than as zero where absent",
    )
    args = parser.parse_args()
    loaded = [load_exported(folder) for folder in args.weights]
    states = [exported.state for exported in loaded]
    names = set().union(*(state.keys() for state in states))
    # Only the hint tokenizer may be absent: it starts at zero, so absent reads as zero.
    strays = sorted({name for state in states for name in names - state.keys() if not name.startswith("hint_tokenizer.")})
    if strays:
        raise SystemExit(f"the weights differ in {strays}, so they aren't one architecture")
    richest = max(range(len(states)), key=lambda i: len(states[i]))
    souped = {
        name: torch.stack(
            [state[name] for state in states if name in state]
            if args.whole_hints
            else [state.get(name, torch.zeros_like(states[richest][name])) for state in states]
        ).mean(0)
        for name in states[richest]
    }
    plan = {key: value for key, value in loaded[richest].plan.items() if key not in ("floats", "tensors")}
    args.out.mkdir(parents=True, exist_ok=True)
    export_state(souped, {**plan, "souped": [str(folder) for folder in args.weights]}, args.out)
    print(f"souped {len(args.weights)} into {args.out}")


if __name__ == "__main__":
    main()
