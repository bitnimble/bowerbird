"""Runs a command and kills its whole process tree if the tree's memory goes over a limit."""

import argparse
import ctypes
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

POLL_SECONDS = 2.0
COUNTED = ("Pss_Anon", "Pss_Shmem", "SwapPss")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--max-gb", type=float, required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER, help="after --")
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    limit = args.max_gb * 2**30

    child = subprocess.Popen(command, preexec_fn=lambda: die_with_parent(0))
    peak = 0
    while child.poll() is None:
        tree = descendants(child.pid)
        used = sum(memory(pid) for pid in tree)
        peak = max(peak, used)
        if used > limit:
            print(f"capped: {used / 2**30:.2f} GiB is over {args.max_gb:g} GiB, killing", file=sys.stderr, flush=True)
            for pid in tree:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            child.wait()
            sys.exit(137)
        time.sleep(POLL_SECONDS)
    print(f"capped: peak {peak / 2**30:.2f} GiB", file=sys.stderr, flush=True)
    sys.exit(child.returncode if child.returncode >= 0 else 128 - child.returncode)


def die_with_parent(_worker_id: int) -> None:
    """A `worker_init_fn` or `preexec_fn`: SIGKILL this process when its parent dies."""
    if sys.platform == "linux":
        ctypes.CDLL("libc.so.6").prctl(1, signal.SIGKILL)  # PR_SET_PDEATHSIG


def descendants(root: int) -> list[int]:
    children: dict[int, list[int]] = {}
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            stat = (entry / "stat").read_text()
        except OSError:
            continue
        parent = int(stat[stat.rindex(")") + 2 :].split()[1])
        children.setdefault(parent, []).append(int(entry.name))
    tree, pending = [], [root]
    while pending:
        pid = pending.pop()
        tree.append(pid)
        pending += children.get(pid, [])
    return tree


def memory(pid: int) -> int:
    """Anonymous, shared and swapped bytes, each shared page split among its sharers. Cached file
    pages are left out: the kernel takes those back under pressure."""
    try:
        lines = Path(f"/proc/{pid}/smaps_rollup").read_text().splitlines()
    except OSError:
        return 0
    total = 0
    for line in lines:
        name, _, value = line.partition(":")
        if name in COUNTED:
            total += int(value.split()[0]) * 1024
    return total


if __name__ == "__main__":
    main()
