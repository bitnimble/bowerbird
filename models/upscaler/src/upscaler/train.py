from typing import NamedTuple

import numpy as np
import torch
import torch.nn.functional as F

from training.metrics import detail, edge_loss, psnr
from training.mosaic import (
    FIT_STABILISER,
    Stabiliser,
    add_noise,
    bilinear,
    fit_stabiliser,
    pack,
    pack_rgb,
    stabilise,
    stabilised,
    unstabilised,
)
from training.pairs import CropPairs, datasets
from training.runtime import (
    VALIDATION_CHUNK,
    Forward,
    arguments,
    cuda,
    loader,
    logger,
    predictions,
    stop_on_signals,
    train,
)
from training.targets import SHARPENED
from upscaler.model import build
from upscaler.pairs import INPUTS

VALIDATION_CROPS = 64
INPUT_NYQUIST = 0.25
"""In cycles per target-plane pixel: past it, the outer three quarters of each plane's spectrum,
lies what only the upscale can put there."""


class Planes(NamedTuple):
    low: torch.Tensor
    """(B, 4, h, w) planes of the input mosaics, under `stabiliser`."""
    high: torch.Tensor
    """(B, 4, 2h, 2w) planes of the target mosaics, `stabilise`d: where the loss is measured, the same
    for every ISO."""
    stabiliser: Stabiliser
    """Each input's own, from its noise."""


def main() -> None:
    parser = arguments("Train the 2x RAW mosaic upscaler.")
    parser.add_argument("--channels", type=int, default=48)
    parser.add_argument("--encoder", type=counts, default=[2, 3, 4], help="the body's blocks a level, from full")
    parser.add_argument("--decoder", type=counts, default=[2, 2], help="the body's, 1 level fewer")
    parser.add_argument("--edges", type=float, default=1.0, help="weight of the edge loss")
    parser.set_defaults(batch=8, steps=400_000)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    say = logger(args.out / "train.log")
    stop_on_signals()

    train_set, validation_sets = datasets(args.data, args.cache, args.prepare_workers, INPUTS, SHARPENED, args.batch)
    device, bf16 = cuda()
    sizes = ", ".join(f"{len(pairs)} {name}" for name, pairs in validation_sets.items())
    say(f"{len(train_set)} training crops, validation crops: {sizes}, bf16={bf16}")
    validations = {name: validation_set(pairs, device) for name, pairs in validation_sets.items() if len(pairs)}

    def objective(
        forward: Forward, given: torch.Tensor, wanted: torch.Tensor, sensors: torch.Tensor
    ) -> tuple[torch.Tensor, dict[str, torch.Tensor]]:
        batch = planes(noisy(given.float(), sensors), wanted, sensors)
        predicted = comparable(forward(batch.low), batch.stabiliser)
        terms = {"loss": F.l1_loss(predicted, batch.high)}
        if args.edges:
            terms["edges"] = edge_loss(predicted, batch.high)
        weights = {"loss": 1.0, "edges": args.edges}
        return sum(weights[name] * term for name, term in terms.items()), terms

    def validate(forward: Forward, step: int) -> None:
        for name, validation in validations.items():
            ours, share = measure(forward, validation)
            say(
                f"step {step} validation {name}: PSNR {ours:.3f} dB, bilinear {validation.bilinear:.3f} dB,"
                f" detail {share:.0%} of the target's"
            )

    plan = {
        "channels": args.channels,
        "stabiliser": FIT_STABILISER,
        "targets": SHARPENED.name,
        "encoder_blocks": args.encoder,
        "decoder_blocks": args.decoder,
    }
    train(
        build(plan).to(device, memory_format=torch.channels_last),
        loader(train_set, args.batch, args.workers),
        objective,
        validate,
        steps=args.steps,
        lr=args.lr,
        bf16=bf16,
        settings={
            name: getattr(args, name)
            for name in ("steps", "batch", "channels", "encoder", "decoder", "lr", "edges")
        },
        plan=plan,
        out=args.out,
        say=say,
    )


def counts(text: str) -> list[int]:
    return [int(count) for count in text.split(",")]


def planes(low: torch.Tensor, high: torch.Tensor, sensors: torch.Tensor) -> Planes:
    stabiliser = fit_stabiliser(sensors[:, :3], sensors[:, 3], sensors[:, 4])
    return Planes(stabilised(pack(low.float()), stabiliser), stabilise(pack(high.float())), stabiliser)


def comparable(predicted: torch.Tensor, stabiliser: Stabiliser) -> torch.Tensor:
    """The network's planes, under its input's stabiliser, as `Planes.high` holds the targets'."""
    return stabilise(unstabilised(predicted, stabiliser))


def noisy(recorded: torch.Tensor, sensors: torch.Tensor) -> torch.Tensor:
    """Each of the (B, 1, h, w) `recorded` mosaics with fresh noise of its photo's sensor, a row of
    the (B, 5) `sensors` as `pairs.sensor` lays it out."""
    return add_noise(recorded, sensors[:, :3], sensors[:, 3], sensors[:, 4])


class Validation(NamedTuple):
    planes: Planes
    bilinear: float
    """PSNR of the input demosaiced, upscaled bilinearly and mosaiced again: the classical answer."""
    detail: torch.Tensor
    """The targets' `detail`."""


def validation_set(pairs: CropPairs, device: torch.device) -> Validation:
    chosen = np.linspace(0, len(pairs) - 1, min(VALIDATION_CROPS, len(pairs))).astype(int)
    recorded, high, sensors = (torch.stack(batch).to(device) for batch in zip(*(pairs[int(i)] for i in chosen)))
    with torch.random.fork_rng(devices=[device]):
        torch.manual_seed(0)
        low = noisy(recorded.float(), sensors)
    batch = planes(low, high, sensors)
    classical = psnr(F.mse_loss(stabilise(pack_rgb(bilinear(low))), batch.high))
    return Validation(batch, classical, detail(batch.high, INPUT_NYQUIST))


def measure(forward: Forward, validation: Validation) -> tuple[float, float]:
    """PSNR, and the predicted detail as a share of the target's."""
    squared_error = torch.zeros((), device=validation.detail.device)
    predicted_detail = torch.zeros_like(squared_error)
    stabiliser = validation.planes.stabiliser
    chunks = zip(
        predictions(forward, validation.planes.low, validation.planes.high),
        stabiliser.floors.split(VALIDATION_CHUNK),
        stabiliser.scales.split(VALIDATION_CHUNK),
    )
    for (predicted, high), floors, scales in chunks:
        predicted = comparable(predicted, Stabiliser(floors, scales))
        squared_error += F.mse_loss(predicted, high, reduction="sum")
        predicted_detail += detail(predicted, INPUT_NYQUIST)
    return psnr(squared_error / validation.planes.high.numel()), float(predicted_detail / validation.detail)


if __name__ == "__main__":
    main()
