import hashlib
import json
import math
from pathlib import Path
from typing import NamedTuple

import numpy as np
import torch

from training.files import write_atomic


def export(net: torch.nn.Module, plan: dict[str, object], out: Path) -> None:
    """`weights.bin`, flat little-endian f32, and `weights.json`, `plan` plus where each tensor
    sits in it: the layout `get:models` writes PMRID's in."""
    export_state(net.state_dict(), plan, out)


STORED = {"f32": "<f4", "f16": "<f2"}


def export_state(state: dict[str, torch.Tensor], plan: dict[str, object], out: Path, stored: str = "f32") -> None:
    tensors, blobs, offset = [], [], 0
    for name, tensor in state.items():
        values = tensor.detach().float().cpu().numpy().astype(STORED[stored])
        if not np.isfinite(values).all():
            raise SystemExit(f"{name} does not fit {stored}")
        tensors.append({"name": name, "shape": list(values.shape), "offset": offset})
        blobs.append(values.ravel())
        offset += values.size
    manifest = {**plan, **({"stored": stored} if stored != "f32" else {}), "floats": offset, "tensors": tensors}
    write_atomic(out / "weights.bin", lambda f: f.write(np.concatenate(blobs).tobytes()))
    write_atomic(out / "weights.json", lambda f: f.write((json.dumps(manifest, indent=2) + "\n").encode()))


class Exported(NamedTuple):
    plan: dict
    """`weights.json` as `export` wrote it, plus whatever was added to it since."""
    state: dict[str, torch.Tensor]
    digest: str
    """SHA-256 of `weights.bin`."""


def load_exported(folder: Path) -> Exported:
    """What `export` wrote to `folder`, ready for `load_state_dict`."""
    plan = json.loads((folder / "weights.json").read_text())
    blob = (folder / "weights.bin").read_bytes()
    # Popped, since the state is widened here: exporting it again writes what that export says.
    floats = np.frombuffer(blob, STORED[plan.pop("stored", "f32")]).astype(np.float32)
    if floats.size != plan["floats"]:
        raise SystemExit(f"{folder} holds {floats.size} floats where its manifest has {plan['floats']}")
    state = {
        t["name"]: torch.from_numpy(floats[t["offset"] : t["offset"] + math.prod(t["shape"])].reshape(t["shape"]))
        for t in plan["tensors"]
    }
    return Exported(plan, state, hashlib.sha256(blob).hexdigest())
