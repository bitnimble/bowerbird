import os
from collections.abc import Callable
from pathlib import Path
from typing import BinaryIO


def write_atomic(path: Path, write: Callable[[BinaryIO], object]) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}")
    try:
        with temporary.open("wb") as f:
            write(f)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
