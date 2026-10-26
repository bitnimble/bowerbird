"""The editor's decode and PMRID denoise, through `native/rawshim/examples/pmrid_server.rs`."""

import json
import multiprocessing
import os
import subprocess
from collections.abc import Callable
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass
from functools import partial
from pathlib import Path
from typing import TypeVar

import numpy as np

T = TypeVar("T")

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
    """RGGB, conditioned, dust removed and denoised as the editor does at AUTO, unless `open` was told
    to skip them."""
    gains: np.ndarray
    """R, G, B, the largest 1."""
    fit: dict | None
    """GALOSH's `NoiseFit`, or None where it was unusable and nothing was denoised."""


@dataclass
class Decoded:
    rgb: np.ndarray
    """(H, W, 3) Rec.2020 light over full scale, as the library decodes the photo unedited."""
    ceilings: np.ndarray
    """Where each camera channel saturated, R, G, B, over full scale."""
    matrix: np.ndarray
    """Camera to Rec.2020."""


@dataclass
class Sharpened:
    plain: np.ndarray
    """(N, H, W, 3) Rec.2020 light over reference white, demosaiced and coded."""
    sharpened: np.ndarray
    """The same, defringed and capture-sharpened as the editor does an unedited photo."""
    matrix: np.ndarray
    """Camera to Rec.2020."""
    sigma: float


class Pmrid:
    def __init__(self, scratch: Path) -> None:
        if not SERVER.exists():
            raise SystemExit(f"{SERVER} is missing; build it from {REPOSITORY} with `{BUILD}`")
        scratch.mkdir(parents=True, exist_ok=True)
        self.exchange = scratch / str(os.getpid())
        """The file samples travel to and from the server in."""
        self.process = self.spawn()

    def spawn(self) -> subprocess.Popen[str]:
        return subprocess.Popen(
            [SERVER],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
            env=example_environment(),
        )

    def open(self, path: Path, noisy: bool = False) -> Opened:
        """Raises `Unreadable` for a file the editor can't decode or whose CFA isn't Bayer. A `noisy`
        mosaic skips the denoise."""
        reply = self.ask({"open": str(path), "out": str(self.exchange), "noisy": noisy})
        mosaic = take(self.exchange, reply["height"], reply["width"])
        red_y, red_x = divmod(reply["cfa"].index(0), 2)
        height, width = ((n - o) // 2 * 2 for n, o in zip(mosaic.shape, (red_y, red_x)))
        return Opened(
            mosaic=mosaic[red_y : red_y + height, red_x : red_x + width],
            gains=np.asarray(reply["gains"], np.float32),
            fit=reply["fit"],
        )

    def decode(self, path: Path, floor: int) -> Decoded:
        """The photo as the library decodes it for a rendition `floor` on its long edge. Raises
        `Unreadable` as `open` does."""
        reply = self.ask({"decode": str(path), "out": str(self.exchange), "floor": floor})
        return Decoded(
            rgb=take(self.exchange, reply["height"], reply["width"], 3),
            ceilings=np.asarray(reply["ceilings"], np.float32),
            matrix=np.asarray(reply["matrix"], np.float32),
        )

    def grade(
        self,
        path: Path,
        floor: int,
        pq: bool,
        edge: int | None = None,
        taken: np.ndarray | None = None,
        gains: list[float] | None = None,
        alone: bool = False,
    ) -> np.ndarray:
        """The photo as the library renders it unedited, `edge` on its long side, as (N, H, W, 3) 16-bit
        PQ Rec.2020 codes if `pq`, else 8-bit sRGB: once as it is, or with `taken`, (H, W, 3) light in
        `decode(path, floor)`'s units, once per gain, that much taken out of it, never below black, or
        with `alone` graded by itself, every image under the photo's own grade."""
        request = {"grade": str(path), "floor": floor, "out": str(self.exchange), "output": "pq" if pq else "srgb"}
        if edge is not None:
            request["edge"] = edge
        given = self.exchange.with_suffix(".taken")
        if taken is not None:
            np.ascontiguousarray(taken, "<f4").tofile(given)
            request |= {"taken": str(given), "gains": gains or [1.0], "alone": alone}
        reply = self.ask(request)
        given.unlink(missing_ok=True)
        codes = np.fromfile(self.exchange, "<u2").reshape(reply["count"], reply["height"], reply["width"], 3)
        self.exchange.unlink()
        return codes if pq else codes.astype(np.uint8)

    def header(self, path: Path) -> dict:
        """The RAW's `iso`, `shutter` in seconds and `aperture` as an f-number, each 0 where the camera
        recorded none, from its metadata alone. Raises `Unreadable` as `open` does."""
        return self.ask({"header": str(path)})

    def develop(self, mosaic: np.ndarray, ceilings: np.ndarray, matrix: np.ndarray) -> np.ndarray:
        """An RGGB mosaic of camera light, (H, W), clipped at `ceilings`, to (H / 2, W / 2, 3) Rec.2020
        light as a decode halving it would demosaic it, its highlights reconstructed."""
        height, width = mosaic.shape
        np.ascontiguousarray(mosaic, "<f4").tofile(self.exchange)
        self.ask(
            {
                "develop": str(self.exchange),
                "out": str(self.exchange),
                "width": width,
                "height": height,
                "ceilings": ceilings.tolist(),
                "matrix": matrix.tolist(),
            }
        )
        return take(self.exchange, height // 2, width // 2, 3)

    def denoise(self, mosaics: np.ndarray, gains: np.ndarray, fit: dict) -> np.ndarray:
        """Each of a stack of RGGB mosaics, (N, H, W), denoised against the photo's own fit."""
        count, height, width = mosaics.shape
        np.ascontiguousarray(mosaics, "<f4").tofile(self.exchange)
        self.ask(
            {
                "denoise": str(self.exchange),
                "out": str(self.exchange),
                "width": width,
                "height": height,
                "cfa": RGGB,
                "gains": gains.tolist(),
                "fit": fit,
            }
        )
        return take(self.exchange, count, height, width)

    def measure(self, raw: Path) -> dict:
        """What `sharpen` needs of the photo that only opening it whole can measure."""
        return self.ask({"measure": str(raw)})

    def sharpen(
        self,
        raw: Path,
        mosaics: np.ndarray,
        gains: np.ndarray,
        measured: dict | None = None,
        amount: float | None = None,
        scale: int = 1,
        supersampled: bool = False,
    ) -> "Sharpened":
        """A stack of the photo's RGGB mosaics, (N, H, W), through the rest of the editor's chain, the
        sharpen at `amount`, the editor's default unless given. Measures the photo unless `measured`
        is `measure`'s answer for it. `scale` is the mosaics' pixels per photosite of the photo.
        `supersampled` mosaics are 2x upscales, demosaiced and taken back to (H / 2, W / 2) before
        the coding, as the upscaler denoiser does."""
        light, reply = self.chain(raw, mosaics, gains, measured, amount, scale, supersampled, None)
        return Sharpened(light[:, 0], light[:, 1], np.asarray(reply["matrix"], np.float32), reply["sigma"])

    def shown(self, raw: Path, mosaics: np.ndarray, gains: np.ndarray, measured: dict, sharpened: bool) -> np.ndarray:
        """`sharpen`'s `sharpened`, or its `plain`, alone, for half the work."""
        light, _ = self.chain(raw, mosaics, gains, measured, None, 1, False, "sharpened" if sharpened else "plain")
        return light[:, 0]

    def chain(
        self,
        raw: Path,
        mosaics: np.ndarray,
        gains: np.ndarray,
        measured: dict | None,
        amount: float | None,
        scale: int,
        supersampled: bool,
        only: str | None,
    ) -> tuple[np.ndarray, dict]:
        count, height, width = mosaics.shape
        np.ascontiguousarray(mosaics, "<f4").tofile(self.exchange)
        reply = self.ask(
            {
                "sharpen": str(raw),
                "mosaics": str(self.exchange),
                "out": str(self.exchange),
                "width": width,
                "height": height,
                "gains": gains.tolist(),
                "measured": measured,
                "amount": amount,
                "scale": scale,
                "supersampled": supersampled,
                "only": only,
            }
        )
        shrink = 2 if supersampled else 1
        variants = 2 if only is None else 1
        return take(self.exchange, count, variants, height // shrink, width // shrink, 3), reply

    def ask(self, request: dict) -> dict:
        try:
            return self.ask_once(request)
        except OSError:
            self.restart()
        except RuntimeError:
            # Usually the GPU ran out of memory while other workers held large frames.
            if self.process.poll() is not None:
                self.restart()
        return self.ask_once(request)

    def restart(self) -> None:
        self.process.kill()
        self.process.wait()
        self.process = self.spawn()

    def ask_once(self, request: dict) -> dict:
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


def example_environment() -> dict[str, str]:
    # `gpu::leave` exits through `_exit` only under cargo's environment; without it NVIDIA faults at
    # exit and every run leaves a core dump.
    return {**os.environ, "CARGO_MANIFEST_DIR": str(REPOSITORY / "native" / "rawshim")}


class Unreadable(Exception):
    """The file's own fault, which no retry mends."""


_server: Pmrid | None = None


def pmrid() -> Pmrid:
    assert _server is not None, "only inside each_with_pmrid or after serve"
    return _server


def serve(scratch: Path) -> Pmrid:
    """Starts this process's server, the one `pmrid` answers with."""
    global _server
    _server = Pmrid(scratch)
    return _server


def each_with_pmrid(work: Callable[[T], str], jobs: list[T], workers: int, scratch: Path, label: str) -> None:
    """`work` over `jobs` in worker processes that each hold a server, printing progress under
    `label`. A job whose `work` raises is printed and left for the next run."""
    if not jobs:
        return
    scratch.mkdir(parents=True, exist_ok=True)
    for leftover in scratch.iterdir():
        if not Path(f"/proc/{leftover.name}").exists():
            leftover.unlink(missing_ok=True)
    # Spawned, not forked: a forked child would share the parent's CUDA and OpenMP state.
    context = multiprocessing.get_context("spawn")
    failed = 0
    with ProcessPoolExecutor(workers, mp_context=context, initializer=serve, initargs=(scratch,)) as pool:
        for done, (ok, outcome) in enumerate(pool.map(partial(_attempt, work), jobs), 1):
            if not ok:
                failed += 1
                print(f"{label}: {outcome}", flush=True)
            elif done % 50 == 0 or done == len(jobs):
                print(f"{label}: {done}/{len(jobs)} ({outcome})", flush=True)
    if failed:
        print(f"{label}: {failed} of {len(jobs)} failed, left for the next run", flush=True)


def _attempt(work: Callable[[T], str], job: T) -> tuple[bool, str]:
    try:
        return True, work(job)
    except Exception as error:
        return False, f"{job} failed: {error!r}"


def take(path: Path, *shape: int) -> np.ndarray:
    samples = np.fromfile(path, "<f4").reshape(shape)
    path.unlink()
    return samples
