"""Each cached crop's low-resolution inputs: recorded by a sensor of twice the pitch, given the
photo's own noise and blur, and left noisy, since the upscaler denoises as it upscales."""

from pathlib import Path

import numpy as np
import torch

from training.patches import Inputs
from training.targets import measured
from upscaler.degrade import low

VARIANTS = 2


def low_inputs(crops: np.ndarray, record: dict) -> np.ndarray:
    gains = torch.from_numpy(np.asarray(record["gains"], np.float32))
    capture_blur = measured(Path(record["source"]))["capture_blur"]
    mosaics = torch.from_numpy(crops.astype(np.float32))[:, None]
    with torch.no_grad():
        variants = [low(mosaics, gains, record["fit"], capture_blur)[:, 0].numpy() for _ in range(VARIANTS)]
    return np.stack(variants, 1)


INPUTS = Inputs("upscaler-joint", VARIANTS, 2, low_inputs)
