"""Each cached crop's low-resolution inputs: recorded by a sensor of twice the pitch, given the
photo's own noise, and denoised by PMRID as the editor would hand them to the upscaler."""

import json
from pathlib import Path

import numpy as np
import torch

from training.crops import records
from training.files import write_atomic
from training.pmrid import each_with_pmrid, pmrid
from upscaler.degrade import low

VARIANTS = 2


def lows_of(record_path: Path) -> Path:
    """(crops, VARIANTS, 256, 256) fp16 inputs for the record's (crops, 512, 512) targets."""
    return record_path.with_suffix(".upscaler.npy")


def make_pairs(cache: Path, raws: list[Path], workers: int) -> None:
    jobs = [path for split in (False, True) for path, _ in records(cache, raws, split) if not lows_of(path).exists()]
    print(f"pairs: {len(jobs)} photos without inputs", flush=True)
    for done, path in enumerate(each_with_pmrid(make_one, jobs, workers, cache / ".scratch"), 1):
        if done % 50 == 0 or done == len(jobs):
            print(f"pairs: {done}/{len(jobs)} ({path.stem})", flush=True)


def make_one(record_path: Path) -> Path:
    torch.set_num_threads(2)
    torch.manual_seed(int(record_path.stem[:8], 16))
    record = json.loads(record_path.read_text())
    targets = torch.from_numpy(np.load(record_path.with_suffix(".npy")).astype(np.float32))[:, None]
    gains = np.asarray(record["gains"], np.float32)
    variants = []
    for _ in range(VARIANTS):
        with torch.no_grad():
            noisy = low(targets, torch.from_numpy(gains), record["fit"])[:, 0].numpy()
        variants.append(pmrid().denoise(noisy, gains, record["fit"]))
    lows = np.stack(variants, 1).astype(np.float16)
    write_atomic(lows_of(record_path), lambda f: np.save(f, lows))
    return record_path
