"""Which RAW files under some folders make a training set: one frame per burst, optionally capped
by ISO."""

import argparse
import csv
import dataclasses
import struct
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from typing import BinaryIO

import rawpy

from training.crops import sources

BURST_GAP_SECONDS = 2.0

EXIF_POINTER = 0x8769
ISO_SPEED_RATINGS = 0x8827
RECOMMENDED_EXPOSURE_INDEX = 0x8832
DATE_TIME_ORIGINAL = 0x9003


@dataclasses.dataclass
class Entry:
    path: str
    iso: float
    taken: float


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("roots", type=Path, nargs="+")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--max-iso", type=float, default=float("inf"))
    parser.add_argument("--workers", type=int, default=32)
    args = parser.parse_args()
    if not args.out.name.startswith("filelist") or args.out.suffix != ".csv":
        parser.error("--out must be named filelist*.csv, which git ignores: it lists private paths")

    raws = [p for root in args.roots for p in sources(root) if "Bin" not in p.relative_to(root).parts]
    print(f"{len(raws)} RAW files", flush=True)
    with ThreadPoolExecutor(args.workers) as pool:
        described = [e for e in pool.map(describe, raws) if e is not None]
    print(f"{len(described)} with an ISO and a capture time", flush=True)
    quiet = [e for e in described if e.iso <= args.max_iso]
    print(f"{len(quiet)} at ISO {args.max_iso:g} or below", flush=True)
    kept = one_per_burst(quiet)
    print(f"{len(kept)} after keeping one frame per burst", flush=True)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", newline="") as f:
        writer = csv.DictWriter(f, [field.name for field in dataclasses.fields(Entry)])
        writer.writeheader()
        writer.writerows(dataclasses.asdict(e) for e in kept)


def describe(path: Path) -> Entry | None:
    try:
        with path.open("rb") as f:
            if f.read(4) in (b"II*\0", b"MM\0*"):
                entry = from_tiff(path, f)
                if entry is not None:
                    return entry
    except (OSError, ValueError, struct.error):
        pass
    try:
        return from_libraw(path)
    except (OSError, ValueError, rawpy.LibRawError):
        return None


def from_tiff(path: Path, f: BinaryIO) -> Entry | None:
    """ARW, CR2, NEF and DNG are TIFF, so their EXIF is a few small reads from the header."""
    f.seek(0)
    order = "<" if f.read(2) == b"II" else ">"
    f.seek(4)
    (first,) = struct.unpack(order + "I", f.read(4))
    pointer = directory(f, order, first).get(EXIF_POINTER)
    if pointer is None:
        return None
    exif = directory(f, order, struct.unpack(order + "I", pointer[2])[0])
    iso = exif.get(ISO_SPEED_RATINGS) or exif.get(RECOMMENDED_EXPOSURE_INDEX)
    taken = exif.get(DATE_TIME_ORIGINAL)
    if iso is None or taken is None:
        return None
    kind, _, value = iso
    speed = struct.unpack(order + ("H" if kind == 3 else "I"), value[: 2 if kind == 3 else 4])[0]
    _, length, value = taken
    f.seek(struct.unpack(order + "I", value)[0])
    stamp = f.read(length).rstrip(b"\0").decode()
    return Entry(str(path), float(speed), datetime.strptime(stamp, "%Y:%m:%d %H:%M:%S").timestamp())


def directory(f: BinaryIO, order: str, offset: int) -> dict[int, tuple[int, int, bytes]]:
    """A TIFF IFD's entries by tag: type, count, and the four value-or-offset bytes."""
    f.seek(offset)
    (count,) = struct.unpack(order + "H", f.read(2))
    raw = f.read(12 * count)
    entries = (struct.unpack(order + "HHI4s", raw[i : i + 12]) for i in range(0, 12 * count, 12))
    return {tag: (kind, length, value) for tag, kind, length, value in entries}


def from_libraw(path: Path) -> Entry:
    """Slow: reading `other` unpacks the whole frame. Only for what isn't TIFF, such as CR3."""
    with rawpy.imread(str(path)) as raw:
        return Entry(str(path), float(raw.other.iso_speed), raw.other.timestamp.timestamp())


def one_per_burst(entries: list[Entry]) -> list[Entry]:
    """Per folder, drops each frame taken within `BURST_GAP_SECONDS` of the last one kept."""
    by_folder: dict[str, list[Entry]] = defaultdict(list)
    for entry in entries:
        by_folder[str(Path(entry.path).parent)].append(entry)
    kept = []
    for folder in sorted(by_folder):
        last = float("-inf")
        for entry in sorted(by_folder[folder], key=lambda e: (e.taken, e.path)):
            if entry.taken - last >= BURST_GAP_SECONDS:
                kept.append(entry)
                last = entry.taken
    return kept


if __name__ == "__main__":
    main()
