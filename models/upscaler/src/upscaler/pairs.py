"""Each cached crop's low-resolution inputs: recorded by a noiseless sensor of twice the pitch, with
the photo's own blur. Training adds the photo's own noise to each batch afresh, and leaves it, since
the upscaler denoises as it upscales."""

from pathlib import Path

import numpy as np
import torch

from training.patches import Inputs
from training.targets import measured
from upscaler.degrade import recorded

VARIANTS = 2


def recorded_inputs(crops: np.ndarray, record: dict) -> np.ndarray:
    capture_blur = measured(Path(record["source"]))["capture_blur"]
    mosaics = torch.from_numpy(crops.astype(np.float32))[:, None]
    with torch.no_grad():
        variants = [recorded(mosaics, capture_blur)[:, 0].numpy() for _ in range(VARIANTS)]
    return np.stack(variants, 1)


INPUTS = Inputs("upscaler-recorded", VARIANTS, 2, recorded_inputs)
