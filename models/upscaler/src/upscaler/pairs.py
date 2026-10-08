"""Each cached crop's low-resolution inputs: recorded by a sensor of twice the pitch, given the
photo's own noise and blur, and denoised by PMRID as the editor would hand them to the upscaler."""

from pathlib import Path

import numpy as np
import torch

from training.patches import Inputs
from training.pmrid import pmrid
from training.targets import measured
from upscaler.degrade import low

VARIANTS = 2


def low_inputs(crops: np.ndarray, record: dict) -> np.ndarray:
    gains = np.asarray(record["gains"], np.float32)
    capture_blur = measured(Path(record["source"]))["capture_blur"]
    variants = []
    for _ in range(VARIANTS):
        with torch.no_grad():
            noisy = low(
                torch.from_numpy(crops.astype(np.float32))[:, None], torch.from_numpy(gains), record["fit"], capture_blur
            )
        variants.append(pmrid().denoise(noisy[:, 0].numpy(), gains, record["fit"]))
    return np.stack(variants, 1)


INPUTS = Inputs("upscaler-own-blur", VARIANTS, 2, low_inputs)
