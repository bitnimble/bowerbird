import argparse
import time
from pathlib import Path
from typing import NamedTuple

import numpy as np
import torch
import torch.nn.functional as F

from training.crops import DEFAULT_CACHE, isos, prepare, sources
from training.export import export
from training.mosaic import STABILISER_FLOOR, bilinear, pack, pack_rgb, stabilise
from training.runtime import (
    cuda,
    load_resume,
    loader,
    logger,
    save_resume,
    step_unless_nonfinite,
    stop_on_signals,
    warmup_cosine,
)
from upscaler.data import Pairs
from upscaler.model import Upscaler
from upscaler.pairs import make_pairs

GRAD_CLIP = 1.0
VALIDATION_EVERY = 2000
VALIDATION_CROPS = 64
LOG_EVERY = 100
HIGH_ISO = 1600
INPUT_NYQUIST = 0.25
"""In cycles per target-plane pixel."""


class Planes(NamedTuple):
    low: torch.Tensor
    """(B, 4, h, w) stabilised planes of the input mosaics."""
    high: torch.Tensor
    """(B, 4, 2h, 2w) stabilised planes of the target mosaics."""


def main() -> None:
    args = parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    say = logger(args.out / "train.log")
    stop_on_signals()

    raws = sources(args.data)
    prepare(raws, args.cache, args.prepare_workers)
    make_pairs(args.cache, raws, args.prepare_workers)
    device, bf16 = cuda()

    train_set = Pairs(args.cache, raws, validation=False)
    if len(train_set) < args.batch:
        raise SystemExit(f"{len(train_set)} usable crops under {args.cache}, fewer than a batch")
    iso = isos(args.data)
    validation_sets = {
        f"ISO under {HIGH_ISO}": Pairs(args.cache, raws, True, lambda s: iso.get(s, 0) < HIGH_ISO),
        f"ISO {HIGH_ISO} and over": Pairs(args.cache, raws, True, lambda s: iso.get(s, 0) >= HIGH_ISO),
    }
    sizes = ", ".join(f"{len(pairs)} {name}" for name, pairs in validation_sets.items())
    say(f"{len(train_set)} training crops, validation crops: {sizes}, bf16={bf16}")

    net = Upscaler(args.channels, args.blocks).to(device, memory_format=torch.channels_last)
    model = torch.compile(net, mode="reduce-overhead")
    optimiser = torch.optim.Adam(net.parameters(), lr=args.lr, betas=(0.9, 0.99), fused=True)
    schedule = torch.optim.lr_scheduler.LambdaLR(optimiser, warmup_cosine(args.steps))
    resume = args.out / "resume.pt"
    settings = {name: getattr(args, name) for name in ("steps", "batch", "channels", "blocks", "lr", "texture")}
    step = load_resume(resume, net, optimiser, schedule, settings)
    if step:
        say(f"resumed at step {step}")

    batches = loader(train_set, args.batch, args.workers)
    validations = {name: validation_set(pairs, device) for name, pairs in validation_sets.items() if len(pairs)}

    def save() -> None:
        save_resume(resume, net, optimiser, schedule, step, settings)
        plan = {"channels": args.channels, "blocks": args.blocks, "stabiliser_floor": STABILISER_FLOOR}
        export(net, plan, args.out)

    started, pixel_losses, texture_losses = time.monotonic(), [], []
    skipped = torch.zeros((), dtype=torch.int64, device=device)
    try:
        while step < args.steps:
            for given, wanted in batches:
                torch.compiler.cudagraph_mark_step_begin()
                batch = planes(given.to(device, non_blocking=True), wanted.to(device, non_blocking=True))
                with torch.autocast("cuda", dtype=torch.bfloat16, enabled=bf16):
                    predicted = model(batch.low.contiguous(memory_format=torch.channels_last))
                pixel_loss = F.l1_loss(predicted.float(), batch.high)
                texture_loss = spectrum_loss(predicted.float(), batch.high) if args.texture else torch.zeros_like(pixel_loss)

                optimiser.zero_grad(set_to_none=True)
                (pixel_loss + args.texture * texture_loss).backward()
                skipped_now = step_unless_nonfinite(optimiser, net.parameters(), GRAD_CLIP)
                skipped += skipped_now
                schedule.step()
                step += 1
                pixel_losses.append(torch.where(skipped_now, torch.nan, pixel_loss.detach()))
                texture_losses.append(torch.where(skipped_now, torch.nan, texture_loss.detach()))

                if step % LOG_EVERY == 0:
                    rate = LOG_EVERY / (time.monotonic() - started)
                    texture = f" texture {torch.stack(texture_losses).nanmean().item():.5f}" if args.texture else ""
                    say(
                        f"step {step} loss {torch.stack(pixel_losses).nanmean().item():.5f}{texture}"
                        f" lr {schedule.get_last_lr()[0]:.2e} {rate:.1f} it/s skipped {skipped.item()}"
                    )
                    started, pixel_losses, texture_losses = time.monotonic(), [], []
                if step % VALIDATION_EVERY == 0 or step == args.steps:
                    for name, validation in validations.items():
                        ours, share = validate(model, validation, bf16)
                        say(
                            f"step {step} validation {name}: PSNR {ours:.3f} dB, bilinear {validation.bilinear:.3f} dB,"
                            f" detail {share:.0%} of the target's"
                        )
                    save()
                    started = time.monotonic()
                if step >= args.steps:
                    break
    except KeyboardInterrupt:
        say(f"stopped at step {step}")
        save()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train the 2x RAW mosaic upscaler.")
    parser.add_argument("data", type=Path, help="folder of RAW files, or a `filelist` CSV of them")
    parser.add_argument("--out", type=Path, default=Path("runs/default"))
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--steps", type=int, default=300_000)
    parser.add_argument("--batch", type=int, default=32)
    parser.add_argument("--channels", type=int, default=48)
    parser.add_argument("--blocks", type=int, default=16)
    parser.add_argument("--lr", type=float, default=5e-4)
    parser.add_argument("--texture", type=float, default=0, help="weight of the amplitude spectrum loss")
    parser.add_argument("--workers", type=int, default=12)
    parser.add_argument("--prepare-workers", type=int, default=3, help="each holds a PMRID server")
    return parser.parse_args()


def spectrum_loss(predicted: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
    """L1 between amplitude spectra, blind to phase."""
    return F.l1_loss(torch.fft.rfft2(predicted, norm="ortho").abs(), torch.fft.rfft2(target, norm="ortho").abs())


def planes(low: torch.Tensor, high: torch.Tensor) -> Planes:
    return Planes(low=stabilise(pack(low.float())), high=stabilise(pack(high.float())))


class Validation(NamedTuple):
    planes: Planes
    bilinear: float
    """PSNR of the input demosaiced, upscaled bilinearly and mosaiced again: the classical answer."""
    detail: torch.Tensor
    """The targets' `detail`."""


def validation_set(pairs: Pairs, device: torch.device) -> Validation:
    chosen = np.linspace(0, len(pairs) - 1, min(VALIDATION_CROPS, len(pairs))).astype(int)
    lows, highs = zip(*(pairs[int(i)] for i in chosen))
    low, high = torch.stack(lows).to(device).float(), torch.stack(highs).to(device)
    batch = planes(low, high)
    return Validation(batch, psnr(F.mse_loss(stabilise(pack_rgb(bilinear(low))), batch.high)), detail(batch.high))


@torch.no_grad()
def validate(model: torch.nn.Module, validation: Validation, bf16: bool) -> tuple[float, float]:
    """PSNR, and the predicted detail as a share of the target's."""
    squared_error = torch.zeros((), device=validation.detail.device)
    predicted_detail = torch.zeros_like(squared_error)
    for low, high in zip(validation.planes.low.split(8), validation.planes.high.split(8)):
        torch.compiler.cudagraph_mark_step_begin()
        with torch.autocast("cuda", dtype=torch.bfloat16, enabled=bf16):
            predicted = model(low.contiguous(memory_format=torch.channels_last))
        squared_error += F.mse_loss(predicted.float(), high, reduction="sum")
        predicted_detail += detail(predicted.float())
    return psnr(squared_error / validation.planes.high.numel()), float(predicted_detail / validation.detail)


def detail(batch: torch.Tensor) -> torch.Tensor:
    """Amplitude summed over the frequencies past the input's Nyquist limit, the outer three
    quarters of each plane's spectrum, which only the upscale can put there."""
    spectrum = torch.fft.rfft2(batch, norm="ortho").abs()
    across = torch.fft.fftfreq(batch.shape[-2], device=batch.device).abs()[:, None]
    along = torch.fft.rfftfreq(batch.shape[-1], device=batch.device)[None, :]
    return spectrum[..., torch.maximum(across, along) > INPUT_NYQUIST].sum()


def psnr(mse: torch.Tensor) -> float:
    return float(-10 * torch.log10(mse))


if __name__ == "__main__":
    main()
