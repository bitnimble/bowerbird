"""RAWs with their reflections taken out by trained weights, at full resolution: the network looks at the
library's decode shrunk to `frames.EDGE`, the scale it trained at, and its reflection, scaled up in
linear light, comes out of the full-resolution decode.

Writes, per RAW, `<stem>.png`: the photograph, without the reflection, and what came out, side by side
at `OVERVIEW` wide; `<stem>-crop-N.png`: the same three at 1:1, where the most light came out or at
each `--crop`; and with `--full`, `<stem>-glass.png` and `<stem>-removed.png` at full resolution to
flip between. Each is graded as the library renders the photo unedited, all three under the photo's
own grade: HDR as 16-bit PQ, with an SDR copy beside it as `-sdr`.

    uv run python -m dereflect.remove <raw>... --weights <folder> [--out runs/removed]
        [--crop x,y,side ...] [--crops 3] [--full] [--warmth 0.1] [--strength 1.5]
"""

import argparse
import time
from collections.abc import Callable
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

from dereflect.frames import planar, shrunk, white
from dereflect.model import MULTIPLE, load, removing
from training.mosaic import stabilise, unstabilise
from training.pmrid import Pmrid, Unreadable, serve
from training.preview import GAP, REC2020_TO_SRGB, write_png, write_pq_png

FULL_RESOLUTION = 1 << 20
OVERVIEW = 1200
CROP_SIDE = 420
LUMA2020 = torch.tensor([0.2627, 0.6780, 0.0593])


def main() -> None:
    parser = argparse.ArgumentParser(description="Take the reflections out of RAWs at full resolution.")
    parser.add_argument("raws", type=Path, nargs="+")
    parser.add_argument("--weights", type=Path, required=True, help="folder of weights.json and .bin")
    parser.add_argument("--out", type=Path, default=Path("runs/removed"))
    parser.add_argument("--crop", action="append", default=[], help="x,y,side of a 1:1 crop, in full-resolution pixels")
    parser.add_argument("--crops", type=int, default=3, help="1:1 crops where the most light came out")
    parser.add_argument("--full", action="store_true", help="also write the photograph and the result at full resolution")
    parser.add_argument(
        "--warmth",
        type=float,
        default=0.0,
        help="turn the reflection towards red (above 0) or blue (below) before it comes out, at the same luma",
    )
    parser.add_argument("--strength", type=float, default=1.0, help="share of the reflection taken out, past 1 for more")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    net = load(args.weights).cuda().eval()
    # First looks autotune cuDNN, which would land in the first photo's timing.
    for _ in range(2):
        predicted(net, torch.full((3, 672, 1024), 0.5, device="cuda"))
    server = serve(args.out / ".scratch")
    for raw in args.raws:
        try:
            decoded = planar(server.decode(raw, FULL_RESOLUTION))
        except Unreadable as error:
            print(f"skipped {raw}: {error}")
            continue
        looked = shrunk(decoded)
        light = white(looked)
        if light <= 0:
            print(f"skipped {raw}: black")
            continue
        photo = (decoded / light).cuda()
        started = time.perf_counter()
        reflection = warmed(predicted(net, (looked / light).cuda()), args.warmth) * args.strength
        torch.cuda.synchronize()
        looking = time.perf_counter() - started
        reflection = scaled_up(reflection, photo.shape[1:])
        removed = removing(photo[None], stabilise(reflection))[0]
        torch.cuda.synchronize()
        took = time.perf_counter() - started
        height, width = photo.shape[1:]
        print(f"{raw.name}: {width}x{height}, looked at {looked.shape[2]}x{looked.shape[1]} in {looking * 1000:.0f} ms, removed in {took * 1000:.0f} ms")
        taken = (reflection[0] * light.to(reflection.device)).permute(1, 2, 0).cpu().numpy()
        windows = [tuple(int(v) for v in crop.split(",")) for crop in args.crop] + brightest(photo - removed, args.crops)
        del photo, reflection, removed
        # The grade runs on the same device through Vulkan, which can't use what torch holds cached.
        torch.cuda.empty_cache()
        write_outputs(args, server, raw, taken, windows)


def predicted(net: torch.nn.Module, image: torch.Tensor) -> torch.Tensor:
    """(3, h, w) linear light's reflection, as (1, 3, h, w) linear light."""
    height, width = image.shape[1:]
    padded = F.pad(image[None], (0, -width % MULTIPLE, 0, -height % MULTIPLE), mode="replicate")
    with torch.no_grad(), torch.autocast("cuda", dtype=torch.bfloat16):
        coded = net(stabilise(padded)).float()[:, :3, :height, :width]
    return unstabilise(coded).clamp(min=0)


def warmed(reflection: torch.Tensor, warmth: float) -> torch.Tensor:
    """(B, 3, H, W) Rec.2020 light with red gained by 1 + `warmth` and blue by 1 - `warmth`, at the same luma."""
    gains = torch.tensor([1 + warmth, 1.0, 1 - warmth], device=reflection.device)
    gains = gains / (LUMA2020.to(reflection.device) @ gains)
    return (reflection * gains[None, :, None, None]).clamp(min=0)


def scaled_up(reflection: torch.Tensor, size: torch.Size) -> torch.Tensor:
    return F.interpolate(reflection, size=tuple(size), mode="bilinear", align_corners=False).clamp(min=0)


def write_outputs(
    args: argparse.Namespace, server: Pmrid, raw: Path, taken: np.ndarray, windows: list[tuple[int, ...]]
) -> None:
    """`taken` is the reflection in the decode's units, (H, W, 3)."""
    writers: list[tuple[bool, str, Callable[[Path, np.ndarray], None]]] = [(True, "", write_pq_png), (False, "-sdr", write_png)]
    for pq, suffix, write in writers:
        write(args.out / f"{raw.stem}{suffix}.png", side_by_side(graded(server, raw, taken, pq, OVERVIEW // 3)))
        if not windows and not args.full:
            continue
        photo, removed, out = graded(server, raw, taken, pq, None)
        height, width = photo.shape[:2]
        for n, (x, y, side) in enumerate(windows, 1):
            # The grade's lens warp moves a pixel a few from where the decode put it.
            x, y = min(max(0, x), width - side), min(max(0, y), height - side)
            write(args.out / f"{raw.stem}-crop-{n}{suffix}.png", side_by_side([i[y : y + side, x : x + side] for i in (photo, removed, out)]))
            if pq:
                print(f"  crop {n} at {x},{y}, side {side}")
        if args.full:
            write(args.out / f"{raw.stem}-glass{suffix}.png", photo)
            write(args.out / f"{raw.stem}-removed{suffix}.png", removed)
    print(f"  wrote {args.out / raw.stem}*.png")


def graded(server: Pmrid, raw: Path, taken: np.ndarray, pq: bool, edge: int | None) -> list[np.ndarray]:
    """The photograph, without `taken`, and `taken` alone, each (H, W, 3) codes under the photo's grade."""
    photo, removed = server.grade(raw, FULL_RESOLUTION, pq, edge, taken, [0.0, 1.0])
    return [photo, removed, server.grade(raw, FULL_RESOLUTION, pq, edge, taken, [1.0], alone=True)[0]]


def side_by_side(images: list[np.ndarray]) -> np.ndarray:
    gap = np.zeros((images[0].shape[0], GAP, 3), images[0].dtype)
    return np.concatenate([part for image in images for part in (image, gap)][:-1], 1)


def brightest(taken: torch.Tensor, count: int) -> list[tuple[int, ...]]:
    """Up to `count` non-overlapping `CROP_SIDE` windows holding the most light taken out."""
    energy = F.avg_pool2d(taken.mean(0, keepdim=True)[None], CROP_SIDE, stride=CROP_SIDE // 2)[0, 0]
    windows: list[tuple[int, ...]] = []
    for flat in energy.flatten().argsort(descending=True).tolist():
        if len(windows) == count:
            break
        y, x = divmod(flat, energy.shape[1])
        x, y = x * CROP_SIDE // 2, y * CROP_SIDE // 2
        if all(abs(x - wx) >= CROP_SIDE or abs(y - wy) >= CROP_SIDE for wx, wy, _ in windows):
            windows.append((x, y, CROP_SIDE))
    return windows


def shown_light(rec2020: torch.Tensor) -> torch.Tensor:
    """(1, 3, H, W) Rec.2020 light as linear sRGB, for `panels` and `srgb`."""
    return torch.einsum("ij,bjhw->bihw", REC2020_TO_SRGB, rec2020)


if __name__ == "__main__":
    main()
