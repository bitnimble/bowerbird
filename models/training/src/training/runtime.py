"""The GPU, arguments, data loading, training loop and checkpoints every trainer here shares."""

import argparse
import copy
import math
import os
import signal
import time
from collections.abc import Callable, Iterable, Iterator
from pathlib import Path

import torch
from torch.utils.data import DataLoader, Dataset

from training.capped import STOPPING, die_with_parent
from training.crops import DEFAULT_CACHE
from training.export import export
from training.files import write_atomic

GRAD_CLIP = 1.0
AVERAGE_DECAY = 0.999
LOG_EVERY = 100
VALIDATION_EVERY = 2000
VALIDATION_CHUNK = 8

Forward = Callable[[torch.Tensor], torch.Tensor]
"""The compiled network under autocast, returning f32."""


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


def arguments(description: str) -> argparse.ArgumentParser:
    """A parser with the flags every trainer takes; a model adds its own."""
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument("data", type=Path, help="folder of RAW files, or a `filelist` CSV of them")
    parser.add_argument("--out", type=Path, default=Path("runs/default"))
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--steps", type=int, default=300_000)
    parser.add_argument("--batch", type=int, default=32)
    parser.add_argument("--lr", type=float, default=5e-4)
    parser.add_argument("--workers", type=int, default=12)
    parser.add_argument("--prepare-workers", type=int, default=3, help="each holds a PMRID server")
    return parser


def stop_on_signals() -> None:
    """SIGINT, SIGTERM and SIGHUP all raise `KeyboardInterrupt` once, so a trainer saves and its
    workers are joined."""

    def stop(*_: object) -> None:
        # A second signal would land in the middle of saving.
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


def train(
    net: torch.nn.Module,
    batches: DataLoader,
    objective: Callable[..., tuple[torch.Tensor, dict[str, torch.Tensor]]],
    validate: Callable[[Forward, int], None],
    *,
    steps: int,
    lr: float,
    bf16: bool,
    settings: dict[str, object],
    plan: dict[str, object],
    out: Path,
    say: Callable[[str], None],
) -> None:
    """Trains `net`, on the GPU, for `steps`, resuming from `out` and exporting `plan` and the
    weights' moving average there at each validation and on a stopping signal. `objective` gives the
    loss to step on and the terms to log, from the tensors of a batch; `validate` sees the average.
    `settings` must be the same to resume."""
    device = next(net.parameters()).device
    model = torch.compile(net, mode="reduce-overhead")
    average = copy.deepcopy(net).requires_grad_(False)
    optimiser = torch.optim.Adam(net.parameters(), lr=lr, betas=(0.9, 0.99), fused=True)
    schedule = torch.optim.lr_scheduler.LambdaLR(optimiser, warmup_cosine(steps))
    resume = out / "resume.pt"
    step = load_resume(resume, net, average, optimiser, schedule, settings)
    if step:
        say(f"resumed at step {step}")
    trained, averaged = list(net.parameters()), list(average.parameters())

    def forward(given: torch.Tensor) -> torch.Tensor:
        with torch.autocast("cuda", dtype=torch.bfloat16, enabled=bf16):
            return model(given.contiguous(memory_format=torch.channels_last)).float()

    def forward_averaged(given: torch.Tensor) -> torch.Tensor:
        with torch.autocast("cuda", dtype=torch.bfloat16, enabled=bf16):
            return average(given.contiguous(memory_format=torch.channels_last)).float()

    def save() -> None:
        save_resume(resume, net, average, optimiser, schedule, step, settings)
        export(average, plan, out)

    started, terms = time.monotonic(), []
    skipped = torch.zeros((), dtype=torch.int64, device=device)
    try:
        while step < steps:
            for batch in batches:
                torch.compiler.cudagraph_mark_step_begin()
                loss, logged = objective(forward, *(tensor.to(device, non_blocking=True) for tensor in batch))
                optimiser.zero_grad(set_to_none=True)
                loss.backward()
                skipped_now = step_unless_nonfinite(optimiser, trained, GRAD_CLIP)
                skipped += skipped_now
                # Without no_grad, each step's lerp chains an autograd node onto the last: ~30KB a step.
                with torch.no_grad():
                    torch._foreach_lerp_(averaged, trained, 1 - AVERAGE_DECAY)
                step += 1
                schedule.step()
                terms.append(torch.where(skipped_now, torch.nan, torch.stack([t.detach() for t in logged.values()])))

                if step % LOG_EVERY == 0:
                    means = torch.stack(terms).nanmean(0).tolist()
                    shown = " ".join(f"{name} {mean:.5f}" for name, mean in zip(logged, means))
                    rate = len(terms) / (time.monotonic() - started)
                    say(f"step {step} {shown} lr {schedule.get_last_lr()[0]:.2e} {rate:.1f} it/s skipped {skipped.item()}")
                    started, terms = time.monotonic(), []
                if step % VALIDATION_EVERY == 0 or step == steps:
                    validate(forward_averaged, step)
                    save()
                    started, terms = time.monotonic(), []
                if step >= steps:
                    break
    except KeyboardInterrupt:
        say(f"stopped at step {step}")
        save()


@torch.no_grad()
def predictions(forward: Forward, given: torch.Tensor, wanted: torch.Tensor) -> Iterator[tuple[torch.Tensor, torch.Tensor]]:
    """`forward` over a validation set in chunks, each with its targets."""
    for given_chunk, wanted_chunk in zip(given.split(VALIDATION_CHUNK), wanted.split(VALIDATION_CHUNK)):
        torch.compiler.cudagraph_mark_step_begin()
        yield forward(given_chunk), wanted_chunk


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
    average: torch.nn.Module,
    optimiser: torch.optim.Optimizer,
    schedule: torch.optim.lr_scheduler.LRScheduler,
    step: int,
    settings: dict[str, object],
) -> None:
    state = {
        "net": net.state_dict(),
        "average": average.state_dict(),
        "optimiser": optimiser.state_dict(),
        "schedule": schedule.state_dict(),
        "step": step,
        "settings": settings,
    }
    write_atomic(path, lambda f: torch.save(state, f))


def load_resume(
    path: Path,
    net: torch.nn.Module,
    average: torch.nn.Module,
    optimiser: torch.optim.Optimizer,
    schedule: torch.optim.lr_scheduler.LRScheduler,
    settings: dict[str, object],
) -> int:
    """The step `path` was saved at, with everything restored; 0 when there is nothing to resume.
    Refuses `settings` other than those it was saved with, which resuming would silently mix."""
    if not path.exists():
        return 0
    state = torch.load(path, map_location="cuda")
    saved = state["settings"]
    changed = sorted(name for name in settings if saved.get(name) != settings[name])
    if changed:
        raise SystemExit(f"{path} was saved with " + ", ".join(f"{name} {saved.get(name)}" for name in changed))
    net.load_state_dict(state["net"])
    average.load_state_dict(state["average"])
    optimiser.load_state_dict(state["optimiser"])
    schedule.load_state_dict(state["schedule"])
    return state["step"]
