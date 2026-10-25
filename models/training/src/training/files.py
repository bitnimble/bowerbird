import hashlib
import os
import urllib.request
from collections.abc import Callable
from pathlib import Path
from typing import BinaryIO


def fetched(url: str, path: Path, sha256: str) -> Path:
    """`path`, downloaded from `url` when absent and refused unless it hashes to `sha256`."""
    if path.exists():
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_suffix(".part")
    urllib.request.urlretrieve(url, partial)
    with partial.open("rb") as f:
        digest = hashlib.file_digest(f, "sha256").hexdigest()
    if digest != sha256:
        raise SystemExit(f"{url} hashes to {digest}, not the pinned {sha256}")
    partial.rename(path)
    return path


def write_atomic(path: Path, write: Callable[[BinaryIO], object]) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}")
    try:
        with temporary.open("wb") as f:
            write(f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
