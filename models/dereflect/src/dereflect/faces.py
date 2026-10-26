"""Faces in the cached frames, for reflections of the photographer or someone beside them looking at the glass.
A YOLOv8 face detector finds them once and the boxes are kept beside the frames as faces.json. The detector
is AGPL-3.0 and only labels the frames, so it runs from an overlay rather than the project's dependencies:

    uv run --with ultralytics python -m dereflect.faces --weights <yolov8n-face.pt>
"""

import argparse
import hashlib
import json
from pathlib import Path

import torch

from dereflect.frames import DEFAULT_FRAMES, SELECTION, frame_of
from dereflect.remove import shown_light
from dereflect.subjects import cached
from training.files import write_atomic
from training.preview import srgb

LEAST_CONFIDENCE = 0.4


def main() -> None:
    parser = argparse.ArgumentParser(description="Find the faces in the cached frames.")
    parser.add_argument("--cache", type=Path, default=DEFAULT_FRAMES)
    parser.add_argument("--weights", type=Path, required=True, help="a YOLOv8 face detector's .pt")
    args = parser.parse_args()
    from ultralytics import YOLO

    detector = YOLO(str(args.weights))
    measure = f"{SELECTION}; {hashlib.sha256(args.weights.read_bytes()).hexdigest()[:16]} at {LEAST_CONFIDENCE}"
    sidecar = args.cache / "faces.json"
    saved = json.loads(sidecar.read_text()) if sidecar.exists() else {}
    known = saved.get("faces", {}) if saved.get("measure") == measure else {}
    missing = [(path, record) for path, record in cached(args.cache) if path.stem not in known]
    for done, (path, record) in enumerate(missing, 1):
        light = torch.from_numpy(frame_of(path, record).astype("float32")) / record["white"]
        shown = srgb(shown_light(light[None])[0])
        found = detector.predict(shown[:, :, ::-1], conf=LEAST_CONFIDENCE, device="cpu", verbose=False)[0].boxes
        size = torch.tensor([shown.shape[1], shown.shape[0]] * 2, dtype=torch.float32)
        known[path.stem] = [
            [round(v, 4) for v in (box / size).tolist()] + [round(float(confidence), 3)]
            for box, confidence in zip(found.xyxy.cpu(), found.conf.cpu())
        ]
        if done % 500 == 0 or done == len(missing):
            print(f"faces: {done}/{len(missing)}", flush=True)
            write_atomic(sidecar, lambda f: f.write(json.dumps({"measure": measure, "faces": known}).encode()))


def faces(cache: Path) -> dict[str, list[list[float]]]:
    """Per frame key, each face's box as (x0, y0, x1, y1) in 0..1 of the frame and the detector's confidence."""
    sidecar = cache / "faces.json"
    if not sidecar.exists():
        raise SystemExit(f"no faces found for {cache}: run `uv run --with ultralytics python -m dereflect.faces`")
    return json.loads(sidecar.read_text())["faces"]


if __name__ == "__main__":
    main()
