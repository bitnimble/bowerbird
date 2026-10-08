from typing import NamedTuple

import numpy as np
import torch
import torch.nn.functional as F

from training.metrics import detail, edge_loss, psnr, spectrum_loss
from training.mosaic import STABILISER_FLOOR, bilinear, pack, pack_rgb, stabilise
from training.patches import PatchPairs, datasets
from training.runtime import Forward, arguments, cuda, loader, logger, predictions, stop_on_signals, train
from training.targets import TARGETS
from upscaler.model import Upscaler
from upscaler.pairs import INPUTS

VALIDATION_CROPS = 64
INPUT_NYQUIST = 0.25
"""In cycles per target-plane pixel: past it, the outer three quarters of each plane's spectrum,
lies what only the upscale can put there."""


class Planes(NamedTuple):
    low: torch.Tensor
    """(B, 4, h, w) stabilised planes of the input mosaics."""
    high: torch.Tensor
    """(B, 4, 2h, 2w) stabilised planes of the target mosaics."""


def main() -> None:
    parser = arguments("Train the 2x RAW mosaic upscaler.")
    parser.add_argument("--channels", type=int, default=48)
    parser.add_argument("--blocks", type=int, default=16)
    parser.add_argument("--texture", type=float, default=0, help="weight of the amplitude spectrum loss")
    parser.add_argument("--edges", type=float, default=0, help="weight of the edge loss")
    parser.add_argument("--targets", choices=TARGETS, default="plain")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    say = logger(args.out / "train.log")
    stop_on_signals()

    targets = TARGETS[args.targets]
    train_set, validation_sets = datasets(args.data, args.cache, args.prepare_workers, INPUTS, targets, args.batch)
    device, bf16 = cuda()
    sizes = ", ".join(f"{len(pairs)} {name}" for name, pairs in validation_sets.items())
    say(f"{len(train_set)} training crops, validation crops: {sizes}, bf16={bf16}")
    validations = {name: validation_set(pairs, device) for name, pairs in validation_sets.items() if len(pairs)}

    def objective(forward: Forward, given: torch.Tensor, wanted: torch.Tensor) -> tuple[torch.Tensor, dict[str, torch.Tensor]]:
        batch = planes(given, wanted)
        predicted = forward(batch.low)
        terms = {"loss": F.l1_loss(predicted, batch.high)}
        if args.texture:
            terms["texture"] = spectrum_loss(predicted, batch.high)
        if args.edges:
            terms["edges"] = edge_loss(predicted, batch.high)
        weights = {"loss": 1.0, "texture": args.texture, "edges": args.edges}
        return sum(weights[name] * term for name, term in terms.items()), terms

    def validate(forward: Forward, step: int) -> None:
        for name, validation in validations.items():
            ours, share = measure(forward, validation)
            say(
                f"step {step} validation {name}: PSNR {ours:.3f} dB, bilinear {validation.bilinear:.3f} dB,"
                f" detail {share:.0%} of the target's"
            )

    train(
        Upscaler(args.channels, args.blocks).to(device, memory_format=torch.channels_last),
        loader(train_set, args.batch, args.workers),
        objective,
        validate,
        steps=args.steps,
        lr=args.lr,
        bf16=bf16,
        settings={
            name: getattr(args, name) for name in ("steps", "batch", "channels", "blocks", "lr", "texture", "edges", "targets")
        },
        plan={"channels": args.channels, "blocks": args.blocks, "stabiliser_floor": STABILISER_FLOOR, "targets": args.targets},
        out=args.out,
        say=say,
    )


def planes(low: torch.Tensor, high: torch.Tensor) -> Planes:
    return Planes(low=stabilise(pack(low.float())), high=stabilise(pack(high.float())))


class Validation(NamedTuple):
    planes: Planes
    bilinear: float
    """PSNR of the input demosaiced, upscaled bilinearly and mosaiced again: the classical answer."""
    detail: torch.Tensor
    """The targets' `detail`."""


def validation_set(pairs: PatchPairs, device: torch.device) -> Validation:
    chosen = np.linspace(0, len(pairs) - 1, min(VALIDATION_CROPS, len(pairs))).astype(int)
    lows, highs = zip(*(pairs[int(i)] for i in chosen))
    low, high = torch.stack(lows).to(device).float(), torch.stack(highs).to(device)
    batch = planes(low, high)
    classical = psnr(F.mse_loss(stabilise(pack_rgb(bilinear(low))), batch.high))
    return Validation(batch, classical, detail(batch.high, INPUT_NYQUIST))


def measure(forward: Forward, validation: Validation) -> tuple[float, float]:
    """PSNR, and the predicted detail as a share of the target's."""
    squared_error = torch.zeros((), device=validation.detail.device)
    predicted_detail = torch.zeros_like(squared_error)
    for predicted, high in predictions(forward, validation.planes.low, validation.planes.high):
        squared_error += F.mse_loss(predicted, high, reduction="sum")
        predicted_detail += detail(predicted, INPUT_NYQUIST)
    return psnr(squared_error / validation.planes.high.numel()), float(predicted_detail / validation.detail)


if __name__ == "__main__":
    main()
