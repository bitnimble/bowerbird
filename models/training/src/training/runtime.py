"""The GPU, data loading, schedule, step and checkpoint setup every trainer here shares."""

import math
import os
import signal
from collections.abc import Callable, Iterable
from pathlib import Path

import torch
from torch.utils.data import DataLoader, Dataset

from training.capped import die_with_parent
from training.files import write_atomic


def cuda() -> tuple[torch.device, bool]:
    """The GPU with TF32 and cuDNN autotuning on, and whether it has bf16 tensor cores."""
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
    # Inductor otherwise starts a compile process per core, each a few hundred MB.
    os.environ.setdefault("TORCHINDUCTOR_COMPILE_THREADS", "4")
    if not torch.cuda.is_available():
        raise SystemExit("training needs a CUDA GPU")
    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cudnn.allow_tf32 = True
    torch.backends.cudnn.benchmark = True
    # Capability, not `is_bf16_supported`, which also answers yes for Turing's slow emulated bf16.
    return torch.device("cuda"), torch.cuda.get_device_capability()[0] >= 8


STOPPING = (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)


def stop_on_signals() -> None:
    """SIGINT, SIGTERM and SIGHUP all raise `KeyboardInterrupt` once, so a trainer saves and its
    workers are joined."""

    def stop(*_: object) -> None:
        # A signal to the process group also arrives forwarded by `capped`; a second interrupt
        # would land in the middle of saving.
        for number in STOPPING:
            signal.signal(number, signal.SIG_IGN)
        raise KeyboardInterrupt

    for number in STOPPING:
        signal.signal(number, stop)


def logger(path: Path) -> Callable[[str], None]:
    log = path.open("a", buffering=1)

    def say(line: str) -> None:
        print(line, flush=True)
        log.write(line + "\n")

    return say


def loader(dataset: Dataset, batch: int, workers: int) -> DataLoader:
    return DataLoader(
        dataset,
        batch_size=batch,
        shuffle=True,
        drop_last=True,
        num_workers=workers,
        pin_memory=True,
        persistent_workers=workers > 0,
        worker_init_fn=die_with_parent,
    )


def warmup_cosine(steps: int, warmup: int = 1000, floor: float = 0.05) -> Callable[[int], float]:
    def share(step: int) -> float:
        if step < warmup:
            return (step + 1) / warmup
        progress = min(1.0, (step - warmup) / max(1, steps - warmup))
        return floor + (1 - floor) * 0.5 * (1 + math.cos(math.pi * progress))

    return share


def step_unless_nonfinite(
    optimiser: torch.optim.Optimizer, parameters: Iterable[torch.Tensor], clip: float
) -> torch.Tensor:
    """Clips gradients and steps a fused optimiser unless they aren't finite, without a host sync.
    Returns a device bool that is true where the step was skipped."""
    if not optimiser.defaults.get("fused"):
        raise ValueError("only a fused optimiser can skip a step on the device")
    skipped = ~torch.isfinite(torch.nn.utils.clip_grad_norm_(parameters, clip))
    # Fused optimisers leave parameters and step counts alone where this is 1: `GradScaler`'s hook.
    optimiser.found_inf = skipped.float()
    optimiser.step()
    return skipped


def save_resume(
    path: Path,
    net: torch.nn.Module,
    optimiser: torch.optim.Optimizer,
    schedule: torch.optim.lr_scheduler.LRScheduler,
    step: int,
    settings: dict[str, object],
) -> None:
    state = {
        "net": net.state_dict(),
        "optimiser": optimiser.state_dict(),
        "schedule": schedule.state_dict(),
        "rng": torch.cuda.get_rng_state(),
        "step": step,
        "settings": settings,
    }
    write_atomic(path, lambda f: torch.save(state, f))


def load_resume(
    path: Path,
    net: torch.nn.Module,
    optimiser: torch.optim.Optimizer,
    schedule: torch.optim.lr_scheduler.LRScheduler,
    settings: dict[str, object],
) -> int:
    """The step `path` was saved at, with everything restored; 0 when there is nothing to resume.
    Refuses `settings` other than those it was saved with, which resuming would silently mix."""
    if not path.exists():
        return 0
    state = torch.load(path, map_location="cuda")
    saved = state.get("settings", settings)
    changed = sorted(name for name in settings if saved.get(name) != settings[name])
    if changed:
        raise SystemExit(f"{path} was saved with " + ", ".join(f"{name} {saved.get(name)}" for name in changed))
    net.load_state_dict(state["net"])
    optimiser.load_state_dict(state["optimiser"])
    schedule.load_state_dict(state["schedule"])
    torch.cuda.set_rng_state(state["rng"].cpu())
    return state["step"]
