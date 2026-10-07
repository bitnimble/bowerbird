"""The editor's decode and PMRID denoise, through `native/rawshim/examples/pmrid_server.rs`."""

import json
import multiprocessing
import os
import subprocess
from collections.abc import Callable, Iterator
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import TypeVar

import numpy as np

T = TypeVar("T")
R = TypeVar("R")

REPOSITORY = Path(__file__).resolve().parents[4]
SERVER = REPOSITORY / "native" / "rawshim" / "target" / "quick" / "examples" / "pmrid_server"
BUILD = (
    "bun run scripts/cargo.ts build --profile quick --manifest-path native/rawshim/Cargo.toml"
    " --example pmrid_server"
)
RGGB = [0, 1, 1, 2]


@dataclass
class Opened:
    mosaic: np.ndarray
    """RGGB, conditioned and denoised as the editor does at AUTO."""
    gains: np.ndarray
    """R, G, B, the largest 1."""
    fit: dict | None
    """GALOSH's `NoiseFit`, or None where it was unusable and nothing was denoised."""


class Pmrid:
    def __init__(self, scratch: Path) -> None:
        if not SERVER.exists():
            raise SystemExit(f"{SERVER} is missing; build it from {REPOSITORY} with `{BUILD}`")
        scratch.mkdir(parents=True, exist_ok=True)
        self.scratch = scratch / str(os.getpid())
        self.process = subprocess.Popen(
            [SERVER],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
            # `gpu::leave` exits through `_exit` only under cargo's environment; without it NVIDIA
            # faults at exit and every worker leaves a core dump.
            env={**os.environ, "CARGO_MANIFEST_DIR": str(REPOSITORY / "native" / "rawshim")},
        )

    def open(self, path: Path) -> Opened:
        """Raises `Unreadable` for a file the editor can't decode or whose CFA isn't Bayer."""
        reply = self.ask({"open": str(path), "out": str(self.scratch)})
        mosaic = take(self.scratch, reply["height"], reply["width"])
        if sorted(reply["cfa"]) != RGGB:
            raise Unreadable(f"{path} has a CFA of {reply['cfa']}")
        red_y, red_x = divmod(reply["cfa"].index(0), 2)
        height, width = ((n - o) // 2 * 2 for n, o in zip(mosaic.shape, (red_y, red_x)))
        return Opened(
            mosaic=mosaic[red_y : red_y + height, red_x : red_x + width],
            gains=np.asarray(reply["gains"], np.float32),
            fit=reply["fit"],
        )

    def denoise(self, mosaics: np.ndarray, gains: np.ndarray, fit: dict | None) -> np.ndarray:
        """Each of a stack of RGGB mosaics, (N, H, W), denoised against the photo's own fit."""
        if fit is None:
            return mosaics
        count, height, width = mosaics.shape
        np.ascontiguousarray(mosaics, "<f4").tofile(self.scratch)
        self.ask(
            {
                "denoise": str(self.scratch),
                "out": str(self.scratch),
                "width": width,
                "height": height,
                "cfa": RGGB,
                "gains": gains.tolist(),
                "fit": fit,
            }
        )
        return take(self.scratch, count, height, width)

    def ask(self, request: dict) -> dict:
        assert self.process.stdin is not None and self.process.stdout is not None
        self.process.stdin.write(json.dumps(request) + "\n")
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError(f"{SERVER} exited with {self.process.wait()}")
        reply = json.loads(line)
        if "error" not in reply:
            return reply
        if reply["unreadable"]:
            raise Unreadable(reply["error"])
        raise RuntimeError(reply["error"])


class Unreadable(Exception):
    """The file's own fault, which no retry mends."""


_server: Pmrid | None = None


def pmrid() -> Pmrid:
    """This worker's server, inside `each_with_pmrid`."""
    assert _server is not None, "only inside each_with_pmrid"
    return _server


def each_with_pmrid(work: Callable[[T], R], jobs: list[T], workers: int, scratch: Path) -> Iterator[R]:
    """`work` over `jobs`, in order, in worker processes that each hold a server."""
    # Spawned, not forked: a forked child would share the parent's CUDA and OpenMP state.
    context = multiprocessing.get_context("spawn")
    with ProcessPoolExecutor(workers, mp_context=context, initializer=_start, initargs=(scratch,)) as pool:
        yield from pool.map(work, jobs)


def _start(scratch: Path) -> None:
    global _server
    _server = Pmrid(scratch)


def take(path: Path, *shape: int) -> np.ndarray:
    samples = np.fromfile(path, "<f4").reshape(shape)
    path.unlink()
    return samples
