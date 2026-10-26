"""Frames whose subject stands out in focus, a person or an animal, for reflections of what stands near
the glass: the photographer, someone beside them. DINOv2 describes the centre square of each cached
frame by its mean patch feature, and a frame scores its likeness to the nearest of a few exemplars
chosen by eye from contact sheets.

    uv run python -m dereflect.subjects --sheet out.png [--random 48 [--seed N] | --top 48 [--skip N]]
    uv run python -m dereflect.subjects --exemplars <key>...
"""

import argparse
import json
import random
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from torch.utils.data import DataLoader, Dataset

from dereflect import dino
from dereflect.frames import DEFAULT_FRAMES, SELECTION, centred, frame_of, stale
from dereflect.remove import shown_light
from training.files import write_atomic
from training.mosaic import stabilise
from training.preview import srgb, write_png

BACKBONE = "vits14"
PATCHES = 16
DESCRIBED = f"{SELECTION}; {BACKBONE} mean patch of the centre square at {PATCHES} patches"
COLUMNS = 8
CELL = 160
GAP = 4


def main() -> None:
    parser = argparse.ArgumentParser(description="Find the cached frames with a subject in focus.")
    parser.add_argument("--cache", type=Path, default=DEFAULT_FRAMES)
    parser.add_argument("--exemplars", nargs="+", help="frame keys whose subjects the rest are scored against")
    parser.add_argument("--sheet", type=Path, help="contact sheet of frames to write, numbered on stdout")
    parser.add_argument("--random", type=int, help="frames drawn at random for the sheet")
    parser.add_argument("--seed", type=int, default=0, help="of --random's draw")
    parser.add_argument("--top", type=int, help="best-scoring frames for the sheet")
    parser.add_argument("--skip", type=int, default=0, help="best-scoring frames to pass over before --top")
    args = parser.parse_args()
    items = cached(args.cache)
    if args.exemplars:
        unknown = sorted(set(args.exemplars) - {path.stem for path, _ in items})
        if unknown:
            raise SystemExit(f"no cached frames {unknown}")
        saved = {"described": DESCRIBED, "exemplars": args.exemplars}
        write_atomic(args.cache / "subjects.json", lambda f: f.write(json.dumps(saved).encode()))
    if not args.sheet:
        return
    if args.top:
        ranked = sorted(zip(scores(items), range(len(items))), reverse=True)
        chosen = [items[i] for score, i in ranked[args.skip : args.skip + args.top]]
        print("scores:", " ".join(f"{score:.3f}" for score, _ in ranked[args.skip : args.skip + args.top]))
    else:
        chosen = random.Random(args.seed).sample(items, min(args.random or COLUMNS * 6, len(items)))
    write_png(args.sheet, sheet(chosen))
    for i, (path, _) in enumerate(chosen):
        print(f"row {i // COLUMNS + 1} col {i % COLUMNS + 1}: {path.stem}")


def cached(cache: Path) -> list[tuple[Path, dict]]:
    """Every cached frame current for `SELECTION`, both sides of the validation split."""
    found = []
    for record_path in sorted(cache.glob("*.json")):
        if stale(record_path, SELECTION):
            continue
        record = json.loads(record_path.read_text())
        if "skipped" not in record:
            found.append((record_path, record))
    return found


def scores(items: list[tuple[Path, dict]]) -> list[float]:
    """Each frame's cosine likeness to the nearest exemplar `--exemplars` chose."""
    if not items:
        return []
    chosen_path = items[0][0].parent / "subjects.json"
    chosen = json.loads(chosen_path.read_text()) if chosen_path.exists() else {}
    if chosen.get("described") != DESCRIBED:
        raise SystemExit(f"no exemplars chosen for {chosen_path.parent}: run `python -m dereflect.subjects --exemplars`")
    wanted = set(chosen["exemplars"])
    exemplar_items = [(path, record) for path, record in cached(chosen_path.parent) if path.stem in wanted]
    if len(exemplar_items) != len(wanted):
        raise SystemExit(f"exemplars in {chosen_path} are no longer cached frames")
    features = described(items + exemplar_items)
    exemplars = torch.stack([features[stem] for stem in chosen["exemplars"]])
    return [float((exemplars @ features[path.stem]).max()) for path, _ in items]


def described(items: list[tuple[Path, dict]]) -> dict[str, torch.Tensor]:
    """Each frame's unit-length description, kept beside the frames once measured."""
    sidecar = items[0][0].parent / "described.npz"
    known: dict[str, torch.Tensor] = {}
    if sidecar.exists():
        saved = np.load(sidecar)
        if str(saved["described"]) == DESCRIBED:
            known = {stem: torch.from_numpy(row) for stem, row in zip(saved["stems"], saved["features"])}
    missing = [(path, record) for path, record in items if path.stem not in known]
    if missing:
        net = dino.load(BACKBONE).cuda()
        loaded = DataLoader(CentreSquares(missing), batch_size=64, num_workers=4)
        done = 0
        for stems, squares in loaded:
            with torch.no_grad(), torch.autocast("cuda", dtype=torch.bfloat16):
                patches = net(stabilise(squares.cuda()), PATCHES, PATCHES).float()
            for stem, feature in zip(stems, F.normalize(patches.mean((2, 3)), dim=1).cpu()):
                known[stem] = feature
            done += len(stems)
            print(f"described: {done}/{len(missing)}", flush=True)
        stems = sorted(known)
        np.savez(
            sidecar.with_suffix(".part.npz"),
            described=np.array(DESCRIBED),
            stems=np.array(stems),
            features=torch.stack([known[stem] for stem in stems]).numpy(),
        )
        sidecar.with_suffix(".part.npz").replace(sidecar)
    return known


class CentreSquares(Dataset):
    """Each frame's centre square shrunk to `PATCHES` DINOv2 patches a side, normalised to its white."""

    def __init__(self, items: list[tuple[Path, dict]]) -> None:
        self.items = items

    def __len__(self) -> int:
        return len(self.items)

    def __getitem__(self, index: int) -> tuple[str, torch.Tensor]:
        path, record = self.items[index]
        return path.stem, centred(frame_of(path, record), record, PATCHES * dino.PATCH)


def sheet(items: list[tuple[Path, dict]]) -> np.ndarray:
    """The centre squares of `items`, `COLUMNS` a row."""
    cells = [srgb(shown_light(centred(frame_of(path, record), record, CELL)[None])[0]) for path, record in items]
    blank = np.full((CELL, CELL, 3), 255, np.uint8)
    cells += [blank] * (-len(cells) % COLUMNS)
    rows = [
        np.concatenate([part for cell in cells[start : start + COLUMNS] for part in (cell, blank[:, :GAP])][:-1], 1)
        for start in range(0, len(cells), COLUMNS)
    ]
    gap = np.full((GAP, rows[0].shape[1], 3), 255, np.uint8)
    return np.concatenate([part for row in rows for part in (row, gap)][:-1], 0)


if __name__ == "__main__":
    main()
