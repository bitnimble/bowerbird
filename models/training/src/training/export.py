import json
from pathlib import Path

import numpy as np
import torch

from training.files import write_atomic


def export(net: torch.nn.Module, plan: dict[str, object], out: Path) -> None:
    """`weights.bin`, flat little-endian f32, and `weights.json`, `plan` plus where each tensor
    sits in it: the layout `get:pmrid` writes PMRID's in."""
    tensors, blobs, offset = [], [], 0
    for name, tensor in net.state_dict().items():
        values = tensor.detach().float().cpu().numpy().astype("<f4")
        tensors.append({"name": name, "shape": list(values.shape), "offset": offset})
        blobs.append(values.ravel())
        offset += values.size
    manifest = {**plan, "floats": offset, "tensors": tensors}
    write_atomic(out / "weights.bin", lambda f: f.write(np.concatenate(blobs).tobytes()))
    write_atomic(out / "weights.json", lambda f: f.write((json.dumps(manifest, indent=2) + "\n").encode()))
