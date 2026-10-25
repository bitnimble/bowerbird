"""Exported weights with the DINOv2 backbone they read beside them, under `dino.`: the one model the
app downloads (`native/rawshim/src/dereflect.rs`).

    uv run python -m dereflect.bundle <weights dir> <out dir>
"""

import argparse
from pathlib import Path

from dereflect import dino
from training.export import export_state, load_exported


def main() -> None:
    parser = argparse.ArgumentParser(description="Bundle the reflection remover with its backbone.")
    parser.add_argument("weights", type=Path)
    parser.add_argument("out", type=Path)
    args = parser.parse_args()
    exported = load_exported(args.weights)
    backbone = exported.plan.get("semantics")
    if backbone is None:
        raise SystemExit(f"{args.weights} reads no backbone")
    if exported.plan.get("retuned", 0):
        raise SystemExit(f"{args.weights} retunes the backbone, which the app does not run")
    described = {
        f"dino.{name}": value for name, value in dino.load(backbone).state_dict().items() if name != "mask_token"
    }
    args.out.mkdir(parents=True, exist_ok=True)
    export_state({**exported.state, **described}, {**exported.plan, "bundled": str(args.weights)}, args.out)


if __name__ == "__main__":
    main()
