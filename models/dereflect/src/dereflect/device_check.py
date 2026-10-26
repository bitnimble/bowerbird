"""The device's reflection remover (`native/rawshim/src/dereflect.rs`, `slang/dereflect.slang`,
`slang/dereflect_frame.slang`) held against torch on one cached frame, brushed: the network alone,
then the whole stage over a frame twice the network's size.

    uv run python -m dereflect.device_check <record stem> <bundle dir> [--cache dir]

The bundle is what `dereflect.bundle` writes.
"""

import argparse
import json
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

from dereflect.frames import DEFAULT_FRAMES, frame_of, shrunk, white
from dereflect.model import MULTIPLE, LightRR, load
from training.metrics import psnr
from training.mosaic import stabilise, unstabilise
from training.pmrid import REPOSITORY, example_environment

EXAMPLE = REPOSITORY / "native" / "rawshim" / "target" / "quick" / "examples" / "dereflect"
BUILD = "bun run scripts/cargo.ts build --profile quick --manifest-path native/rawshim/Cargo.toml --example dereflect"
AGREEMENT_DB = 80.0
STAGE_AGREEMENT_DB = 60.0
"""Against the frame's white: the device's shrink and white quantile are its own."""
STORED_LONG = 65535
BRUSH_SOFTNESS = 0.2
STROKES = [
    {"kind": "remove", "radius": 3000, "points": [[18000, 20000], [24000, 21000]]},
    {"kind": "keep", "radius": 2000, "points": [[45000, 22000]]},
]


def main() -> None:
    if not EXAMPLE.exists():
        raise SystemExit(f"{EXAMPLE} is missing; build it from {REPOSITORY} with `{BUILD}`")
    parser = argparse.ArgumentParser(description="Hold the device's reflection remover against torch.")
    parser.add_argument("stem", help="a record under the frame cache")
    parser.add_argument("weights", type=Path)
    parser.add_argument("--cache", type=Path, default=DEFAULT_FRAMES)
    args = parser.parse_args()
    record_path = args.cache / f"{args.stem}.json"
    record = json.loads(record_path.read_text())
    frame = torch.from_numpy(frame_of(record_path, record).astype(np.float32))
    bundle = args.weights.resolve()
    net = load(bundle).cuda().eval()
    failed = [name for name, check in (("network", network), ("stage", stage)) if not check(net, frame, record, bundle)]
    if failed:
        raise SystemExit(f"the device disagrees with torch: {', '.join(failed)}")


def network(net: LightRR, frame: torch.Tensor, record: dict, bundle: Path) -> bool:
    height, width = (side // MULTIPLE * MULTIPLE for side in frame.shape[1:])
    coded = torch.cat([stabilise(frame[:, :height, :width] / record["white"]), brushed(height, width)])
    with torch.no_grad():
        reference = net(coded[None].cuda())[0].cpu()
    device = run("net", bundle, coded, width, height, reference.shape)
    error = device - reference
    agreement = psnr(error.pow(2).mean())
    print(
        f"network, {width}x{height}: max |error| {float(error.abs().max()):.2e} of a reflection up to"
        f" {float(reference.abs().max()):.3f}, PSNR {agreement:.1f} dB"
    )
    return agreement >= AGREEMENT_DB


def stage(net: LightRR, frame: torch.Tensor, record: dict, bundle: Path) -> bool:
    """`remove.py`'s stage, the network in full precision, over the frame enlarged twice so the
    device shrinks it and enlarges the reflection back. Each pixel repeated, so the shrink gives
    the frame back: a blurred frame reads as a reflection everywhere, where the network is unstable."""
    full = frame.repeat_interleave(2, 1).repeat_interleave(2, 2).half().float()
    height, width = full.shape[1:]
    looked = shrunk(full)
    light = white(looked)
    rows, columns = looked.shape[1:]
    padded = F.pad(looked[None] / light, (0, -columns % MULTIPLE, 0, -rows % MULTIPLE), mode="replicate")[0]
    hints = painted(STROKES, padded.shape[1:], columns, max(width, height), width)
    with torch.no_grad():
        coded = net(torch.cat([stabilise(padded), hints])[None].cuda())[0, :3, :rows, :columns].cpu()
    reflection = F.interpolate(unstabilise(coded).clamp(min=0)[None], size=(height, width), mode="bilinear")[0]
    taken = torch.minimum(reflection.clamp(min=0) * light, full.clamp(min=0))
    # What is left is stored in half floats too.
    reference = full - (full - taken).half().float()
    with tempfile.TemporaryDirectory() as scratch:
        strokes = Path(scratch) / "strokes.json"
        strokes.write_text(json.dumps(STROKES))
        device = run("frame", bundle, full, width, height, reference.shape, extra=[str(strokes)])
    error = (device - reference) / light
    agreement = psnr(error.pow(2).mean())
    print(
        f"stage, {width}x{height}: max |error| {float(error.abs().max()):.2e} of white, a reflection up to"
        f" {float((reference / light).max()):.3f}, PSNR {agreement:.1f} dB"
    )
    return agreement >= STAGE_AGREEMENT_DB


def painted(strokes: list[dict], plane: tuple[int, int], columns: int, long: int, width: int) -> torch.Tensor:
    """`dereflect_frame.slang`'s brush on a padded plane whose first `columns` hold a frame `width`
    across, its long edge `long`."""
    stored_width = round(width / long * STORED_LONG)
    across = columns / stored_width
    ys, xs = torch.meshgrid(torch.arange(plane[0]) + 0.5, torch.arange(plane[1]) + 0.5, indexing="ij")
    hints = torch.zeros(2, *plane)
    for stroke in strokes:
        points = [(x * across, y * across) for x, y in stroke["points"]]
        radius = stroke["radius"] * across
        kind = 0 if stroke["kind"] == "remove" else 1
        for a, b in zip(points, points[1:] or points):
            along = (b[0] - a[0], b[1] - a[1])
            reach = along[0] ** 2 + along[1] ** 2
            t = ((xs - a[0]) * along[0] + (ys - a[1]) * along[1]) / reach if reach > 0 else torch.zeros_like(xs)
            t = t.clamp(0, 1)
            distance = ((xs - a[0] - t * along[0]) ** 2 + (ys - a[1] - t * along[1]) ** 2).sqrt()
            hints[kind] = torch.maximum(hints[kind], torch.sigmoid((radius - distance) / (BRUSH_SOFTNESS * radius)))
    return hints


def run(mode: str, bundle: Path, given: torch.Tensor, width: int, height: int, shape, extra: list[str] = []) -> torch.Tensor:
    # The device's own allocations come from the same card.
    torch.cuda.empty_cache()
    with tempfile.TemporaryDirectory() as scratch:
        source, answer = Path(scratch) / "in.f32", Path(scratch) / "out.f32"
        source.write_bytes(given.contiguous().numpy().astype("<f4").tobytes())
        command = [str(EXAMPLE), mode, str(bundle), str(source), str(width), str(height), *extra, str(answer)]
        subprocess.run(command, check=True, env=example_environment())
        return torch.from_numpy(np.fromfile(answer, "<f4").reshape(shape))


def brushed(height: int, width: int) -> torch.Tensor:
    """The brush's `HINTS` planes: a soft disc marking reflection left of centre, one marking none
    right of it."""
    ys, xs = torch.meshgrid(torch.arange(height) / height, torch.arange(width) / width, indexing="ij")

    def disc(x: float) -> torch.Tensor:
        return (1 - ((xs - x).square() + (ys - 0.5).square()).sqrt() / 0.15).clamp(0, 1)

    return torch.stack([disc(0.3), disc(0.7)])


if __name__ == "__main__":
    main()
