"""Photographs through glass, made from two cached frames: one the scene behind the glass, the other
what the glass reflects, added in linear light as glass adds them, then recorded by the scene's
camera and decoded as the library decodes it. A sample is the pair of views; the mix is made on the
GPU, afresh every batch, and decoded by `pmrid`'s server."""

import math
import random
from collections.abc import Callable
from concurrent.futures import Executor, Future
from pathlib import Path
from typing import NamedTuple

import numpy as np
import torch
import torch.nn.functional as F
from torch.utils.data import Dataset

from dereflect.frames import EDGE, WINDOW, centred, colourfulness, frame_of, radiance, records, sharpness, white
from dereflect.faces import faces as face_boxes
from dereflect.subjects import scores as subject_scores
from training.pmrid import pmrid

CROP = WINDOW
SHARP_FLOOR = 0.022
SHARP_TRIES = 8
SCENE_SCALES = (0.5, 1.0)
REFLECTION_SCALES = (0.25, 1.0)
EXPOSURE_STOPS = (-1.0, 0.5)
BLUR = (0.5, 10.0)
"""Spread of a layer's blur in crop pixels, as a standard deviation, drawn log-uniformly."""
BLUR_REACH = math.ceil(3 * BLUR[1])
SOFT_SCENE_SHARE = 0.2
"""Scenes blurred as reflections are, so sharpness hints at which layer is which but never decides it.
A photograph through glass is mostly focused on the scene."""
SCENE_VARYING_SHARE = 0.8
"""Of blurred scenes, the share whose blur varies with a random depth, as a shallow depth of field
leaves a subject sharp."""
SHARP_REFLECTION_SHARE = 0.4
REFLECTION_VARYING_SHARE = 0.5
DISC_SHARE = 0.4
"""Of blurred layers, the share blurred by a disc, as a lens defocuses: point lights become bokeh."""
MOTION_SHARE = 0.1
DEPTH_GRID = (2, 6)
DEPTH_EDGE = (1.0, 30.0)
"""Steepness of the depth's step from sharp to blurred, drawn log-uniformly: a slope to a subject's edge."""
DEPTH_LEVELS = 4
REFLECTANCE = (0.04, 0.2)
"""Of glass's front surface at the frame's centre, drawn log-uniformly."""
GLASS_INDEX = 1.5
HALF_VIEW = (3.0, 20.0)
"""Degrees the frame's edge turns from its centre's angle to the glass: the crop's half field of view."""
GRAZING = 85.0
EDGE_GAIN = 4.0
"""Most the reflectance rises towards an edge over the centre's."""
STRENGTH = (0.01, 16.0)
"""The reflection's light against the scene's that a pair keeps: `REFLECTANCE` times the reflected
world's light over the scene's. Picks which frame reflects; `SHARES` dims it from there."""
SHARES = (
    0.0007, 0.0046, 0.0071, 0.0091, 0.0126, 0.0179, 0.0249, 0.0316, 0.0396, 0.0497, 0.0623,
    0.0746, 0.0937, 0.1157, 0.1434, 0.185, 0.2246, 0.2974, 0.3864, 0.4921, 0.8598,
)
"""Every 5th percentile of the reflection's share of the photograph's light over the held-out real pairs."""
DRAWN_SHARES = (
    0.0001, 0.0044, 0.0092, 0.0158, 0.0234, 0.034, 0.047, 0.062, 0.0862, 0.1125, 0.1522,
    0.2007, 0.2591, 0.3228, 0.406, 0.4997, 0.608, 0.7279, 0.8513, 0.9262, 0.9957,
)
"""The same percentiles of the share as the radiances draw it, ahead of `shared`, which maps each
reflection from these onto `SHARES` at the same rank: a sunlit sky into a dark interior stays the
brightest, at the brightest a real pair holds."""
REFLECTION_TRIES = 16
CLEAN_SHARE = 0.2
"""Samples with no reflection."""
GHOST_SHARE = 0.7
"""Reflections doubled by the glass's back surface, as all but coated or thin glass does."""
GHOST_SHIFT = (1.0, 16.0)
"""How far the back surface's copy lands from the front's, in crop pixels, drawn log-uniformly in a
random direction: millimetres of glass, or a double glazing's gap, metres from the camera."""
GHOST_STRENGTH = (0.5, 1.0)
"""Of the front reflection: uncoated glass reflects about 4% at each surface, so the two nearly match."""
VEIL_SHARE = 0.15
"""Reflections far out of focus, as a sunlit dashboard on a windscreen or a room on a shop window."""
VEIL_SPREAD = (10.0, 100.0)
"""The veil's lens disc's standard deviation in crop pixels, log-uniformly."""
NEAR_SHARE = 0.2
"""Of reflections that aren't veils, those of something just behind the camera, a person or a wall: a long
lens magnifies it past any whole scene, into a few broad fields of colour, and defocuses it less than a
veil."""
NEAR_SHOWN = (0.1, 0.5)
"""Side of the window of the reflection's crop that a near reflection magnifies, log-uniformly."""
NEAR_SPREAD = (2.0, 20.0)
"""The near reflection's lens disc's standard deviation in crop pixels, log-uniformly."""
NEAR_SUBJECT_SHARE = 0.85
"""With `near_subjects`, of reflections of a face, those of its person standing at the glass."""
NEAR_SUBJECT_SPREAD = (3.0, 12.0)
"""With `near_subjects`, a near face's lens disc's standard deviation in crop pixels, log-uniformly, centred
on 6: chosen by eye against the zoo figures, which keep a silhouette."""
FACE_LEAST = 0.04
"""Of the frame's height, the smallest face `faces` reflects: smaller ones magnify into mush."""
FACE_CONFIDENCE = 0.6
"""Least detector confidence a reflected face needs: under it, most are backs of heads, cats and carvings."""
FACE_ROOM = (2.0, 5.0)
"""A face's reflection's side over the face's height, log-uniformly: a face filling the glass to a head and
shoulders."""
FACE_PLACE = 0.35
"""Of the crop's side, how far from its centre a face may land, each way, uniformly."""
FACE_TURN = 25.0
"""Most a face's reflection is rotated, in degrees, either way."""
FACE_SHEAR = 0.25
"""Most a face's reflection is sheared, either way, as glass seen obliquely skews it."""
FACE_STRETCH = (0.8, 1.25)
"""A face's reflection's width over its height, log-uniformly."""
GLARE_SHARE = 0.15
"""Reflections of a broad bright area so far out of focus they lift the frame almost evenly: the milky
wash a lit room or a pale sky leaves on a window."""
GLARE_LIFT = (0.03, 2.0)
"""A glare's mean light over the scene's median, log-uniformly, apart from the reflection's strength: a
pale sky's wash over a dim enclosure can outshine the enclosure's midtones."""
GLARE_UNEVENNESS = (0.0, 0.8)
"""Most a glare's light strays from its mean across the frame, as a share of it."""
GLARE_GRID = (2, 3)
GLARE_OVER_SHARE = 0.5
"""Of glares, those laid over the reflection rather than in its place, as a windscreen's glare over what
it mirrors sharply."""
DISC_WORKING_SPREAD = 5.0
"""Largest disc `defocused` convolves at full scale; wider ones work on a shrunk image."""
CUT_SHARE = 0.3
"""Reflections ending at a straight edge, as a dashboard's ends where the bonnet begins or a window
frame blocks what's behind the camera."""
CUT_SOFTNESS = (0.01, 0.08)
"""Of the crop's side, the width of the cut's falloff, log-uniformly. What casts it is near the glass, far
out of the scene's focus."""
SHADE_EDGE = (1.0, 6.0)
"""As `DEPTH_EDGE`, for a patchy shade's edges, which are as far out of focus as a cut's."""
PATCHY_SHARE = 0.2
"""Reflections over only part of the frame, where something near the glass shades it."""
VIVID_TOP = 0.1
"""Share of frames, by `colourfulness`, that `vivid` draws reflections from."""
SUBJECT_TOP = 0.15
"""Share of frames, by `subjects.scores`, that `subjects` draws reflections from."""
ADAPTED = (0.0, 1.0)
"""How far a reflection's colour moves from its own white balance to the scene's, drawn uniformly."""
COLOUR_SPREAD = 1.2
"""Most a reflection's mean colour's channels spread, over their mean: past the real pairs' 97th percentile."""
BROAD_SPREAD = (0.2, 0.9)
"""With `broad_colours`, a veil's, near reflection's or glare's mean colour's spread, log-uniformly: past
0.9 an even glare reads as a coloured filter; the zoo veils run 0.17 to 0.81."""
BROAD_FAINT = (0.0, 0.2)
"""A faint broad layer's mean colour's spread, uniformly, from grey up to where `BROAD_SPREAD` starts."""
GREEN_HUES = (75.0, 165.0)
"""Degrees from red towards green, yellow-green to green-cyan, that a green broad layer's hue is drawn from."""
BROAD_LEVEL = (0.03, 0.2)
"""With `broad_levels`, a veil's, near reflection's or glare's mean light over the scene's white,
log-uniformly: the zoo veils the remover is for lift a frame 0.07 to 0.17."""
BROAD_MOST_SHARE = 0.6
"""Most of the photograph's light a `broad_levels` layer takes, near the real pairs' 97th percentile: a night
scene's white is its lamps, so a level of it alone buries everything else."""
SCENE_CAST_SHARE = 1 / 3
"""With `scene_casts`, scenes tinted whole to a uniformly drawn hue, as an aquarium's water or a lamp leaves
them: the library's scenes hardly reach cyan or magenta, so a cast of either read as a reflection."""
SCENE_CAST_SPREAD = (0.15, 0.7)
"""A cast scene's mean colour's spread, log-uniformly: within the library's scenes' 90th percentile."""
SCENE_CAST_CLEAN_SHARE = 0.4
"""`CLEAN_SHARE` for cast scenes: with a quarter of steps real pairs, 10% of all steps are a cast left whole."""
WINDSCREEN_RAKE = (22.0, 35.0)
"""Degrees a windscreen leans back from the dashboard."""
VENT_FOOT = (0.0, 0.15)
"""Of the glass's rise, its height above the dashboard at the frame's bottom."""
VENT_SPAN = (0.8, 1.5)
"""Of the glass's rise, what the frame's height spans of it."""
DASHBOARD_DEPTH = (0.3, 0.8)
"""How far back the dashboard's top reaches from the glass's foot, in the glass's rise: past it the camera sees
the cabin's dark."""
DASHBOARD_CURL = (20.0, 70.0)
"""Degrees the dashboard's top has turned away from the windscreen by its back edge, growing with the square of
the distance back: it rounds over towards the cabin."""
SUN_ELEVATION = (10.0, 60.0)
VENT_SUN = (0.0, 0.5)
"""Of the dashboard's light, the share that's direct sun; the rest is skylight."""
VENT_SHADOW_EDGE = 0.05
"""The roof's shadow's softness on the dashboard, in the glass's rise."""
CAMERA_DISTANCE = (1.5, 4.0)
"""The camera's distance from the glass's foot, in the glass's rise."""
VENT_START = (0.0, 0.05)
"""How far short of the frame's bottom the grille's fore end lies on the dashboard, in the glass's rise."""
VENT_ROWS = (1, 3)
"""Rows of openings in the grille, fore to aft, inclusive."""
VENT_ROW_DEPTH = (0.05, 0.45)
"""Each row's opening, fore to aft, in the glass's rise, log-uniformly: near fin spacing for square holes."""
VENT_ROW_BAR = (0.15, 0.6)
"""Of a row's depth, the lit bar between it and the next."""
VENT_ROW_EDGE = 200.0
"""Steepness of a row's edges, per rise: under a pixel, the blur softens them."""
VENT_HEADING = (0.3, 0.7)
"""Of the frame's width, where the camera looks along the dashboard: fins converge on the point below it, so a
grille this far from it leans most."""
VENT_PLACE = (0.0, 1.0)
"""Of the crop's width, where the grille's centre lies."""
VENT_WIDTH = (0.2, 0.6)
"""Of the frame's width, the grille's."""
VENT_PERIOD = (25.0, 60.0)
"""Frame pixels from one fin to the next at the frame's bottom, log-uniformly."""
VENT_DUTY = (0.05, 0.3)
"""Share of each period a fin fills."""
VENT_HOLE_LIGHT = (0.0, 0.9)
"""Of the glow, what the grille's opening between the fins reflects."""
VENT_BLACK_SHARE = 0.5
"""Grilles whose openings reflect nothing: black holes punched through the dashboard's reflected light."""
VENT_FIN_LIGHT = (0.3, 1.6)
"""A fin's light over the glow around it, log-uniformly: a sunlit slat's top outshines the dashboard, a shaded one
sits well under it."""
VENT_FIN_SPREAD = (0.0, 0.5)
"""How far each fin's light strays from the grille's, as e to plus or minus it: each slat's top turns its own way."""
VENT_FIN_OVERHANG = (0.0, 0.6)
"""How far fins run on past the grille's far edge, fading, in its row depth: slat tops standing proud of the opening."""
VENT_FIN_TOP_LIGHT = (0.8, 1.6)
"""Those tops' light over the glow, log-uniformly: out of the opening's shade, they catch the sun."""
VENT_SOFTNESS = (1.0, 8.0)
"""The dashboard's blur's standard deviation in frame pixels at the frame's bottom, log-uniformly."""
DASH_OBJECTS = False
"""Whether `dashboard` draws panels, paper and stickers and only a `VENT_GRILLE_SHARE` of dashboards keep their
grille. Its clipped white paper teaches erasing white objects that are in the scene."""
VENT_GRILLE_SHARE = 0.6
DASH_PANELS = 4
"""Most moulded panels on a dashboard, each there at `DASH_PANEL_SHARE`: an instrument hood, a speaker's cover."""
DASH_PANEL_SHARE = 0.5
DASH_PANEL_HALF = ((0.05, 0.6), (0.03, 0.3))
"""A panel's half width and half depth in the glass's rise, log-uniformly, as every size on the dashboard."""
DASH_PANEL_ALBEDO = (0.3, 2.0)
"""A panel's light over the bare dashboard's, log-uniformly."""
DASH_OUTLINE_SHARE = 0.4
"""Of panels, those shown as a raised rim only, a band `DASH_OUTLINE_WIDTH` wide in the glass's rise."""
DASH_OUTLINE_WIDTH = (0.005, 0.03)
DASH_PAPERS = 2
"""Most sheets of paper lying on the dashboard, each there at `DASH_PAPER_SHARE`."""
DASH_PAPER_SHARE = 0.4
DASH_PAPER_HALF = ((0.04, 0.25), (0.03, 0.2))
DASH_PAPER_ALBEDO = (2.0, 10.0)
"""A sheet's light over the bare dashboard's: white paper on a grey or black top."""
DASH_PAPER_LINES = (0.004, 0.02)
"""Spacing in the glass's rise of a sheet's printed lines, log-uniformly."""
DASH_STICKERS = 2
DASH_STICKER_SHARE = 0.3
DASH_STICKER_HALF = (0.01, 0.06)
DASH_STICKER_SPREAD = (0.3, 0.9)
"""A sticker's colour's spread over its mean, as `tinted` draws it."""
DASH_EDGE = 300.0
"""Steepness of a shape's edges, per rise: about a pixel at the frame's bottom."""
DASH_MOST = 4.0
"""The dashboard's light's ceiling, of the scene's white: a sunlit sheet at grazing incidence, which the sensor
clips flat as a dashcam does."""
VENT_ROLL = (-6.0, 6.0)
"""Degrees the camera is rolled against the dashboard, tilting all of it in the frame."""
VENT_BOW = (-0.05, 0.05)
"""How far the dashboard's edges bow up or down at the frame's sides, in frame heights: a curved dashboard."""
VENT_SIDE_LIGHT = 0.5
"""Most the dashboard's light rises at one side of the frame and falls at the other, in its share: sun from the side."""
VENT_FRAME_ASPECT = 1.5
"""A windscreen frame's width over its height: the crop is a window on the bottom of one `EDGE` wide."""
VENT_LEVEL = (0.05, 0.4)
"""The dashboard's brightest glow over the scene's white, log-uniformly; lit fins rise past it."""
VENT_TINT = 0.15
VENT_FIN_REACH = 31
"""Crop pixels of the horizontal blur `finned` measures fins against: wider than a fin, narrower than the glow."""
CLIP_TOLERANCE = 0.99
"""Of a scene's clipping level: frames are float16, so a clipped plateau lands either side of it."""

Kernel = Callable[[float, float, torch.device], torch.Tensor]


class Pairs(Dataset):
    """A (3, crop, crop) view of each frame with something sharp in it as the scene, normalised to its
    white, beside a view of another as the reflection at the light glass would reflect it; then the scene camera's channel ceilings in the scene's units, (3,), its camera to
    Rec.2020 matrix, (3, 3), the light, (1,), that brings those units back to the decode's scale, and
    the glass's reflectance at the frame's centre, (1,). A `subjects` share of reflections are whole
    frames with a subject in focus, as what stands near the glass reflects. Validation draws the same
    pairs and views every time."""

    def __init__(
        self,
        cache: Path,
        raws: list[Path],
        validation: bool,
        colourful: float = 0.0,
        vivid: float = 0.0,
        crop: int = CROP,
        subjects: float = 0.0,
        faces: bool = False,
    ) -> None:
        """With `faces`, `subjects` reflections are frames with a face `dereflect.faces` found, framed on it."""
        self.validation = validation
        self.colourful = colourful
        self.vivid = vivid
        self.subjects = subjects
        self.crop = crop
        self.items = [
            (path, record)
            for path, record in records(cache, raws, validation)
            if min(record["height"], record["width"]) >= crop and radiance(record) is not None
        ]
        self.radiances = [radiance(record) for _, record in self.items]
        self.scenes = [i for i, (_, record) in enumerate(self.items) if record["sharpest"] >= SHARP_FLOOR]
        self.vivid_items: list[int] = []
        if vivid:
            scores = colourfulness(self.items)
            ranked = sorted(range(len(self.items)), key=scores.__getitem__, reverse=True)
            self.vivid_items = ranked[: max(1, round(len(ranked) * VIVID_TOP))]
        self.subject_items: list[int] = []
        self.faces: dict[int, list[list[float]]] = {}
        if subjects and faces:
            found = face_boxes(cache)
            for i, (path, _) in enumerate(self.items):
                large = [b for b in found.get(path.stem, []) if b[3] - b[1] >= FACE_LEAST and b[4] >= FACE_CONFIDENCE]
                if large:
                    self.faces[i] = large
            self.subject_items = sorted(self.faces)
        elif subjects:
            scores = subject_scores(self.items)
            ranked = sorted(range(len(self.items)), key=scores.__getitem__, reverse=True)
            self.subject_items = ranked[: max(1, round(len(ranked) * SUBJECT_TOP))]

    def __len__(self) -> int:
        return len(self.scenes) if len(self.items) >= 2 else 0

    def __getitem__(self, index: int) -> tuple[torch.Tensor, ...]:
        rng = random.Random(index if self.validation else int(torch.randint(2**62, ())))
        scene_index = self.scenes[index]
        scene_path, scene_record = self.items[scene_index]
        frame = frame_of(scene_path, scene_record)
        tries = []
        while not tries or (tries[-1][0] < SHARP_FLOOR and len(tries) < SHARP_TRIES):
            candidate = view(frame, scene_record, rng, SCENE_SCALES, self.crop)
            tries.append((sharpness(candidate), candidate))
        scene = max(tries, key=lambda scored: scored[0])[1]
        reflectance = math.exp(rng.uniform(*(math.log(bound) for bound in REFLECTANCE)))
        # Redrawn rather than rescaled: a reflection outshines the scene only where the scene is dark.
        whole = self.subjects and rng.random() < self.subjects
        for _ in range(REFLECTION_TRIES):
            reflected_index = self.subject(scene_index, rng) if whole else self.reflected(scene_index, rng)
            strength = reflectance * self.radiances[reflected_index] / self.radiances[scene_index]
            if STRENGTH[0] <= strength <= STRENGTH[1]:
                break
        strength = min(max(strength, STRENGTH[0]), STRENGTH[1])
        reflected_path, reflected_record = self.items[reflected_index]
        reflected_frame = frame_of(reflected_path, reflected_record)
        if whole and reflected_index in self.faces:
            face = rng.choice(self.faces[reflected_index])
            reflection = around(reflected_frame, reflected_record, face, rng, self.crop)
        elif whole:
            reflection = centred(reflected_frame, reflected_record, self.crop).flip(-1)
        else:
            reflection = view(reflected_frame, reflected_record, rng, REFLECTION_SCALES, self.crop, True)
        matrix = torch.tensor(scene_record["matrix"])
        reflection = lit_as_seen(reflection, scene_record, reflected_record, rng.uniform(*ADAPTED))
        if self.colourful and rng.random() < self.colourful:
            reflection = coloured(reflection, rng)
        reflection = muted(reflection)
        level = scene_record["white"]
        ceilings = torch.tensor(scene_record["ceilings"]) / level
        return (
            scene,
            reflection * strength,
            ceilings,
            matrix,
            torch.tensor([level]),
            torch.tensor([reflectance]),
            torch.tensor([float(bool(whole))]),
        )

    def reflected(self, scene_index: int, rng: random.Random) -> int:
        """Any frame but the scene's, or a vivid one for a `vivid` share."""
        chosen = rng.choice(self.vivid_items) if self.vivid and rng.random() < self.vivid else scene_index
        if chosen != scene_index:
            return chosen
        other = rng.randrange(len(self.items) - 1)
        return other + (other >= scene_index)

    def subject(self, scene_index: int, rng: random.Random) -> int:
        """A subject frame but the scene's, or any other frame if the scene is the only one."""
        others = [i for i in self.subject_items if i != scene_index]
        return rng.choice(others) if others else self.reflected(scene_index, rng)


def lit_as_seen(rgb: torch.Tensor, scene_record: dict, reflected_record: dict, adapted: float = 1.0) -> torch.Tensor:
    """A (3, H, W) reflection re-balanced from its camera's white balance towards the scene's, at the same
    mean light: a lamp-lit room in a daylight window comes out orange. `adapted` is the share of the way,
    in stops, from staying as its own camera balanced it (0) to the scene's balance (1). Exact for one
    camera; across cameras, each sensor's own colour leaves a slight tint."""
    gains = (torch.tensor(scene_record["ceilings"]) / torch.tensor(reflected_record["ceilings"])) ** adapted
    seen_by = torch.tensor(scene_record["matrix"]) @ torch.diag(gains) @ torch.linalg.inv(
        torch.tensor(reflected_record["matrix"])
    )
    seen = torch.einsum("ij,jhw->ihw", seen_by, rgb).clamp(min=0)
    return seen * (rgb.mean() / seen.mean().clamp(min=1e-8))


def muted(rgb: torch.Tensor) -> torch.Tensor:
    """A (3, H, W) reflection drawn towards grey until its mean colour's channels spread no more than
    `COLOUR_SPREAD` of their mean, at the same mean light."""
    mean = rgb.mean((1, 2))
    spread = float((mean.max() - mean.min()) / mean.mean().clamp(min=1e-8))
    if spread <= COLOUR_SPREAD:
        return rgb
    grey = rgb.mean(0, keepdim=True)
    return (grey + (rgb - grey) * (COLOUR_SPREAD / spread)).clamp(min=0)


def coloured(rgb: torch.Tensor, rng: random.Random) -> torch.Tensor:
    """A (3, H, W) reflection `turned` to a uniformly drawn hue."""
    return turned(rgb, rng.uniform(0, 2 * math.pi))


def turned(rgb: torch.Tensor, angle: float) -> torch.Tensor:
    """A (3, H, W) reflection turned `angle` radians about the grey axis, keeping its light and, short of a
    channel going below black, its saturation."""
    axis = torch.full((3,), 1 / math.sqrt(3))
    across = torch.tensor([[0.0, -axis[2], axis[1]], [axis[2], 0.0, -axis[0]], [-axis[1], axis[0], 0.0]])
    turn = math.cos(angle) * torch.eye(3) + math.sin(angle) * across + (1 - math.cos(angle)) * torch.outer(axis, axis)
    turn = turn.to(rgb.device)
    rotated = torch.einsum("ij,jhw->ihw", turn, rgb).clamp(min=0)
    return rotated * (rgb.mean() / rotated.mean().clamp(min=1e-8))


def tinted(rgb: torch.Tensor, hue: float, spread: float) -> torch.Tensor:
    """A (3, H, W) image whose mean colour is `hue`, radians from red towards green, with channels
    spreading `spread` of their mean, keeping its light and how its colour varies across the frame."""
    red, green_less_blue = math.cos(hue) / math.sqrt(6), math.sin(hue) / math.sqrt(2)
    across = torch.tensor([2 * red, green_less_blue - red, -green_less_blue - red])
    gains = 1 + across * (spread / float(across.max() - across.min()))
    mean = rgb.mean((1, 2)).clamp(min=1e-8)
    return rgb * (gains.to(rgb.device) * mean.mean() / mean)[:, None, None]


def around(frame: np.ndarray, record: dict, face: list[float], rng: random.Random, crop: int) -> torch.Tensor:
    """A (3, crop, crop) view of `frame` holding `face`, (x0, y0, x1, y1) in 0..1 of it, at a `FACE_ROOM`
    of its height, mirrored half the time, rotated, sheared and stretched, with the face anywhere within
    `FACE_PLACE` of the centre; normalised to the frame's white."""
    height, width = frame.shape[1:]
    face_height = (face[3] - face[1]) * height
    side = min(face_height * math.exp(rng.uniform(*map(math.log, FACE_ROOM))), min(height, width))
    light = torch.from_numpy(np.ascontiguousarray(frame, np.float32))[None]
    # Shrunk by area first: sampling a large window straight down to the crop would alias.
    shrink = max(1.0, side / crop)
    if shrink > 1:
        light = F.interpolate(light, size=(max(2, round(height / shrink)), max(2, round(width / shrink))), mode="area")
    small_height, small_width = light.shape[2:]
    turn = math.radians(rng.uniform(-FACE_TURN, FACE_TURN))
    stretch = math.exp(rng.uniform(*map(math.log, FACE_STRETCH)))
    mirror = -1.0 if rng.random() < 0.5 else 1.0
    linear = (
        torch.tensor([[math.cos(turn), -math.sin(turn)], [math.sin(turn), math.cos(turn)]])
        @ torch.tensor([[1.0, rng.uniform(-FACE_SHEAR, FACE_SHEAR)], [0.0, 1.0]])
        @ torch.diag(torch.tensor([mirror * math.sqrt(stretch), 1 / math.sqrt(stretch)]))
    )
    # Output pixels, crop-centred, to source pixels of the shrunk frame, about where the face lands.
    lands = torch.tensor([rng.uniform(-FACE_PLACE, FACE_PLACE), rng.uniform(-FACE_PLACE, FACE_PLACE)]) * crop
    centre = torch.tensor([(face[0] + face[2]) / 2 * small_width, (face[1] + face[3]) / 2 * small_height])
    steps = (torch.arange(crop, dtype=torch.float32) + 0.5) - crop / 2
    ys, xs = torch.meshgrid(steps, steps, indexing="ij")
    offsets = torch.stack([xs, ys], -1) - lands
    source = centre + (offsets @ linear.T) * (side / shrink / crop)
    grid = torch.stack([source[..., 0] / small_width, source[..., 1] / small_height], -1) * 2 - 1
    # "border", not "reflection": a window past the frame's edge would otherwise mirror the face into a second one.
    sampled = F.grid_sample(light, grid[None], mode="bilinear", padding_mode="border", align_corners=False)
    return sampled[0] / record["white"]


def view(
    frame: np.ndarray,
    record: dict,
    rng: random.Random,
    scales: tuple[float, float],
    crop: int = CROP,
    mirrored: bool = False,
) -> torch.Tensor:
    """A square of the upright `frame`, never turned, so the network learns which way up a photograph
    goes; `mirrored` left to right, as a window shows what it reflects."""
    height, width = frame.shape[1:]
    scale = rng.uniform(max(scales[0], crop / min(height, width)), scales[1])
    side = min(round(crop / scale), height, width)
    y, x = rng.randrange(height - side + 1), rng.randrange(width - side + 1)
    square = torch.from_numpy(np.ascontiguousarray(frame[:, y : y + side, x : x + side], np.float32))
    square = F.interpolate(square[None], size=(crop, crop), mode="bilinear", antialias=True, align_corners=False)[0]
    if mirrored:
        square = square.flip(-1)
    return square.contiguous() / record["white"]


class Composite(NamedTuple):
    mixed: torch.Tensor
    """(B, 3, H, W) the photograph through glass, as the library decodes it."""
    scene: torch.Tensor
    """(B, 3, H, W) the scene behind the glass, blurred as the photograph shows it."""
    clean: torch.Tensor
    """(B, 3, H, W) the scene photographed through no glass, as the library decodes it."""
    layer: torch.Tensor
    """(B, 3, H, W) the reflection the photograph holds."""
    kept: torch.Tensor
    """(B, 1, H, W) where nothing clipped."""
    scene_blur: torch.Tensor
    """(B,) each scene's blur, as `BLUR` draws it; 0 where it's sharp."""
    reflection_blur: torch.Tensor
    veiled: torch.Tensor
    """(B,) the pairs whose reflection is a veil or near."""
    glared: torch.Tensor
    """(B,) the pairs with a glare."""
    scale: torch.Tensor
    """(B, 1, 1, 1) what every layer was multiplied by to bring the photograph's own white to its drawn
    exposure."""
    fins: torch.Tensor
    """(B, 1, H, W) where a dashboard vent's fins are, as `finned` marks them; 0 without one."""


class Pending(NamedTuple):
    """A composite whose develops may still be running: `finished` waits for them."""

    scene: torch.Tensor
    layer: torch.Tensor
    kept: torch.Tensor
    scene_blur: torch.Tensor
    reflection_blur: torch.Tensor
    veiled: torch.Tensor
    glared: torch.Tensor
    levels: torch.Tensor
    exposures: torch.Tensor
    metered: torch.Tensor
    """(B, 1, 1, 1) what the scene and its reflection were multiplied by before the sensor recorded them."""
    developing: Future
    """Of each (B, H, W, 3) develop: the photograph's, and the scene's or None."""
    fins: torch.Tensor


def composite(
    scene: torch.Tensor,
    reflected: torch.Tensor,
    ceilings: torch.Tensor,
    matrices: torch.Tensor,
    levels: torch.Tensor,
    reflectances: torch.Tensor,
    subjects: torch.Tensor | None = None,
) -> Composite:
    """The photograph through glass of each (B, 3, H, W) `scene` with `reflected` in it, recorded by the
    camera `Pairs` describes, the glass reflecting more towards whichever edge of the frame looks at it
    more obliquely. The draws come from the CPU's global RNG, so seeding it repeats them."""
    return finished(started(scene, reflected, ceilings, matrices, levels, reflectances, subjects))


def started(
    scene: torch.Tensor,
    reflected: torch.Tensor,
    ceilings: torch.Tensor,
    matrices: torch.Tensor,
    levels: torch.Tensor,
    reflectances: torch.Tensor,
    subjects: torch.Tensor | None = None,
    cleaned: bool = True,
    developer: Executor | None = None,
    metered: torch.Tensor | None = None,
    broad_colours: bool = False,
    broad_levels: bool = False,
    near_subjects: bool = False,
    scene_casts: bool = False,
    faint_broads: float = 0.0,
    green_broads: float = 0.0,
    vent_share: float = 0.0,
) -> Pending:
    """`composite` up to the develops, which run on `developer` when given. Without `cleaned`, the
    scene goes undeveloped and `clean` holds it as light. `metered` replaces the camera's own metering,
    so a twin of the same glass can be exposed as the photograph it mirrors. `broad_colours` tints every
    veil, near reflection and glare to a uniformly drawn hue at a `BROAD_SPREAD`; `broad_levels` gives each
    a `BROAD_LEVEL` of light. `near_subjects` reflects `NEAR_SUBJECT_SHARE` of the (B, 1) `subjects`, the
    pairs whose reflection is a subject or a face `Pairs` framed, as that person standing at the glass.
    `scene_casts` tints a `SCENE_CAST_SHARE` of scenes, and so what's behind the glass, to a uniformly drawn hue,
    leaving `SCENE_CAST_CLEAN_SHARE` of those without a reflection. With `broad_colours`, a `faint_broads` share
    of tints are drawn at a `BROAD_FAINT` spread instead, and a `green_broads` share at a `GREEN_HUES` hue. A
    `vent_share` of far veils and whole glares, the washes a windscreen shows, gain a sunlit dashboard and its vent along
    the frame's bottom, as `vents` draws them."""
    batch, _, height, width = scene.shape
    device = scene.device

    def drawn(low: float, high: float, logarithmic: bool = False) -> torch.Tensor:
        if logarithmic:
            low, high = math.log(low), math.log(high)
        values = low + (high - low) * torch.rand(batch)
        return (values.exp() if logarithmic else values).to(device)

    cast = torch.zeros(batch, dtype=torch.bool)
    if scene_casts:
        cast = torch.rand(batch) < SCENE_CAST_SHARE
        hues, cast_spreads = drawn(0, 2 * math.pi).tolist(), drawn(*SCENE_CAST_SPREAD, logarithmic=True).tolist()
        scene = torch.stack(
            [
                tinted(image, hue, spread) if c else image
                for image, hue, spread, c in zip(scene, hues, cast_spreads, cast.tolist())
            ]
        )
    scene, scene_blur = softened(scene, 1 - SOFT_SCENE_SHARE, SCENE_VARYING_SHARE)
    layer, reflection_blur = softened(reflected, SHARP_REFLECTION_SHARE, REFLECTION_VARYING_SHARE)
    ghosted = torch.rand(batch) < GHOST_SHARE
    reach = math.ceil(GHOST_SHIFT[1])
    distance, heading = drawn(*GHOST_SHIFT, logarithmic=True).cpu(), drawn(0, 2 * math.pi).cpu()
    corners = (torch.stack([heading.sin(), heading.cos()], 1) * distance[:, None]).round().long() + reach
    padded = F.pad(layer, (reach,) * 4, mode="reflect")
    ghost = torch.stack([padded[i, :, y : y + height, x : x + width] for i, (y, x) in enumerate(corners.tolist())])
    layer = layer + ghost * (drawn(*GHOST_STRENGTH) * ghosted.to(device))[:, None, None, None]

    veils = torch.rand(batch) < VEIL_SHARE
    spreads = drawn(*VEIL_SPREAD, logarithmic=True)
    layer = torch.stack(
        [
            defocused(image, spread) if veil else current
            for image, current, spread, veil in zip(reflected, layer, spreads.tolist(), veils.tolist())
        ]
    )
    reflection_blur = torch.where(veils.to(device), spreads, reflection_blur)

    nears = (torch.rand(batch) < NEAR_SHARE) & ~veils
    shown = drawn(*NEAR_SHOWN, logarithmic=True).tolist()
    near_spreads = drawn(*NEAR_SPREAD, logarithmic=True)
    corners = torch.rand(batch, 2).tolist()
    if near_subjects and subjects is not None:
        # `Pairs` already framed the face, so a standing face is defocused, never magnified again.
        standing = subjects.flatten().cpu().bool() & (torch.rand(batch) < NEAR_SUBJECT_SHARE)
        veils = veils & ~standing
        nears = nears | standing
        shown = [1.0 if stand else share for share, stand in zip(shown, standing.tolist())]
        subject_spreads = drawn(*NEAR_SUBJECT_SPREAD, logarithmic=True)
        near_spreads = torch.where(standing.to(device), subject_spreads, near_spreads)
    layer = torch.stack(
        [
            defocused(magnified(image, share, corner), spread) if near else current
            for image, current, share, corner, spread, near in zip(
                reflected, layer, shown, corners, near_spreads.tolist(), nears.tolist()
            )
        ]
    )
    reflection_blur = torch.where(nears.to(device), near_spreads, reflection_blur)
    distant = veils
    veils = veils | nears
    veiled = veils.to(device)
    tints: list[tuple[float, float] | None] = [None] * batch
    if broad_colours:
        hues, tint_spreads = drawn(0, 2 * math.pi), drawn(*BROAD_SPREAD, logarithmic=True)
        if faint_broads:
            faint = (torch.rand(batch) < faint_broads).to(device)
            tint_spreads = torch.where(faint, drawn(*BROAD_FAINT), tint_spreads)
        if green_broads:
            green = (torch.rand(batch) < green_broads).to(device)
            hues = torch.where(green, drawn(*(math.radians(degrees) for degrees in GREEN_HUES)), hues)
        tints = list(zip(hues.tolist(), tint_spreads.tolist()))

    def broad(light: torch.Tensor, tint: tuple[float, float] | None) -> torch.Tensor:
        return light if tint is None else tinted(light, *tint)

    if broad_colours:
        layer = torch.stack([broad(current, tint) if veil else current for current, tint, veil in zip(layer, tints, veils.tolist())])

    glares = (torch.rand(batch) < GLARE_SHARE) & ~veils
    over = torch.rand(batch) < GLARE_OVER_SHARE
    unevenness = GLARE_UNEVENNESS[0] + (GLARE_UNEVENNESS[1] - GLARE_UNEVENNESS[0]) * torch.rand(batch)
    lifts = torch.exp(math.log(GLARE_LIFT[0]) + (math.log(GLARE_LIFT[1]) - math.log(GLARE_LIFT[0])) * torch.rand(batch))
    if glares.any():
        middles = scene.mean(1).flatten(1).median(1).values
        layer = torch.stack(
            [
                current * keep + broad(glare(image, drift), tint) * (lift * middle) if glaring else current
                for image, current, drift, lift, middle, glaring, keep, tint in zip(
                    reflected, layer, unevenness.tolist(), lifts.tolist(), middles, glares.tolist(), over.tolist(), tints
                )
            ]
        )
    glared = glares.to(device)
    reflection_blur = torch.where((glares & ~over).to(device), float(max(height, width)), reflection_blur)

    ys = torch.linspace(-1, 1, height, device=device)[:, None]
    xs = torch.linspace(-1, 1, width, device=device)[None, :]
    cut = (torch.rand(batch) < CUT_SHARE).to(device)
    softness = drawn(*CUT_SOFTNESS, logarithmic=True)[:, None, None]
    cut_heading, cut_at = drawn(0, 2 * math.pi)[:, None, None], drawn(-0.8, 0.8)[:, None, None]
    across_cut = cut_heading.cos() * xs + cut_heading.sin() * ys - cut_at
    shade = torch.where(cut[:, None, None], torch.sigmoid(across_cut / (2 * softness)), 1.0)
    # A patchy shade cuts a glare into blobs that read as defocused objects, not a wash.
    patchy = ((torch.rand(batch) < PATCHY_SHARE) & ~glares).tolist()
    shade = shade * torch.stack([depth(height, width, device, SHADE_EDGE) if p else torch.ones_like(shade[0]) for p in patchy])
    layer = layer * shade[:, None]

    meterings, exposures = 2 ** drawn(*EXPOSURE_STOPS), 2 ** drawn(*EXPOSURE_STOPS)
    present = (torch.rand(batch) >= torch.where(cast, SCENE_CAST_CLEAN_SHARE, CLEAN_SHARE)).to(device)
    veiled = veiled & present
    glared = glared & present
    heading = drawn(0, 2 * math.pi)[:, None, None]
    centre = incidence(reflectances.to(device).flatten())[:, None, None]
    turn = drawn(*HALF_VIEW)[:, None, None] * (heading.cos() * xs + heading.sin() * ys)
    across = (fresnel((centre + turn).abs().clamp(max=GRAZING)) / fresnel(centre)).clamp(max=EDGE_GAIN)
    layer = layer * (present[:, None, None] * across)[:, None]
    gain = shared(scene, layer)
    if broad_levels:
        # Brightened where need be, unlike `shared`: blurred or flat, a broad layer holds no noise to raise.
        most = BROAD_MOST_SHARE * scene.mean((1, 2, 3)) / (1 - BROAD_MOST_SHARE)
        levelled = torch.minimum(drawn(*BROAD_LEVEL, logarithmic=True), most) / layer.mean((1, 2, 3)).clamp(min=1e-9)
        gain = torch.where((veils | glares).to(device), levelled, gain)
    layer = layer * gain[:, None, None, None]
    fins = torch.zeros(batch, 1, height, width, device=device)
    if vent_share:
        venting = (((torch.rand(batch) < vent_share) & (distant | glares & ~over)).to(device) & present).float()
        vent = vents(batch, height, width, device) * venting[:, None, None, None]
        layer = layer + vent
        fins = finned(vent)

    if metered is None:
        metered = (meterings / white(scene).clamp(min=1e-6))[:, None, None, None]
    scene, layer = scene * metered, layer * metered
    photographed, kept = recorded(scene + layer, ceilings, matrices, levels)
    behind = recorded(scene, ceilings, matrices, levels)[0] if cleaned else None

    def develop() -> tuple[np.ndarray, np.ndarray | None]:
        return developed(*photographed), developed(*behind) if behind is not None else None

    if developer is not None:
        developing = developer.submit(develop)
    else:
        developing = Future()
        developing.set_result(develop())
    return Pending(
        scene, layer, kept, scene_blur, reflection_blur, veiled, glared, levels, exposures, metered, developing, fins
    )


def finned(vent: torch.Tensor) -> torch.Tensor:
    """(B, 1, H, W) where a (B, 3, H, W) vent's fins and openings are, 0 to 1 of each image's sharpest: the light's
    departure from its own horizontal blur, which leaves the smooth glow out."""
    light = vent.mean(1, keepdim=True)
    reach = VENT_FIN_REACH // 2
    detail = (light - F.avg_pool2d(light, (1, VENT_FIN_REACH), 1, (0, reach), count_include_pad=False)).abs()
    return detail / detail.amax((1, 2, 3), keepdim=True).clamp(min=1e-9)


def finished(pending: Pending, scale: torch.Tensor | None = None) -> Composite:
    """The composite, normalised by `scale` when given, else as a photograph is for use: to its own white."""
    photographed, behind = pending.developing.result()
    device, level = pending.scene.device, pending.levels[:, :, None, None]
    mixed = torch.from_numpy(photographed).to(device).permute(0, 3, 1, 2) / level
    clean = torch.from_numpy(behind).to(device).permute(0, 3, 1, 2) / level if behind is not None else pending.scene
    if scale is None:
        # Not the scene's white: a strong reflection raises the photograph's, so "brighter than white" would
        # mark it in training and never in use, where every photograph's white is 1.
        scale = (pending.exposures / white(mixed).clamp(min=1e-6))[:, None, None, None]
    return Composite(
        mixed * scale,
        pending.scene * scale,
        clean * scale,
        pending.layer * scale,
        pending.kept,
        pending.scene_blur,
        pending.reflection_blur,
        pending.veiled,
        pending.glared,
        scale,
        pending.fins,
    )


def shared(scene: torch.Tensor, layer: torch.Tensor) -> torch.Tensor:
    """(B,) what brings each (B, 3, H, W) `layer`'s share of the photograph's light from `DRAWN_SHARES` to
    `SHARES` at the same rank."""
    drawn, real = (torch.tensor(table, device=scene.device) for table in (DRAWN_SHARES, SHARES))
    light, behind = layer.mean((1, 2, 3)), scene.mean((1, 2, 3))
    share = (light / (behind + light).clamp(min=1e-9)).clamp(drawn[0], drawn[-1])
    high = torch.searchsorted(drawn, share.contiguous()).clamp(1, len(drawn) - 1)
    along = (share - drawn[high - 1]) / (drawn[high] - drawn[high - 1])
    target = real[high - 1] + along * (real[high] - real[high - 1])
    # Never brightened: a dark frame raised to a share it never had brings its noise and colour cast with it.
    return (target * behind / ((1 - target) * light).clamp(min=1e-9)).clamp(max=1.0)


def fresnel(degrees: torch.Tensor) -> torch.Tensor:
    """Unpolarised light's reflectance off one surface of glass, at each angle of incidence."""
    incident = torch.deg2rad(degrees)
    cos_in = incident.cos()
    cos_out = (1 - (incident.sin() / GLASS_INDEX) ** 2).sqrt()
    across = ((cos_in - GLASS_INDEX * cos_out) / (cos_in + GLASS_INDEX * cos_out)) ** 2
    along = ((cos_out - GLASS_INDEX * cos_in) / (cos_out + GLASS_INDEX * cos_in)) ** 2
    return (across + along) / 2


def incidence(reflectance: torch.Tensor) -> torch.Tensor:
    """The angle at which `fresnel` gives each `reflectance`."""
    degrees = torch.linspace(0, GRAZING, 1024, device=reflectance.device)
    table = fresnel(degrees)
    above = torch.searchsorted(table, reflectance.contiguous()).clamp(1, len(table) - 1)
    low, high = table[above - 1], table[above]
    share = ((reflectance - low) / (high - low)).clamp(0, 1)
    return degrees[above - 1] + share * (degrees[above] - degrees[above - 1])


def recorded(
    rgb: torch.Tensor, ceilings: torch.Tensor, matrices: torch.Tensor, levels: torch.Tensor
) -> tuple[tuple[np.ndarray, np.ndarray, np.ndarray], torch.Tensor]:
    """(B, 3, H, W) Rec.2020 light as each camera's sensor records it, clipped at `ceilings`, ready for
    `developed`: mosaics, each one's light and matrix; and where nothing clipped."""
    camera = torch.einsum("bij,bjhw->bihw", torch.linalg.inv(matrices), rgb).clamp(min=0)
    ceiling = ceilings[:, :, None, None]
    kept = (camera < ceiling * CLIP_TOLERANCE).all(1, keepdim=True)
    sensed = torch.minimum(camera, ceiling) * levels[:, :, None, None]
    batch, _, height, width = rgb.shape
    # A site of 2x2 photosites a pixel, which the decode's halving reads back as that pixel.
    mosaic = sensed.new_empty(batch, 2 * height, 2 * width)
    mosaic[:, 0::2, 0::2] = sensed[:, 0]
    mosaic[:, 0::2, 1::2] = sensed[:, 1]
    mosaic[:, 1::2, 0::2] = sensed[:, 1]
    mosaic[:, 1::2, 1::2] = sensed[:, 2]
    return (mosaic.cpu().numpy(), (ceilings * levels).cpu().numpy(), matrices.cpu().numpy()), kept


def developed(mosaics: np.ndarray, lights: np.ndarray, matrices: np.ndarray) -> np.ndarray:
    """Each mosaic as the library decodes it, highlights reconstructed: (B, H / 2, W / 2, 3) Rec.2020."""
    server = pmrid()
    return np.stack([server.develop(*job) for job in zip(mosaics, lights, matrices)])


def softened(rgb: torch.Tensor, sharp_share: float, varying_share: float) -> tuple[torch.Tensor, torch.Tensor]:
    """(B, 3, H, W) `rgb` with all but a `sharp_share` of its images blurred by a Gaussian, a disc or a
    motion streak, a `varying_share` of those by an amount varying across the frame; and each blur's
    size, 0 for none."""
    batch = rgb.shape[0]
    sizes = torch.exp(math.log(BLUR[0]) + (math.log(BLUR[1]) - math.log(BLUR[0])) * torch.rand(batch))
    sizes = sizes * (torch.rand(batch) >= sharp_share)
    kinds, angles, varying = torch.rand(batch), torch.rand(batch) * math.pi, torch.rand(batch) < varying_share
    images = []
    for image, size, kind, angle, varies in zip(rgb, sizes.tolist(), kinds.tolist(), angles.tolist(), varying.tolist()):
        if not size:
            images.append(image)
            continue
        kernel = streak if kind < MOTION_SHARE else disc if kind < MOTION_SHARE + DISC_SHARE else None
        if not varies:
            images.append(spread_by(image, kernel, size, angle))
            continue
        place = depth(*image.shape[1:], rgb.device) * (DEPTH_LEVELS - 1)
        levels = [image] + [spread_by(image, kernel, size * k / (DEPTH_LEVELS - 1), angle) for k in range(1, DEPTH_LEVELS)]
        images.append(sum((1 - (place - k).abs()).clamp(min=0) * level for k, level in enumerate(levels)))
    return torch.stack(images), sizes.to(rgb.device)


def spread_by(image: torch.Tensor, kernel: Kernel | None, spread: float, angle: float) -> torch.Tensor:
    """(3, H, W) `image` through `kernel`, or a Gaussian where it's None."""
    if kernel is None:
        return blurred(image[None], torch.tensor([spread], device=image.device))[0]
    taps = kernel(spread, angle, image.device)
    reach = taps.shape[-1] // 2
    return F.conv2d(F.pad(image[None], (reach,) * 4, mode="reflect"), taps.expand(3, 1, -1, -1), groups=3)[0]


def defocused(image: torch.Tensor, spread: float) -> torch.Tensor:
    """(3, H, W) `image` through a lens disc whose standard deviation is `spread` pixels."""
    shrink = max(1.0, spread / DISC_WORKING_SPREAD)
    height, width = image.shape[1:]
    small = F.interpolate(image[None], size=(round(height / shrink), round(width / shrink)), mode="area")[0]
    spread_out = spread_by(small, disc, spread / shrink, 0.0)
    return F.interpolate(spread_out[None], size=(height, width), mode="bilinear", align_corners=False)[0]


def magnified(image: torch.Tensor, share: float, corner: list[float]) -> torch.Tensor:
    """(3, H, W) `image`'s window `share` of its sides, placed at `corner` (y, x) in 0..1 of the room
    around it, scaled back up to (H, W)."""
    height, width = image.shape[1:]
    tall, wide = max(2, round(height * share)), max(2, round(width * share))
    y, x = round(corner[0] * (height - tall)), round(corner[1] * (width - wide))
    window = image[None, :, y : y + tall, x : x + wide]
    return F.interpolate(window, size=(height, width), mode="bilinear", align_corners=False)[0]


def glare(image: torch.Tensor, unevenness: float) -> torch.Tensor:
    """(3, H, W) `image`'s mean colour, drawn some way towards grey, at a mean light of 1 over the frame
    with a smooth random drift between 1 - `unevenness` and 1 + `unevenness`."""
    height, width = image.shape[1:]
    colour = image.mean((1, 2))
    grey = colour.mean()
    colour = (grey + (colour - grey) * float(torch.rand(()))) / grey.clamp(min=1e-6)
    grid = int(torch.randint(GLARE_GRID[0], GLARE_GRID[1] + 1, ()))
    # Drawn on the CPU like every other draw here, so the invariance twin's replayed state repeats it.
    field = torch.rand(1, 1, grid, grid).to(image.device)
    field = F.interpolate(field, size=(height, width), mode="bicubic", align_corners=False)[0]
    field = field - field.mean()
    drift = 1 + unevenness * field / field.abs().max().clamp(min=1e-6)
    return colour[:, None, None] * drift


def depth(height: int, width: int, device: torch.device, edge: tuple[float, float] = DEPTH_EDGE) -> torch.Tensor:
    """(H, W) from 0, sharp, to 1, blurred most: a random smooth field stepped at a random threshold, as
    steeply as `edge` draws."""
    grid = int(torch.randint(DEPTH_GRID[0], DEPTH_GRID[1] + 1, ()))
    field = F.interpolate(torch.rand(1, 1, grid, grid).to(device), size=(height, width), mode="bicubic", align_corners=False)[0, 0]
    field = (field - field.min()) / (field.max() - field.min()).clamp(min=1e-6)
    steepness = math.exp(math.log(edge[0]) + (math.log(edge[1]) - math.log(edge[0])) * float(torch.rand(())))
    stepped = torch.sigmoid((field - (0.2 + 0.6 * float(torch.rand(())))) * steepness)
    return (stepped - stepped.min()) / (stepped.max() - stepped.min()).clamp(min=1e-6)


def disc(spread: float, _angle: float, device: torch.device) -> torch.Tensor:
    """A lens's defocus, antialiased: a disc of radius twice `spread`, which is its standard deviation."""
    radius = 2 * spread
    offsets = torch.arange(-math.ceil(radius), math.ceil(radius) + 1, device=device, dtype=torch.float32)
    taps = (radius + 0.5 - torch.hypot(offsets[:, None], offsets[None, :])).clamp(0, 1)
    return taps / taps.sum()


def streak(spread: float, angle: float, device: torch.device) -> torch.Tensor:
    """Motion, antialiased: a line at `angle` whose length has `spread` as its standard deviation."""
    half = math.sqrt(3) * spread
    offsets = torch.arange(-math.ceil(half) - 1, math.ceil(half) + 2, device=device, dtype=torch.float32)
    ys, xs = offsets[:, None], offsets[None, :]
    along = (xs * math.cos(angle) + ys * math.sin(angle)).clamp(-half, half)
    taps = (1 - torch.hypot(xs - along * math.cos(angle), ys - along * math.sin(angle))).clamp(min=0)
    return taps / taps.sum()


def vents(batch: int, height: int, width: int, device: torch.device) -> torch.Tensor:
    """(B, 3, H, W) light of a sunlit dashboard reflected in the windscreen above it, nearly grey, its glow at a
    `VENT_LEVEL` of the scene's white where it's brightest and lit fins up to `VENT_FIN_LIGHT` times the glow.

    Lengths are in the glass's rise from the dashboard to the roof. The glass leans back at `WINDSCREEN_RAKE` from
    the dashboard, so the camera, looking forward, sees in the glass at height h above the dashboard a dashboard
    point x = h (1 / tan(rake) + 1 / tan(2 rake)) behind the glass's foot, r = h / sin(2 rake) along the
    reflected ray. Frames span `VENT_SPAN` of the rise from `VENT_FOOT` up. Skylight reaches that point through
    the windscreen from the horizon up to the glass's top edge, 1 / tan(rake) behind the foot, so a point further
    back sees a narrower window of sky; sun, a `VENT_SUN` share of the light, lights the dashboard short of where
    the roof's edge shadows it at the sun's `SUN_ELEVATION`. The dashboard's top rounds over towards the cabin by
    `DASHBOARD_CURL` and ends `DASHBOARD_DEPTH` back: turned away from the windscreen, each point takes the light
    by the cosine of its angle to it, 1 - cos(window - tilt) of the sky, sin(elevation - tilt) of the sun, so
    the glow falls off towards the dashboard's back. A vent's grille sits there: a dark opening crossed by lit fins
    running fore and aft; with `DASH_OBJECTS`, `dashboard` draws panels, paper and stickers over it all. The
    glass's foot is `CAMERA_DISTANCE` from the camera; the glass at height h is h / tan(rake) nearer and the dashboard r beyond it, so the reflection comes
    nearer with height for any rake under 45 degrees: the fins converge downwards on a point far below the frame,
    widening and blurring with height, the camera focused far past them. Light itself doesn't fall with distance: a
    lit surface's radiance is the same from any range."""

    def drawn(low: float, high: float, logarithmic: bool = False) -> torch.Tensor:
        if logarithmic:
            low, high = math.log(low), math.log(high)
        # The CPU's generator, which a twin replays: the same glass shows the same vent.
        values = low + (high - low) * torch.rand(batch, 1, 1)
        return (values.exp() if logarithmic else values).to(device)

    tall = EDGE / VENT_FRAME_ASPECT
    ys = 1 - torch.linspace(1, 0, height, device=device)[None, :, None] * min(height / tall, 1)
    share = min(width / EDGE, 1)
    left = drawn(0, 1 - share)
    xs = left + torch.linspace(0, 1, width, device=device)[None, None, :] * share
    roll = torch.deg2rad(drawn(*VENT_ROLL)).tan()
    level = xs
    xs = xs - roll * tall / EDGE * (ys - ys.mean())
    ys = ys + roll * EDGE / tall * (level - 0.5) + drawn(*VENT_BOW) * (2 * level - 1) ** 2
    rake = torch.deg2rad(drawn(*WINDSCREEN_RAKE))
    run = 1 / rake.tan()
    foot_rise = drawn(*VENT_FOOT)
    span = drawn(*VENT_SPAN)
    rise = foot_rise + (1 - ys) * span
    per_rise = run + 1 / (2 * rake).tan()
    back = rise * per_rise

    depth = drawn(*DASHBOARD_DEPTH)
    tilt = torch.deg2rad(drawn(*DASHBOARD_CURL)) * (back / depth).clamp(0, 1) ** 2
    window = torch.atan2(torch.ones_like(back), back - run)
    sky = (1 - (window - tilt).cos()) / (1 - torch.atan2(torch.ones_like(run), -run).cos())
    sun = torch.deg2rad(drawn(*SUN_ELEVATION))
    sunlit = torch.sigmoid((run + 1 / sun.tan() - back) / VENT_SHADOW_EDGE) * ((sun - tilt).sin() / sun.sin()).clamp(min=0)
    sun_share = drawn(*VENT_SUN)
    glow = (1 - sun_share) * sky + sun_share * sunlit
    glow = glow * torch.sigmoid((depth - back) / VENT_SHADOW_EDGE)
    glow = glow * (1 + drawn(-VENT_SIDE_LIGHT, VENT_SIDE_LIGHT) * (2 * xs - 1)).clamp(min=0)

    foot = drawn(*CAMERA_DISTANCE)
    nearing = run - 1 / (2 * rake).sin()
    bottom = foot - foot_rise * nearing
    scale = (foot - rise * nearing) / bottom
    end = (foot - depth / per_rise * nearing).clamp(min=0.1 * foot) / bottom
    heading = drawn(*VENT_HEADING)
    across = (xs - heading) * scale
    centre = left + drawn(*VENT_PLACE) * share - heading
    period = drawn(*VENT_PERIOD, logarithmic=True) / EDGE
    phase = torch.remainder(across / period, 1)
    fins = torch.sigmoid((drawn(*VENT_DUTY) - phase) * period * EDGE / 0.75)
    # In the dashboard's own coordinate, so the grille rolls and bows with it.
    start = foot_rise * per_rise - drawn(*VENT_START)
    rows = torch.randint(VENT_ROWS[0], VENT_ROWS[1] + 1, (batch, 1, 1)).to(device)
    row = drawn(*VENT_ROW_DEPTH, logarithmic=True)
    bar = row * drawn(*VENT_ROW_BAR)
    pitch = row + bar
    within = torch.remainder(back - start, pitch)
    on_grille = (
        torch.sigmoid((back - start) * VENT_ROW_EDGE)
        * torch.sigmoid((start + rows * pitch - bar - back) * VENT_ROW_EDGE)
        * torch.sigmoid((row - within) * VENT_ROW_EDGE)
    )
    columns = torch.sigmoid((drawn(*VENT_WIDTH) / 2 - (across - centre).abs()) * EDGE / 2)
    if DASH_OBJECTS:
        columns = columns * (torch.rand(batch, 1, 1) < VENT_GRILLE_SHARE).to(device)
    grille = on_grille * columns
    opening = drawn(*VENT_HOLE_LIGHT) * (torch.rand(batch, 1, 1) >= VENT_BLACK_SHARE).to(device)
    fin_light = drawn(*VENT_FIN_LIGHT, logarithmic=True)
    spread, seed = drawn(*VENT_FIN_SPREAD), drawn(0, 1000)
    # A hash of each fin's index, so a fin keeps its own light along its length and through the blur.
    index = torch.floor(across / period)
    jitter = torch.remainder(torch.sin(index * 12.9898 + seed * 78.233) * 43758.5453, 1)
    strays = torch.exp(spread * (2 * jitter - 1))
    lit = fin_light * strays
    far = start + rows * pitch - bar
    overhang = drawn(*VENT_FIN_OVERHANG) * row
    tops = drawn(*VENT_FIN_TOP_LIGHT, logarithmic=True) * strays
    above = ((1 - (back - far) / overhang.clamp(min=1e-6)).clamp(0, 1) * torch.sigmoid((back - far) * VENT_ROW_EDGE)) * columns
    light = glow * (1 - grille + grille * (opening + (lit - opening) * fins) + above * (tops - 1) * fins)
    light = light.clamp(min=0)[:, None].expand(batch, 3, height, width)
    if DASH_OBJECTS:
        # A frame's width spans `VENT_FRAME_ASPECT` times the rise its height does, at the glass.
        wide = VENT_FRAME_ASPECT * span
        light = dashboard(light, glow[:, None], across * wide, wide, back, depth)

    softness = drawn(*VENT_SOFTNESS, logarithmic=True)
    light = light.contiguous()
    sharp, soft = (blurred(light, (softness / ends).flatten()) for ends in (torch.ones_like(end), end))
    mix = ((scale - end) / (1 - end).clamp(min=1e-6)).clamp(0, 1)[:, None]
    light = soft * (1 - mix) + sharp * mix
    tint = 1 + (torch.rand(batch, 3, 1, 1).to(device) - 0.5) * VENT_TINT
    lit = light * tint * drawn(*VENT_LEVEL, logarithmic=True)[:, None]
    return DASH_MOST * torch.tanh(lit / DASH_MOST) if DASH_OBJECTS else lit


def dashboard(
    light: torch.Tensor,
    glow: torch.Tensor,
    across: torch.Tensor,
    wide: torch.Tensor,
    back: torch.Tensor,
    depth: torch.Tensor,
) -> torch.Tensor:
    """(B, 3, H, W) dashboard `light` with what lies on the dashboard drawn over it, each lit as the (B, 1, H, W)
    `glow` lights the top there: up to `DASH_PANELS` moulded panels, filled or a rim, changing the top's own
    light; up to `DASH_PAPERS` sheets of paper, some printed with lines; up to `DASH_STICKERS` coloured stickers.
    (B, H, W) `across` and `back` are the dashboard's own coordinates, both in the glass's rise; shapes
    lie within the (B, 1, 1) `wide` the frame spans and short of the (B, 1, 1) `depth` the top reaches back to."""
    batch, _, height, width = light.shape
    device = light.device
    u, v = across[:, None], back[:, None]

    def drawn(low: float, high: float, count: int, logarithmic: bool = False) -> torch.Tensor:
        if logarithmic:
            low, high = math.log(low), math.log(high)
        # The CPU's generator, which a twin replays, as `vents`' draws.
        values = low + (high - low) * torch.rand(batch, count, 1, 1)
        return (values.exp() if logarithmic else values).to(device)

    def there(count: int, share: float) -> torch.Tensor:
        return (torch.rand(batch, count, 1, 1) < share).to(device)

    def placed(count: int, half: tuple[tuple[float, float], tuple[float, float]], turning: float) -> torch.Tensor:
        """(B, count, H, W) signed distance in the glass's rise from each of `count` rounded boxes, negative inside."""
        half_u = drawn(*half[0], count, logarithmic=True)
        half_v = drawn(*half[1], count, logarithmic=True)
        radius = torch.minimum(half_u, half_v) * drawn(0, 1, count)
        angle = drawn(-turning, turning, count)
        du = u - drawn(-0.5, 0.5, count) * wide[:, None]
        dv = v - drawn(0, 1, count) * depth[:, None]
        du, dv = du * angle.cos() + dv * angle.sin(), dv * angle.cos() - du * angle.sin()
        qu, qv = du.abs() - half_u + radius, dv.abs() - half_v + radius
        return torch.hypot(qu.clamp(min=0), qv.clamp(min=0)) + torch.maximum(qu, qv).clamp(max=0) - radius

    panels = placed(DASH_PANELS, DASH_PANEL_HALF, 0.0)
    rim = drawn(*DASH_OUTLINE_WIDTH, DASH_PANELS) / 2
    shape = torch.where(there(DASH_PANELS, DASH_OUTLINE_SHARE), panels.abs() - rim, panels)
    covered = torch.sigmoid(-shape * DASH_EDGE) * there(DASH_PANELS, DASH_PANEL_SHARE)
    albedo = drawn(*DASH_PANEL_ALBEDO, DASH_PANELS, logarithmic=True)
    for each in range(DASH_PANELS):
        light = light * (1 + (albedo[:, each : each + 1] - 1) * covered[:, each : each + 1])

    sheets = placed(DASH_PAPERS, DASH_PAPER_HALF, math.pi / 4)
    lines = torch.remainder(v / drawn(*DASH_PAPER_LINES, DASH_PAPERS, logarithmic=True), 1)
    printed = 1 - 0.6 * there(DASH_PAPERS, 0.6) * torch.sigmoid((0.25 - lines) * 8)
    papers = drawn(*DASH_PAPER_ALBEDO, DASH_PAPERS, logarithmic=True) * printed
    on_sheet = torch.sigmoid(-sheets * DASH_EDGE) * there(DASH_PAPERS, DASH_PAPER_SHARE)
    for each in range(DASH_PAPERS):
        mask = on_sheet[:, each : each + 1]
        light = light * (1 - mask) + glow * papers[:, each : each + 1] * mask

    stickers = placed(DASH_STICKERS, (DASH_STICKER_HALF, DASH_STICKER_HALF), math.pi)
    on_sticker = torch.sigmoid(-stickers * DASH_EDGE) * there(DASH_STICKERS, DASH_STICKER_SHARE)
    hue, spread = drawn(0, 2 * math.pi, DASH_STICKERS), drawn(*DASH_STICKER_SPREAD, DASH_STICKERS)
    thirds = torch.tensor([0.0, -2 * math.pi / 3, 2 * math.pi / 3], device=device)[None, None, :]
    colours = (1 + spread[..., 0] * (hue[..., 0] - thirds).cos()).clamp(min=0)
    colours = colours / colours.mean(-1, keepdim=True) * drawn(1.0, 3.0, DASH_STICKERS)[..., 0]
    for each in range(DASH_STICKERS):
        mask = on_sticker[:, each : each + 1]
        light = light * (1 - mask) + glow * colours[:, each, :, None, None] * mask
    return light


def blurred(rgb: torch.Tensor, sigma: torch.Tensor) -> torch.Tensor:
    batch, channels, height, width = rgb.shape
    offsets = torch.arange(-BLUR_REACH, BLUR_REACH + 1, device=rgb.device, dtype=rgb.dtype)
    taps = torch.exp(-0.5 * (offsets[None] / sigma[:, None]) ** 2)
    taps = (taps / taps.sum(1, keepdim=True)).repeat_interleave(channels, 0)
    planes = rgb.reshape(1, batch * channels, height, width)
    planes = F.conv2d(F.pad(planes, (0, 0, BLUR_REACH, BLUR_REACH), mode="reflect"), taps[:, None, :, None], groups=batch * channels)
    planes = F.conv2d(F.pad(planes, (BLUR_REACH, BLUR_REACH, 0, 0), mode="reflect"), taps[:, None, None, :], groups=batch * channels)
    return planes.reshape(rgb.shape)
