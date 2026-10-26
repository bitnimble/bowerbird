"""Trains LightRR to find the reflection in a photograph through glass, on composites of the library's
own frames.

The network sees the photograph coded by `stabilise` and predicts the reflection coded the same; the
reflection is then subtracted in linear light, where glass added it."""

import argparse
from collections.abc import Iterable, Iterator
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import NamedTuple

import numpy as np
import torch
import torch.nn.functional as F
from torch.utils.data import ConcatDataset, Dataset, Subset

from dereflect import dino, frames, vgg
from dereflect.composites import CROP, Composite, Pairs, Pending, blurred, finished, started
from dereflect.model import BLOCKS, DIMS, HEADS, HINTS, MULTIPLE, LightRR, Stage, load, removing
from dereflect.real import RealPairs
from training.crops import sources
from training.metrics import edge_loss, psnr, ssim_map
from training.mosaic import STABILISER_FLOOR, stabilise, unstabilise
from training.pmrid import serve
from training.preview import panels, write_png
from training.runtime import VALIDATION_CHUNK, Forward, arguments, cuda, loader, logger, stop_on_signals, train

VALIDATION_PAIRS = 192
FIRST_PAIRS = 48
"""Composited as a batch of their own: `composite`'s draws depend on the batch's size, so the preview's
rows keep their mixes whatever `VALIDATION_PAIRS` is."""
PREVIEWED = 4
EXCLUSION_LEVELS = 3
STRUCTURE_WINDOW = 7
PRESENCE_SCALE = 0.05
"""Coded reflection at which the location loss calls a pixel wholly reflection; fainter is partly."""
DETAIL_WINDOW = 7
"""Pixels of the box blur fine detail is measured against: a sharp reflection's edges."""
DETAIL_FULL = 0.05
PERCEIVED = 256
REAL_WORKERS = 2
REAL_HELD_EACH = 200
REAL_LAYER_BLUR = 1.0
BROAD_CELLS = 8
FLAT_LEVEL = 0.3
PRESENT_SHARE = 0.01
"""Of the photograph's light, the least a reflection holds for the colour and gain terms to count it."""
FAINT_FLOOR = 0.02
REFLECTED_SHARE = 0.15
"""Of a pixel's light, the reflection's share from which a drawn stroke may mark it as reflection."""
SCENE_OWNED = 0.2
SCENE_HELD = 0.3
STRUCTURE_REACH = 15
STROKES = 3
STROKE_RADIUS = (0.02, 0.08)
STROKE_LENGTH = 0.3
"""Stroke sizes, as shares of the crop's long side."""
STROKE_SOFTNESS = (0.05, 0.4)


def main() -> None:
    parser = arguments("Train the reflection remover.")
    parser.add_argument("--reflection-loss", type=float, default=0.5, help="weight of the coded reflection's L1")
    parser.add_argument("--edges", type=float, default=1.0, help="weight of the edge loss on the scene")
    parser.add_argument(
        "--overshoot", type=float, default=0.0, help="weight of the coded reflection's excess over the photograph"
    )
    parser.add_argument("--linear", type=float, default=0.0, help="weight of the reflection's L1 in linear light")
    parser.add_argument(
        "--colour",
        type=float,
        default=0.0,
        help=f"weight of the error in the reflection's chromaticity over {BROAD_CELLS}x{BROAD_CELLS} cells",
    )
    parser.add_argument("--colourful", type=float, default=0.0, help="share of reflections turned to a uniformly drawn hue")
    parser.add_argument(
        "--broad-colours", action="store_true", help="tint every veil, near reflection and glare to a uniformly drawn hue"
    )
    parser.add_argument(
        "--broad-levels", action="store_true", help="give every veil, near reflection and glare a milky veil's light"
    )
    parser.add_argument(
        "--near-subjects",
        action="store_true",
        help="make --subjects reflections faces, most as that person standing at the glass (needs dereflect.faces)",
    )
    parser.add_argument(
        "--scene-casts", action="store_true", help="tint a share of scenes whole to a uniformly drawn hue"
    )
    parser.add_argument(
        "--faint-broads", type=float, default=0.0, help="with --broad-colours, share of broad layers left grey or nearly"
    )
    parser.add_argument(
        "--green-broads", type=float, default=0.0, help="with --broad-colours, share of broad layers tinted green"
    )
    parser.add_argument(
        "--vents", type=float, default=0.0, help="share of far veils and whole glares gaining a dashboard vent along the bottom"
    )
    parser.add_argument(
        "--detail-weight",
        type=float,
        default=0.0,
        help="extra weight of the scene and reflection losses where a composite's reflection has fine detail",
    )
    parser.add_argument(
        "--gain", type=float, default=0.0, help="weight of each reflection's total light off the true total, squared"
    )
    parser.add_argument(
        "--faint", type=float, default=0.0, help="weight of the reflection's L1 relative to its own light, where present"
    )
    parser.add_argument(
        "--exclusion", type=float, default=0.0, help="weight of the loss on edges the scene and reflection share"
    )
    parser.add_argument(
        "--subjects", type=float, default=0.0, help="share of reflections that are whole frames with a subject in focus"
    )
    parser.add_argument(
        "--clipped", type=float, default=0.0, help="weight of the pixels where the photograph clipped, against 1 elsewhere"
    )
    parser.add_argument(
        "--structure", type=float, default=0.0, help="weight of the coded scene's structural dissimilarity, 1 - SSIM"
    )
    parser.add_argument("--perceptual", type=float, default=0.0, help="weight of VGG19's loss on the scene")
    parser.add_argument("--locating", type=float, default=0.0, help="weight of the loss on where reflection is")
    parser.add_argument(
        "--hints", type=float, default=0.0, help="share of samples given brush strokes drawn from their true reflection"
    )
    parser.add_argument(
        "--invariance",
        type=float,
        default=0.0,
        help="weight of the difference between the scene recovered from two reflections of it",
    )
    parser.add_argument("--real", type=Path, nargs="+", help="caches of real pairs `dereflect.real` prepared")
    parser.add_argument("--real-share", type=float, default=0.3, help="of steps with --real, the share on them")
    parser.add_argument("--crop", type=int, default=CROP, help=f"training crop side, a multiple of {MULTIPLE}")
    parser.add_argument(
        "--checkpoint", action="store_true", help="recompute each block's activations in the backward pass, for larger crops"
    )
    parser.add_argument("--validation-crop", type=int, default=CROP, help="side of the held-out crops")
    parser.add_argument("--start", type=Path, help="exported weights to fine-tune from, on a fresh --out")
    parser.add_argument(
        "--semantics", choices=sorted(dino.BACKBONES), help="DINOv2 backbone to read, instead of the one --start reads"
    )
    parser.set_defaults(cache=frames.DEFAULT_FRAMES, batch=4, steps=200_000, lr=2e-4, workers=4, prepare_workers=5)
    args = parser.parse_args()
    for side in (args.crop, args.validation_crop):
        if side % MULTIPLE:
            raise SystemExit(f"crop side {side} isn't a multiple of {MULTIPLE}")
    args.out.mkdir(parents=True, exist_ok=True)
    say = logger(args.out / "train.log")
    stop_on_signals()

    raws = sources(args.data)
    frames.prepare(raws, args.cache, args.prepare_workers)
    train_set = Pairs(args.cache, raws, False, args.colourful, args.crop, args.subjects, args.near_subjects)
    validation_set = Pairs(
        args.cache, raws, True, args.colourful, args.validation_crop, args.subjects, args.near_subjects
    )
    if len(train_set) < args.batch:
        raise SystemExit(f"{len(train_set)} sharp scenes under {args.cache}, fewer than a batch")
    device, bf16 = cuda()
    serve(args.out / ".scratch")
    say(
        f"{len(train_set)} scenes of {len(train_set.items)} training frames,"
        f" {len(validation_set)} of {len(validation_set.items)} held out, bf16={bf16}"
    )
    validation = held_out(validation_set, device, generator(args)) if len(validation_set) >= 2 else None
    real_batches, real_validation = None, None
    if args.real:
        real_set = ConcatDataset([RealPairs(cache, False, args.crop) for cache in args.real])
        if len(real_set) < args.batch:
            raise SystemExit(f"{len(real_set)} real pairs under {args.real}, fewer than a batch")
        real_batches = endless(loader(real_set, args.batch, REAL_WORKERS))
        held = ConcatDataset([spread(RealPairs(cache, True, args.validation_crop)) for cache in args.real])
        if len(held):
            mixed, clean, kept = (torch.stack(column) for column in zip(*(held[i] for i in range(len(held)))))
            real_validation = (mixed.half(), clean.half(), kept)
        say(f"{len(real_set)} real pairs to train on, {len(held)} held out")
    perceptual = vgg.load().to(device, memory_format=torch.channels_last) if args.perceptual else None
    absent = torch.full((), torch.nan, device=device)

    def given(light: torch.Tensor, hints: torch.Tensor | None) -> torch.Tensor:
        return torch.cat([stabilise(light), hints], 1) if hints is not None and args.hints else stabilise(light)

    @torch.no_grad()
    def glance(light: torch.Tensor, hints: torch.Tensor | None = None) -> torch.Tensor:
        """The network's coded reflection in linear `light`, eagerly and without grad."""
        with torch.autocast("cuda", dtype=torch.bfloat16, enabled=bf16):
            return net(given(light, hints).contiguous(memory_format=torch.channels_last)).float()[:, :3]

    def objective(
        forward: Forward,
        mixed: torch.Tensor,
        clean: torch.Tensor,
        kept: torch.Tensor,
        layer: torch.Tensor,
        twin: torch.Tensor,
        detail: torch.Tensor,
        hints: torch.Tensor,
    ) -> tuple[torch.Tensor, dict[str, torch.Tensor]]:
        # Set here, not at setup: `train` copies `net` into the average first, which must return 3 channels
        # for validation.
        net.locating = bool(args.locating)
        other = removing(twin, glance(twin)) if twin.numel() else None
        judged = torch.where(kept, 1.0, args.clipped)
        out = forward(given(mixed, hints))
        coded = out[:, :3]
        removed = removing(mixed, coded)
        weighed = judged * (1 + args.detail_weight * detail)
        terms = {
            "scene": weighted_mean((stabilise(removed) - stabilise(clean)).abs(), weighed),
            "reflection": weighted_mean((coded - stabilise(layer)).abs(), weighed),
        }
        if args.edges:
            terms["edges"] = edge_loss(stabilise(torch.where(judged > 0, removed, clean)), stabilise(clean))
        if args.overshoot:
            # `removing` clamps an excess to black, so the scene and edge losses get no gradient there.
            terms["overshoot"] = weighted_mean((coded - stabilise(mixed)).clamp(min=0), judged)
        if args.linear:
            terms["linear"] = weighted_mean((unstabilise(coded) - layer).abs(), judged)
        if args.colour:
            terms["colour"] = colour_error(unstabilise(coded), layer, judged, mixed)
        if args.gain:
            terms["gain"] = gain_error(unstabilise(coded), layer, judged, mixed)
        if args.faint:
            terms["faint"] = faint_error(unstabilise(coded), layer, judged, mixed)
        if args.exclusion:
            terms["exclusion"] = exclusion(stabilise(removed), coded)
        if args.structure:
            similarity = ssim_map(stabilise(removed).float(), stabilise(clean).float(), 1.0, STRUCTURE_WINDOW)
            reach = STRUCTURE_WINDOW // 2
            terms["structure"] = 1 - weighted_mean(similarity, judged[..., reach:-reach, reach:-reach])
        if perceptual is not None:
            side = min(PERCEIVED, *removed.shape[-2:])
            y = int(torch.randint(removed.shape[-2] - side + 1, ()))
            x = int(torch.randint(removed.shape[-1] - side + 1, ()))
            seen = (..., slice(y, y + side), slice(x, x + side))
            with torch.autocast("cuda", dtype=torch.bfloat16, enabled=bf16):
                terms["perceptual"] = perceptual(removed[seen], clean[seen]).float()
        if args.locating:
            there = (stabilise(layer).mean(1, keepdim=True) / PRESENCE_SCALE).clamp(0, 1)
            missed = F.binary_cross_entropy_with_logits(out[:, 3:], there, reduction="none")
            terms["locating"] = weighted_mean(missed, judged)
        if args.invariance:
            terms["invariance"] = absent
            # Brushed samples sit out: their strokes change the removal the unbrushed twin is held to.
            unbrushed = (hints.flatten(1).amax(1) == 0).to(removed.dtype)
            if other is not None:
                apart = (stabilise(removed) - stabilise(other)).abs().mean((1, 2, 3))
                terms["invariance"] = (apart * unbrushed).sum() / unbrushed.sum().clamp(min=1)
        weights = {
            "scene": 1.0,
            "reflection": args.reflection_loss,
            "edges": args.edges,
            "overshoot": args.overshoot,
            "linear": args.linear,
            "colour": args.colour,
            "gain": args.gain,
            "faint": args.faint,
            "exclusion": args.exclusion,
            "structure": args.structure,
            "perceptual": args.perceptual,
            "locating": args.locating,
            "invariance": args.invariance,
        }
        # A term this step has no use for logs as NaN, which the log's mean skips.
        loss = sum(weights[name] * term for name, term in terms.items() if term is not absent)
        return loss, terms

    def validate(forward: Forward, step: int) -> None:
        if validation is None:
            say(f"step {step}: no held-out frames to validate on")
            return
        say(f"step {step} validation: {measure(forward, validation, device)}")
        if real_validation is not None:
            removed, left = measure_real(forward, real_validation, device)
            say(f"step {step} real pairs: PSNR {removed:.3f} dB, left alone {left:.3f} dB")
        preview(forward, validation, device, args.out / "preview.png")

    net = load(args.start, BLOCKS, args.semantics) if args.start else LightRR(BLOCKS, args.semantics)
    for stage in net.modules():
        if isinstance(stage, Stage):
            stage.checkpointed = args.checkpoint
    plan = {
        "architecture": "lightrr",
        "dims": DIMS,
        "blocks": BLOCKS,
        "heads": HEADS,
        "semantics": net.backbone,
        "passes": 1,
        "hints": HINTS,
        "predicts": "reflection",
        "coding_floor": STABILISER_FLOOR,
        "white_quantile": frames.WHITE_QUANTILE,
        "edge": frames.EDGE,
    }
    tuned = (
        "steps", "batch", "lr", "lr_floor", "reflection_loss", "edges", "overshoot", "linear", "colour", "colourful",
        "broad_colours", "broad_levels", "near_subjects", "scene_casts", "faint_broads", "green_broads", "vents", "detail_weight", "gain", "faint", "exclusion",
        "clipped", "structure", "perceptual", "locating", "hints", "invariance", "real_share", "crop", "subjects",
    )  # fmt: skip
    settings: dict[str, object] = {name: getattr(args, name) for name in tuned}
    settings["start"] = args.start and str(args.start)
    settings["real"] = args.real and [str(cache) for cache in args.real]
    settings["semantics"] = net.backbone
    train(
        net.to(device, memory_format=torch.channels_last),
        prepared(endless(loader(train_set, args.batch, args.workers)), real_batches, args, device),
        objective,
        validate,
        steps=args.steps,
        keep_every=args.keep_every,
        lr=args.lr,
        lr_floor=args.lr_floor,
        bf16=bf16,
        settings=settings,
        plan=plan,
        out=args.out,
        say=say,
    )


def endless(batches: Iterable[list[torch.Tensor]]) -> Iterator[list[torch.Tensor]]:
    while True:
        yield from batches


class Prepared(NamedTuple):
    mixed: torch.Tensor
    clean: torch.Tensor
    kept: torch.Tensor
    layer: torch.Tensor
    """What has to come out: the reflection wherever nothing clipped, and where something did, the
    difference clipping made."""
    twin: torch.Tensor
    """The photograph through the same glass with the reflection mirrored, or empty."""
    detail: torch.Tensor
    """(B, 1, H, W) `detail_map` of a composite's reflection; 0 for real pairs, whose layer holds misalignment."""
    hints: torch.Tensor
    """(B, `HINTS`, H, W) `brushed` strokes, or zeros."""


def prepared(
    pairs: Iterator[list[torch.Tensor]],
    real: Iterator[list[torch.Tensor]] | None,
    args: argparse.Namespace,
    device: torch.device,
) -> Iterator[Prepared]:
    """Each step's batch, a `--real-share` of them real pairs, the rest composites of `pairs`."""
    developer = ThreadPoolExecutor(1)

    def start() -> tuple[list[torch.Tensor] | Pending, Pending | None]:
        if real is not None and float(torch.rand(())) < args.real_share:
            return next(real), None
        pair = [tensor.to(device, non_blocking=True) for tensor in next(pairs)]
        drawn_from = torch.get_rng_state()
        broad = generator(args)
        pending = started(*pair, developer=developer, **broad)
        if not args.invariance:
            return pending, None
        scene, reflected, *rest = pair
        with torch.random.fork_rng(devices=[]):
            torch.set_rng_state(drawn_from)
            return pending, started(
                scene,
                reflected.flip(-1),
                *rest,
                cleaned=False,
                developer=developer,
                metered=pending.metered,
                **broad,
            )

    def finish(begun: list[torch.Tensor] | Pending, twin: Pending | None) -> Prepared:
        nothing = torch.empty(0, device=device)
        if not isinstance(begun, Pending):
            mixed, clean, kept = (tensor.to(device, non_blocking=True) for tensor in begun)
            # Low-passed: a real pair's difference also holds the edges of slight misalignment.
            spread = torch.full((mixed.shape[0],), REAL_LAYER_BLUR, device=device)
            none = torch.zeros_like(kept, dtype=mixed.dtype)
            layer = blurred((mixed - clean).clamp(min=0), spread)
            return Prepared(mixed, clean, kept, layer, nothing, none, brushed(layer, mixed, args.hints))
        made = finished(begun)
        mirrored = finished(twin, made.scale).mixed if twin is not None else nothing
        layer = made.mixed - made.clean
        return Prepared(
            made.mixed, made.clean, made.kept, layer, mirrored, detail_map(made.layer, made.mixed),
            brushed(made.layer, made.mixed, args.hints),
        )  # fmt: skip

    waiting = start()
    while True:
        begun = start()
        yield finish(*waiting)
        waiting = begun


def spread(pairs: RealPairs) -> Dataset:
    """At most `REAL_HELD_EACH` of `pairs`, evenly spaced, so no one set outweighs the rest."""
    return Subset(pairs, np.linspace(0, len(pairs) - 1, min(REAL_HELD_EACH, len(pairs))).round().astype(int).tolist())


@torch.no_grad()
def measure_real(
    forward: Forward, pairs: tuple[torch.Tensor, torch.Tensor, torch.Tensor], device: torch.device
) -> tuple[float, float]:
    """PSNR in coded light of the removal, and of the photograph left alone, over the real pairs."""
    parts = []
    for start in range(0, len(pairs[0]), VALIDATION_CHUNK):
        mixed, clean, kept = (field[start : start + VALIDATION_CHUNK].to(device) for field in pairs)
        mixed, clean = mixed.float(), clean.float()
        removed = removing(mixed, forward(stabilise(mixed)))
        parts.append((*squared_errors(removed, clean, kept), *squared_errors(mixed, clean, kept)))
    sums, counts, left_sums, left_counts = (torch.cat(column).cpu() for column in zip(*parts))
    return pooled(sums, counts), pooled(left_sums, left_counts)


def weighted_mean(values: torch.Tensor, weight: torch.Tensor) -> torch.Tensor:
    """The mean of (B, C, H, W) `values` with each pixel weighted by (B, 1, H, W) `weight`."""
    weight = weight.to(values.dtype)
    return (values * weight).sum() / (weight.sum() * values.shape[1]).clamp(min=1)


def colour_error(predicted: torch.Tensor, true: torch.Tensor, weight: torch.Tensor, photo: torch.Tensor) -> torch.Tensor:
    """The (B, 3, H, W) predicted reflection's light off the true reflection's chromaticity, at its own
    amount, averaged over `BROAD_CELLS` cells a side and weighted by (B, 1, H, W) `weight`, as a share of the
    photograph's light, over the cells where the true reflection holds light."""
    weight = weight.to(predicted.dtype)
    cover = F.adaptive_avg_pool2d(weight, BROAD_CELLS).clamp(min=1e-6)
    cells = [F.adaptive_avg_pool2d(light * weight, BROAD_CELLS) / cover for light in (predicted, true, photo)]
    sums = [cell.sum(1, keepdim=True) for cell in cells]
    hue = (cells[1] / sums[1].clamp(min=1e-6)).detach()
    # Never divided by the prediction: a near-empty one's chromaticity has gradients of 1 over its own light,
    # which holds the network at removing nothing.
    off = (cells[0] - hue * sums[0]).abs().sum(1, keepdim=True)
    present = (sums[1] > PRESENT_SHARE * sums[2]).to(predicted.dtype).detach()
    return (off * present).sum() / (sums[2] * present).sum().clamp(min=1e-6)


def gain_error(predicted: torch.Tensor, true: torch.Tensor, weight: torch.Tensor, photo: torch.Tensor) -> torch.Tensor:
    """Each (B, 3, H, W) predicted reflection's total light off the true total, as a share of the true, squared,
    over the photographs whose reflection holds light: an amount too small or too large, whatever its shape."""
    weight = weight.to(predicted.dtype)
    sums = [(light * weight).sum((1, 2, 3)) for light in (predicted, true, photo)]
    present = (sums[1] > PRESENT_SHARE * sums[2]).detach()
    # Over the true total, never the predicted: a near-empty prediction would get gradients of 1 over itself.
    off = (sums[0] - sums[1]) / torch.where(present, sums[1], 1.0).detach()
    return torch.where(present, off**2, 0.0).sum() / present.sum().clamp(min=1)


def faint_error(predicted: torch.Tensor, true: torch.Tensor, weight: torch.Tensor, photo: torch.Tensor) -> torch.Tensor:
    """L1 of (B, 3, H, W) reflection light over the true reflection's own light, where it holds at least
    `FAINT_FLOOR` of the photograph's, capped at 1."""
    floor = FAINT_FLOOR * photo.mean(1, keepdim=True)
    held = true.mean(1, keepdim=True)
    # Only where reflection is: elsewhere 1 over the floor would weigh every false trace heavily and teach timidity.
    present = held > floor
    relative = (predicted - true).abs() / torch.where(present, held + floor, 1.0).detach()
    return weighted_mean(torch.where(present, relative.clamp(max=1), 0.0), present * weight)


def exclusion(scene: torch.Tensor, reflection: torch.Tensor) -> torch.Tensor:
    """How much the edges of two coded (B, C, H, W) layers coincide, over `EXCLUSION_LEVELS` scales: Zhang,
    Ng and Chen's exclusion loss (CVPR 2018)."""
    total = scene.new_zeros(())
    for level in range(EXCLUSION_LEVELS):
        if level:
            scene, reflection = F.avg_pool2d(scene, 2), F.avg_pool2d(reflection, 2)
        for dim in (-1, -2):
            ours, theirs = scene.diff(dim=dim), reflection.diff(dim=dim)
            # Matches the layers' edge magnitudes, so a faint reflection's edges count as much as the scene's.
            balance = (2 * ours.abs().mean((1, 2, 3), True) / theirs.abs().mean((1, 2, 3), True).clamp(min=1e-4)).detach()
            product = (torch.sigmoid(ours) * 2 - 1) ** 2 * (torch.sigmoid(theirs * balance.clamp(max=10)) * 2 - 1) ** 2
            # pow(0.25)'s gradient is infinite at 0, where a pair without a reflection sits.
            total = total + product.mean((1, 2, 3)).clamp(min=1e-12).pow(0.25).mean()
    return total / (2 * EXCLUSION_LEVELS)


class Validation(NamedTuple):
    """On the CPU: `measure` and `preview` take it to the device a chunk at a time."""

    mixed: torch.Tensor
    scene: torch.Tensor
    layer: torch.Tensor
    kept: torch.Tensor
    clean: torch.Tensor
    """The scenes alone, clipped as their sensor would: photos taken through no glass."""
    present: torch.Tensor
    """(B,) the pairs with a reflection: the groups below but `soft` hold only these."""
    strong: torch.Tensor
    """(B,) the half of those whose reflection is strongest against its scene."""
    vivid: torch.Tensor
    """(B,) the half of those whose reflection is most saturated."""
    soft: torch.Tensor
    """(B,) the pairs whose scene is blurred, with a reflection or not."""
    sharp: torch.Tensor
    """(B,) the pairs whose reflection is blurred by less than a pixel."""
    veiled: torch.Tensor
    """(B,) the pairs whose reflection is a veil."""
    glared: torch.Tensor
    """(B,) the pairs with a glare."""
    flat: torch.Tensor
    """(B,) the veils and glares at `FLAT_LEVEL` of their scene's median light or more."""


class Scores(NamedTuple):
    removed: float
    strong: float
    faint: float
    vivid: float
    dull: float
    soft: float
    sharp: float
    veiled: float
    glared: float
    flat: float
    untouched: float
    clean: float
    clean_soft: float
    clipped: float
    over: float
    hue: float
    gain: float
    flat_gain: float
    amount: float
    flat_amount: float
    detail: float
    """Of the reflections' fine detail, the share the prediction holds."""
    sharp_detail: float
    clean_detail: float
    """Of photos without glass, the share of their fine detail predicted as reflection: what removal would wrongly take."""

    def __str__(self) -> str:
        return (
            f"PSNR {self.removed:.3f} dB (strong {self.strong:.2f}, faint {self.faint:.2f}, vivid {self.vivid:.2f},"
            f" dull {self.dull:.2f}, soft scenes {self.soft:.2f}, sharp reflections {self.sharp:.2f},"
            f" veils {self.veiled:.2f}, glare {self.glared:.2f}, strong flat {self.flat:.2f}), left alone"
            f" {self.untouched:.3f} dB, photos without glass kept to {self.clean:.3f} dB (soft {self.clean_soft:.2f}),"
            f" where clipped {self.clipped:.2f} dB, {self.over * 100:.2f}% over-subtracted, reflection hue off by"
            f" {self.hue:.2f}°, reflection predicted at {self.gain:.3f}x (strong flat {self.flat_gain:.3f}x), its"
            f" total light at {self.amount:.3f}x (strong flat {self.flat_amount:.3f}x), fine detail taken"
            f" {self.detail:.3f} (sharp reflections {self.sharp_detail:.3f}, photos without glass {self.clean_detail:.3f})"
        )


def generator(args: argparse.Namespace) -> dict[str, bool | float]:
    """`started`'s options as training draws composites, so validation draws its held-out ones the same way."""
    return {
        "broad_colours": args.broad_colours,
        "broad_levels": args.broad_levels,
        "near_subjects": args.near_subjects,
        "scene_casts": args.scene_casts,
        "faint_broads": args.faint_broads,
        "green_broads": args.green_broads,
        "vent_share": args.vents,
    }


def held_out(pairs: Pairs, device: torch.device, broad: dict[str, bool | float]) -> Validation:
    count = len(pairs)
    first = np.linspace(0, count - 1, min(FIRST_PAIRS, count)).astype(int).tolist()
    in_first = set(first)
    rest = [i for i in np.linspace(0, count - 1, min(VALIDATION_PAIRS, count)).astype(int).tolist() if i not in in_first]
    groups = [composited(pairs, chosen, seed, device, broad) for seed, chosen in enumerate((first, rest)) if chosen]
    mixed, scene, clean, layer, kept, scene_blur, reflection_blur, veiled, glared, _ = (
        torch.cat(parts) for parts in zip(*groups)
    )
    del groups
    present = layer.flatten(1).amax(1) > 0
    strength = layer.mean((1, 2, 3)) / scene.mean((1, 2, 3)).clamp(min=1e-6)
    saturation = (layer.amax(1) - layer.amin(1)).sum((1, 2)) / layer.mean(1).sum((1, 2)).clamp(min=1e-6)
    strong = present & (strength >= strength[present].median())
    vivid = present & (saturation >= saturation[present].median())
    level = layer.mean((1, 2, 3)) / scene.mean(1).flatten(1).median(1).values.clamp(min=1e-6)
    flat = (veiled | glared) & (level >= FLAT_LEVEL)
    fields = (
        mixed, scene, layer, kept, clean, present, strong, vivid, scene_blur > 0, present & (reflection_blur < 1),
        veiled, glared, flat,
    )  # fmt: skip
    return Validation(*(field.cpu() for field in fields))


def composited(
    pairs: Pairs, chosen: list[int], seed: int, device: torch.device, broad: dict[str, bool | float]
) -> Composite:
    """The composites of the pairs `chosen`, drawn as `started` draws them with `broad`."""
    pair = (torch.stack(batch).to(device) for batch in zip(*(pairs[i] for i in chosen)))
    with torch.random.fork_rng(devices=[]):
        torch.manual_seed(seed)
        return finished(started(*pair, **broad))


@torch.no_grad()
def measure(forward: Forward, validation: Validation, device: torch.device) -> Scores:
    parts = []
    for start in range(0, len(validation.mixed), VALIDATION_CHUNK):
        mixed, scene, layer, kept, clean = (
            field[start : start + VALIDATION_CHUNK].to(device)
            for field in (validation.mixed, validation.scene, validation.layer, validation.kept, validation.clean)
        )
        coded = forward(stabilise(mixed))
        removed = removing(mixed, coded)
        predicted = unstabilise(coded).clamp(min=0)
        over = (coded > stabilise(mixed)).any(1, keepdim=True) & kept
        light = layer.mean(1, keepdim=True) * kept
        coded_clean = forward(stabilise(clean))
        wanted, seen = fine(layer) * kept, fine(clean)
        parts.append(
            (
                *squared_errors(removed, scene, kept),
                *squared_errors(mixed, scene, kept),
                *squared_errors(removing(clean, coded_clean), clean, torch.ones_like(kept)),
                *squared_errors(removed, clean, ~kept),
                over.sum((1, 2, 3)).float(),
                kept.sum((1, 2, 3)).float(),
                (hue_angles(predicted, layer) * light).sum((1, 2, 3)),
                light.sum((1, 2, 3)),
                (predicted * layer * kept).sum((1, 2, 3)),
                (layer * layer * kept).sum((1, 2, 3)),
                (predicted * kept).sum((1, 2, 3)),
                (layer * kept).sum((1, 2, 3)),
                (fine(predicted) * wanted).sum((1, 2, 3)),
                (wanted * wanted).sum((1, 2, 3)),
                (fine(unstabilise(coded_clean).clamp(min=0)) * seen).sum((1, 2, 3)),
                (seen * seen).sum((1, 2, 3)),
            )
        )
    (
        sums, counts, left_sums, left_counts, clean_sums, clean_counts, clipped_sums, clipped_counts,
        over, kept_count, hue, weight, matched, energy, predicted_light, true_light,
        detail_taken, detail, clean_detail_taken, clean_detail,
    ) = (torch.cat(column).cpu() for column in zip(*parts))  # fmt: skip
    present = validation.present
    return Scores(
        removed=pooled(sums, counts),
        strong=pooled(sums, counts, validation.strong),
        faint=pooled(sums, counts, present & ~validation.strong),
        vivid=pooled(sums, counts, validation.vivid),
        dull=pooled(sums, counts, present & ~validation.vivid),
        soft=pooled(sums, counts, present & validation.soft),
        sharp=pooled(sums, counts, validation.sharp),
        veiled=pooled(sums, counts, validation.veiled),
        glared=pooled(sums, counts, validation.glared),
        flat=pooled(sums, counts, validation.flat),
        untouched=pooled(left_sums, left_counts),
        clean=pooled(clean_sums, clean_counts),
        clean_soft=pooled(clean_sums, clean_counts, validation.soft),
        clipped=pooled(clipped_sums, clipped_counts),
        over=float(over.sum() / kept_count.sum().clamp(min=1)),
        hue=float(hue.sum() / weight.sum().clamp(min=1e-8)),
        gain=float(matched[present].sum() / energy[present].sum().clamp(min=1e-12)),
        flat_gain=float(matched[validation.flat].sum() / energy[validation.flat].sum().clamp(min=1e-12)),
        amount=float(predicted_light[present].sum() / true_light[present].sum().clamp(min=1e-12)),
        flat_amount=float(predicted_light[validation.flat].sum() / true_light[validation.flat].sum().clamp(min=1e-12)),
        detail=float(detail_taken[present].sum() / detail[present].sum().clamp(min=1e-12)),
        sharp_detail=float(detail_taken[validation.sharp].sum() / detail[validation.sharp].sum().clamp(min=1e-12)),
        clean_detail=float(clean_detail_taken.sum() / clean_detail.sum().clamp(min=1e-12)),
    )


@torch.no_grad()
def reflections(forward: Forward, given: torch.Tensor, device: torch.device) -> torch.Tensor:
    return torch.cat([forward(stabilise(chunk.to(device))).cpu() for chunk in given.split(VALIDATION_CHUNK)])


def fine(light: torch.Tensor) -> torch.Tensor:
    """(B, C, H, W) light less its `DETAIL_WINDOW` box blur."""
    reach = DETAIL_WINDOW // 2
    return light - F.avg_pool2d(light, DETAIL_WINDOW, 1, reach, count_include_pad=False)


def detail_map(layer: torch.Tensor, photo: torch.Tensor) -> torch.Tensor:
    """(B, 1, H, W) where a (B, 3, H, W) reflection has fine detail, 1 from `DETAIL_FULL` of its photo's mean light."""
    detail = fine(layer.mean(1, keepdim=True)).abs()
    return (detail / (DETAIL_FULL * photo.mean((1, 2, 3), keepdim=True)).clamp(min=1e-9)).clamp(max=1)


def brushed(layer: torch.Tensor, photo: torch.Tensor, share: float) -> torch.Tensor:
    """(B, `HINTS`, H, W) strokes drawn as a user would brush them, for a `share` of the (B, 3, H, W)
    photographs: reflection strokes over the true reflection `layer`, keep strokes over the scene."""
    batch, _, height, width = layer.shape
    strokes = torch.zeros(batch, HINTS, height, width, device=layer.device)
    if share <= 0:
        # Before any draw: the composites' own draws come from the same generator.
        return strokes
    side = max(height, width)
    rows = torch.arange(height, device=layer.device, dtype=torch.float32)[:, None]
    columns = torch.arange(width, device=layer.device, dtype=torch.float32)[None, :]
    held = layer.mean(1) / photo.mean(1).clamp(min=1e-6)
    scene, reflected = (
        F.avg_pool2d(fine(light.mean(1, keepdim=True)).abs(), STRUCTURE_REACH, 1, STRUCTURE_REACH // 2)[:, 0]
        for light in (photo, layer)
    )
    structure = (reflected < SCENE_OWNED * scene) * scene
    nearby = F.avg_pool2d(held[:, None], STRUCTURE_REACH, 1, STRUCTURE_REACH // 2)[:, 0]
    smooth = (nearby < SCENE_HELD) * photo.mean(1)
    owned = sum(map_ / map_.flatten(1).amax(1).clamp(min=1e-9)[:, None, None] for map_ in (structure, smooth))
    # A real pair's difference in near-black pixels is noise, a large share of almost no light.
    visible = layer.mean(1) >= FAINT_FLOOR * photo.mean((1, 2, 3))[:, None, None]
    reflected_room = (held >= REFLECTED_SHARE) & visible
    for index in range(batch):
        if float(torch.rand(())) >= share:
            continue
        for kind, room in ((0, reflected_room[index]), (1, owned[index])):
            if not room.any():
                continue
            for _ in range(int(torch.randint(STROKES + 1, ()))):
                start = int(torch.multinomial(room.flatten().float(), 1))
                y0, x0 = divmod(start, width)
                radius = float(torch.empty(()).uniform_(*STROKE_RADIUS)) * side
                length = float(torch.rand(())) * STROKE_LENGTH * side
                angle = float(torch.rand(())) * 2 * torch.pi
                y1, x1 = y0 + length * np.sin(angle), x0 + length * np.cos(angle)
                along = ((rows - y0) * (y1 - y0) + (columns - x0) * (x1 - x0)) / max(length**2, 1e-6)
                along = along.clamp(0, 1)
                distance = ((rows - y0 - along * (y1 - y0)) ** 2 + (columns - x0 - along * (x1 - x0)) ** 2).sqrt()
                reach = 2 * int(radius) + 1
                near = F.max_pool2d((room > 0).float()[None, None], reach, 1, reach // 2)[0, 0]
                softness = float(torch.empty(()).uniform_(*STROKE_SOFTNESS)) * radius
                stroke = torch.sigmoid((radius - distance) / softness) * near
                strokes[index, kind] = torch.maximum(strokes[index, kind], stroke)
    return strokes


def squared_errors(
    predicted: torch.Tensor, wanted: torch.Tensor, kept: torch.Tensor
) -> tuple[torch.Tensor, torch.Tensor]:
    """Each pair's summed squared error in coded light over its kept values, and how many those are."""
    weight = kept.to(predicted.dtype)
    error = (stabilise(predicted) - stabilise(wanted)) ** 2 * weight
    return error.sum((1, 2, 3)), weight.sum((1, 2, 3)) * predicted.shape[1]


def pooled(sums: torch.Tensor, counts: torch.Tensor, among: torch.Tensor | None = None) -> float:
    if among is not None:
        sums, counts = sums[among], counts[among]
    return psnr(sums.sum() / counts.sum().clamp(min=1))


def hue_angles(predicted: torch.Tensor, layer: torch.Tensor) -> torch.Tensor:
    """(B, 1, H, W) angle in degrees between the predicted and true reflection's colours in linear light."""
    cosine = (predicted * layer).sum(1, keepdim=True) / (
        predicted.norm(dim=1, keepdim=True) * layer.norm(dim=1, keepdim=True)
    ).clamp(min=1e-8)
    return torch.rad2deg(torch.acos(cosine.clamp(-1, 1)))


@torch.no_grad()
def preview(forward: Forward, validation: Validation, device: torch.device, path: Path) -> None:
    """The first held-out photographs, a row each: through glass, after the removal, the scene alone,
    and the reflection removed."""
    mixed = validation.mixed[:PREVIEWED]
    removed = removing(mixed, reflections(forward, mixed, device))
    rows = [
        panels([image[None].float().cpu() for image in (given, out, wanted, given - out)], 1.0)
        for given, out, wanted in zip(mixed, removed, validation.scene[:PREVIEWED])
    ]
    gap = np.full((8, rows[0].shape[1], 3), 255, np.uint8)
    write_png(path, np.concatenate([part for row in rows for part in (row, gap)][:-1], 0))


if __name__ == "__main__":
    main()
