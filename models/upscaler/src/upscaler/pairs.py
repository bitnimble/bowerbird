"""Each cached crop's low-resolution inputs: recorded by a sensor of twice the pitch, given the
photo's own noise, and denoised by PMRID as the editor would hand them to the upscaler."""

import numpy as np
import torch

from training.patches import Inputs
from training.pmrid import pmrid
from upscaler.degrade import low

VARIANTS = 2


def low_inputs(targets: np.ndarray, record: dict) -> np.ndarray:
    gains = np.asarray(record["gains"], np.float32)
    variants = []
    for _ in range(VARIANTS):
        with torch.no_grad():
            noisy = low(torch.from_numpy(targets.astype(np.float32))[:, None], torch.from_numpy(gains), record["fit"])
        variants.append(pmrid().denoise(noisy[:, 0].numpy(), gains, record["fit"]))
    return np.stack(variants, 1)


INPUTS = Inputs("upscaler", VARIANTS, 2, low_inputs)
