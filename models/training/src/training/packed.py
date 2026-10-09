"""Float16 arrays stored a chunk at a time, each compressed on its own so one can be read without the
rest: rounded to drop `DROPPED_MANTISSA_BITS`, its bytes split into a high and a low plane, then zstd.
About half the size of raw float16, and read at over 700 MiB/s a core.

A file is a header of the chunk count and the values in each, the byte offset of every chunk and of
the end, then the chunks."""

import os
import struct
from pathlib import Path

import numpy as np
import zstandard

from training.files import write_atomic

DROPPED_MANTISSA_BITS = 3
"""A worst relative error of 0.4%, far under the noise any model here trains against."""
LEVEL = 1
HEADER = struct.Struct("<II")
OFFSET = struct.Struct("<Q")
KEPT_MAGNITUDE = 0x7FFF & ~((1 << DROPPED_MANTISSA_BITS) - 1)
LARGEST_ROUNDED = 0x7BFF & KEPT_MAGNITUDE


def write(path: Path, chunks: np.ndarray) -> None:
    """`chunks`, (count, ...), each of the trailing shape, atomically."""
    write_atomic(path, lambda f: f.write(pack(chunks)))


def pack(chunks: np.ndarray) -> bytes:
    flat = np.ascontiguousarray(chunks, np.float16).reshape(len(chunks), -1)
    compressor = zstandard.ZstdCompressor(level=LEVEL)
    bodies = [compressor.compress(shuffled(rounded(chunk))) for chunk in flat]
    start = HEADER.size + OFFSET.size * (len(bodies) + 1)
    offsets = np.cumsum([start, *(len(body) for body in bodies)], dtype=np.uint64)
    return HEADER.pack(len(bodies), flat.shape[1]) + offsets.astype("<u8").tobytes() + b"".join(bodies)


def count(path: Path) -> int:
    with path.open("rb") as f:
        return HEADER.unpack(f.read(HEADER.size))[0]


def read(path: Path, index: int) -> np.ndarray:
    """Chunk `index`, flat."""
    fd = os.open(path, os.O_RDONLY)
    try:
        start, end = struct.unpack("<QQ", os.pread(fd, 2 * OFFSET.size, HEADER.size + OFFSET.size * index))
        body = os.pread(fd, end - start, start)
    finally:
        os.close(fd)
    return unshuffled(zstandard.ZstdDecompressor().decompress(body))


def read_all(path: Path) -> np.ndarray:
    """Every chunk, (count, values a chunk)."""
    data = path.read_bytes()
    chunks, _ = HEADER.unpack_from(data)
    offsets = np.frombuffer(data, "<u8", chunks + 1, HEADER.size)
    decompressor = zstandard.ZstdDecompressor()
    return np.stack([unshuffled(decompressor.decompress(data[a:b])) for a, b in zip(offsets[:-1], offsets[1:])])


def rounded(values: np.ndarray) -> np.ndarray:
    bits = values.view(np.uint16)
    magnitude = (bits & 0x7FFF).astype(np.uint32) + (1 << (DROPPED_MANTISSA_BITS - 1))
    magnitude = np.minimum(magnitude & KEPT_MAGNITUDE, LARGEST_ROUNDED)
    return (bits & 0x8000) | magnitude.astype(np.uint16)


def shuffled(bits: np.ndarray) -> bytes:
    return np.ascontiguousarray(bits.astype("<u2").view(np.uint8).reshape(-1, 2).T).tobytes()


def unshuffled(data: bytes) -> np.ndarray:
    planes = np.frombuffer(data, np.uint8).reshape(2, -1)
    return np.ascontiguousarray(planes.T).view("<u2").view(np.float16).reshape(-1)
