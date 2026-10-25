"""LightRR (Yin et al., CVPR 2026, `models/arch/lightrr.py`) on its deployed path: a U-Net of
Asymmetric Frequency Mamba blocks with Haar wavelet resampling, `LightRR_9M`'s widths. Parameter
names are LightRR's, which `native/rawshim/examples/dereflect.rs` reads.

Departures: the scan is `scan.selective_scan`, the last layer predicts the reflection, coded
as its input is, rather than adding a correction to the input, the two coarsest levels hold more
blocks, where the network sees the most of the picture at once, a frozen DINOv2 can tell the
coarsest level what the picture shows, through an adapter of its own, a gate scales the reflection
by where the network locates one, and the network can run twice, the second time on what the
first left."""

import math
from collections.abc import Callable
from pathlib import Path

import torch
import torch.nn.functional as F
from torch import nn
from torch.utils.checkpoint import checkpoint

from dereflect import dino
from dereflect.scan import DIRECTIONS, STATE, selective_scan
from training.export import load_exported
from training.mosaic import STABILISER_FLOOR, stabilise, unstabilise

DIMS = [32, 64, 128, 256]
BLOCKS = [2, 3, 6, 10]
HEADS = [4, 2, 1]
EXPAND = 2
CONV_KERNEL = 3
DT_MIN = 1e-3
DT_MAX = 0.1
DT_FLOOR = 1e-4
MULTIPLE = 16
"""Each side of an input: three halvings, and a fourth inside the coarsest level's blocks."""
HINTS = 2
"""Brush channels after the image's three: where the user marked reflection, and where they marked none."""
OPEN_GATE = 5.0
"""The location gate's starting logit: `look` divides out `OPEN_SHARE`, so a gate at it passes
everything, as `load` sets one for weights without it."""
OPEN_SHARE = 1 / (1 + math.exp(-OPEN_GATE))


def dwt(x: torch.Tensor) -> torch.Tensor:
    """Haar, as `torch_wavelets.DWT_2D('haar')`: (B, C, H, W) to (B, 4C, H/2, W/2), LL then LH, HL, HH."""
    a, b, c, d = F.pixel_unshuffle(x, 2).unflatten(1, (-1, 4)).unbind(2)
    return torch.cat([a + b + c + d, a + b - c - d, a - b + c - d, a - b - c + d], 1) / 2


def idwt(bands: torch.Tensor) -> torch.Tensor:
    ll, lh, hl, hh = bands.chunk(4, 1)
    corners = [ll + lh + hl + hh, ll + lh - hl - hh, ll - lh + hl - hh, ll - lh - hl + hh]
    return F.pixel_shuffle(torch.stack(corners, 2).flatten(1, 2), 2) / 2


class LowFrequencyScan(nn.Module):
    """`AFM_LowFrequencySSM`: the LL band through the four-direction scan, the other bands past it."""

    def __init__(self, dim: int) -> None:
        super().__init__()
        inner = EXPAND * dim
        self.inner = inner
        self.rank = math.ceil(dim / 16)
        self.in_proj = nn.Linear(dim, 2 * inner, bias=False)
        self.DWConv2d = nn.Conv2d(4 * inner, 4 * inner, CONV_KERNEL, padding=CONV_KERNEL // 2, groups=4 * inner)
        projected = self.rank + 2 * STATE
        bound = inner**-0.5
        self.x_proj_weight = nn.Parameter(torch.empty(DIRECTIONS, projected, inner).uniform_(-bound, bound))
        dt_bound = self.rank**-0.5
        self.dt_projs_weight = nn.Parameter(torch.empty(DIRECTIONS, inner, self.rank).uniform_(-dt_bound, dt_bound))
        dt = torch.exp(torch.rand(DIRECTIONS, inner) * (math.log(DT_MAX) - math.log(DT_MIN)) + math.log(DT_MIN))
        dt = dt.clamp(min=DT_FLOOR)
        self.dt_projs_bias = nn.Parameter(dt + torch.log(-torch.expm1(-dt)))
        self.A_logs = nn.Parameter(torch.log(torch.arange(1, STATE + 1, dtype=torch.float32)).repeat(DIRECTIONS * inner, 1))
        self.Ds = nn.Parameter(torch.ones(DIRECTIONS * inner))
        self.out_norm = nn.LayerNorm(inner)
        self.out_proj = nn.Linear(inner, dim, bias=False)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """(B, H, W, C) to the same."""
        x, z = self.in_proj(x).chunk(2, -1)
        bands = F.silu(self.DWConv2d(dwt(x.permute(0, 3, 1, 2))))
        low = self.scanned(bands[:, : self.inner])
        y = idwt(torch.cat([low.to(bands.dtype), bands[:, self.inner :]], 1)).permute(0, 2, 3, 1)
        return self.out_proj(self.out_norm(y) * F.silu(z))

    def scanned(self, low: torch.Tensor) -> torch.Tensor:
        """The four directions' scans of (B, D, h, w), summed back in place: rows, columns, then each
        reversed."""
        height, width = low.shape[2:]
        with torch.autocast("cuda", enabled=False):
            rows = low.float().flatten(2)
            columns = low.float().transpose(2, 3).flatten(2)
            sequences = torch.stack([rows, columns, rows.flip(-1), columns.flip(-1)], 1)
            projected = torch.einsum("bkdl,kcd->bkcl", sequences, self.x_proj_weight.float())
            dts, b, c = projected.split([self.rank, STATE, STATE], 2)
            dts = torch.einsum("bkrl,kdr->bkdl", dts, self.dt_projs_weight.float())
            delta = F.softplus(dts + self.dt_projs_bias.float()[None, :, :, None])
            y = selective_scan(sequences, delta, -torch.exp(self.A_logs.float()), b, c, self.Ds.float())
            along_rows = y[:, 0] + y[:, 2].flip(-1)
            along_columns = (y[:, 1] + y[:, 3].flip(-1)).unflatten(-1, (width, height)).transpose(2, 3)
        return along_rows.unflatten(-1, (height, width)) + along_columns


class Block(nn.Module):
    """`AFMBlock`: `x * skip_scale + scan(ln_1(x))`, on (B, C, H, W)."""

    def __init__(self, dim: int) -> None:
        super().__init__()
        self.ln_1 = nn.LayerNorm(dim)
        self.self_attention = LowFrequencyScan(dim)
        self.skip_scale = nn.Parameter(torch.ones(dim))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        last = x.permute(0, 2, 3, 1)
        return (last * self.skip_scale + self.self_attention(self.ln_1(last))).permute(0, 3, 1, 2)


class Stage(nn.Module):
    """Blocks in turn; with `checkpointed`, each recomputes its activations in the backward pass rather than
    keeping them."""

    def __init__(self, dim: int, blocks: int) -> None:
        super().__init__()
        self.blocks = nn.ModuleList(Block(dim) for _ in range(blocks))
        self.checkpointed = False

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        for block in self.blocks:
            x = checkpoint(block, x, use_reentrant=False) if self.checkpointed and torch.is_grad_enabled() else block(x)
        return x


class ChannelAttention(nn.Module):
    """`CrossChannelAtt`: attention across channels, queries from one input, keys and values the other."""

    def __init__(self, channels: int, heads: int) -> None:
        super().__init__()
        self.heads = heads
        self.temperature = nn.Parameter(torch.ones(1, heads, 1, 1))
        self.q = nn.Conv2d(channels, channels, 1, bias=False)
        self.q_conv = nn.Conv2d(channels, channels, 3, padding=1, groups=channels, bias=False)
        self.kv = nn.Conv2d(channels, 2 * channels, 1, bias=False)
        self.kv_conv = nn.Conv2d(2 * channels, 2 * channels, 3, padding=1, groups=2 * channels, bias=False)
        self.project_out = nn.Conv2d(channels, channels, 1, bias=False)

    def forward(self, q: torch.Tensor, kv: torch.Tensor) -> torch.Tensor:
        batch, channels, height, width = q.shape
        q = self.q_conv(self.q(q)).reshape(batch, self.heads, -1, height * width)
        k, v = (t.reshape(batch, self.heads, -1, height * width) for t in self.kv_conv(self.kv(kv)).chunk(2, 1))
        attention = (F.normalize(q, dim=-1) @ F.normalize(k, dim=-1).transpose(-2, -1)) * self.temperature
        return self.project_out((attention.softmax(-1) @ v).reshape(batch, channels, height, width))


class Fusion(nn.Module):
    """`CrossScaleFusion` of one attention: `attention(q, kv) + kv * alpha + q * beta`."""

    def __init__(self, channels: int, heads: int) -> None:
        super().__init__()
        self.blocks = nn.ModuleList([ChannelAttention(channels, heads)])
        self.alpha = nn.Parameter(torch.ones(1))
        self.beta = nn.Parameter(torch.zeros(1))

    def forward(self, q: torch.Tensor, kv: torch.Tensor) -> torch.Tensor:
        return self.blocks[0](q, kv) + kv * self.alpha + q * self.beta


class Down(nn.Module):
    """`WDD`."""

    def __init__(self, channels: int) -> None:
        super().__init__()
        self.body = nn.Conv2d(channels, 2 * channels, 3, padding=1, bias=False)

    def forward(self, x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        channels = x.shape[1]
        bands = dwt(x)
        low = bands[:, :channels]
        return self.body(low), low, bands[:, channels:]


class Up(nn.Module):
    """`WSU`."""

    def __init__(self, channels: int) -> None:
        super().__init__()
        self.reduce = nn.Conv2d(channels, channels // 2, 3, padding=1, bias=False)

    def forward(self, y: torch.Tensor, attended: torch.Tensor, high: torch.Tensor) -> torch.Tensor:
        return idwt(torch.cat([self.reduce(torch.cat([y, attended], 1)), high], 1))


class Adapter(nn.Module):
    """A backbone's description of each patch, (B, width, h, w), to an addition to the coarsest level's
    input, (B, `DIMS[-1]`, h, w). Starts adding nothing."""

    def __init__(self, width: int) -> None:
        super().__init__()
        self.norm = nn.LayerNorm(width)
        self.inner = nn.Linear(width, DIMS[-1])
        self.out = nn.Linear(DIMS[-1], DIMS[-1])
        nn.init.zeros_(self.out.weight)
        nn.init.zeros_(self.out.bias)

    def forward(self, described: torch.Tensor) -> torch.Tensor:
        return self.out(F.gelu(self.inner(self.norm(described.permute(0, 2, 3, 1))))).permute(0, 3, 1, 2)


class Shared:
    """A module outside its holder's parameters and state dict, which copies of the holder share."""

    def __init__(self, net: nn.Module) -> None:
        self.net = net

    def __deepcopy__(self, memo: dict) -> "Shared":
        return self


class LightRR(nn.Module):
    """(B, 3, H, W) coded light to the reflection in it, coded the same; H and W multiples of
    `MULTIPLE`. Starts predicting no reflection. Reads DINOv2's `backbone`, one of `dino.BACKBONES`,
    when given one; its weights stay out of the network's, and any size can replace another once an
    adapter is trained for it. With `passes` 2 it looks again at what its first look left, and takes
    out what it finds there too; `once` makes it look once whatever `passes` says, as training does.
    `locating` adds a fourth channel: the logit of where the last look saw reflection, which gates
    what it takes out. The backbone's last `retuned` blocks train with the network. An input may carry
    `HINTS` more channels, 0 to 1, after its three; they start changing nothing."""

    def __init__(
        self, blocks: list[int] = BLOCKS, backbone: str | None = None, passes: int = 1, retuned: int = 0
    ) -> None:
        super().__init__()
        self.passes = passes
        self.once = False
        self.locating = False
        self.backbone = backbone
        self.described = Shared(dino.load(backbone)) if backbone else None
        self.semantics = Adapter(dino.BACKBONES[backbone][0]) if backbone else None
        self.retuned = dino.Tail(self.described.net, retuned) if self.described is not None and retuned else None
        self.img_tokenizer = nn.Conv2d(3, DIMS[0], 3, padding=1, bias=False)
        self.hint_tokenizer = nn.Conv2d(HINTS, DIMS[0], 3, padding=1, bias=False)
        nn.init.zeros_(self.hint_tokenizer.weight)
        self.encoders = nn.ModuleList(Stage(dim, count) for dim, count in zip(DIMS, blocks))
        self.downs = nn.ModuleList(Down(dim) for dim in DIMS[:-1])
        self.middlers = nn.ModuleList(Stage(DIMS[level], blocks[level]) for level in (2, 1, 0))
        self.reduces = nn.ModuleList(nn.Conv2d(DIMS[level + 1], DIMS[level], 1, bias=False) for level in (2, 1, 0))
        self.restormer_attentions = nn.ModuleList(Fusion(DIMS[level], heads) for level, heads in zip((2, 1, 0), HEADS))
        self.ups = nn.ModuleList(Up(DIMS[level + 1]) for level in (2, 1, 0))
        self.decoders = nn.ModuleList(Stage(DIMS[level], blocks[level]) for level in (3, 2, 1))
        self.output = nn.Conv2d(2 * DIMS[0], 3, 3, padding=1, bias=False)
        nn.init.zeros_(self.output.weight)
        self.locate = nn.Conv2d(2 * DIMS[0], 1, 3, padding=1)
        nn.init.zeros_(self.locate.weight)
        nn.init.constant_(self.locate.bias, OPEN_GATE)

    def forward(self, image: torch.Tensor) -> torch.Tensor:
        if self.passes == 1 or self.once:
            return self.look(image)
        hints = image[:, 3:]
        mixed = unstabilise(image[:, :3])
        left = removing(mixed, self.look(image)[:, :3])
        second = self.look(torch.cat([stabilise(left), hints], 1))
        return torch.cat([taken(mixed, left, second[:, :3]), second[:, 3:]], 1)

    def look(self, given: torch.Tensor) -> torch.Tensor:
        image, hints = given[:, :3], given[:, 3:]
        x = self.img_tokenizer(image)
        if hints.shape[1]:
            x = x + self.hint_tokenizer(hints)
        encoded, high, low = [], [], []
        for level, encoder in enumerate(self.encoders):
            if level == len(self.downs) and self.described is not None and self.semantics is not None:
                x = x + self.semantics(self.describe(image, x.shape[-2:]))
            x = encoder(x)
            encoded.append(x)
            if level < len(self.downs):
                x, ll, hf = self.downs[level](x)
                low.append(ll)
                high.append(hf)
        x = encoded[-1]
        for i, level in enumerate((2, 1, 0)):
            y = self.reduces[i](self.decoders[i](x))
            attended = self.restormer_attentions[i](y, self.middlers[i](low[level]))
            x = self.ups[i](y, attended, high[level])
        features = torch.cat([x, encoded[0]], 1)
        located = self.locate(features)
        coded = self.output(features) * (torch.sigmoid(located) / OPEN_SHARE)
        return torch.cat([coded, located], 1) if self.locating else coded

    def describe(self, image: torch.Tensor, size: torch.Size) -> torch.Tensor:
        """The backbone's description of `image`, a patch per two of the coarsest level's pixels,
        spread over `size`."""
        assert self.described is not None
        net, rows, columns = self.described.net, math.ceil(size[0] / 2), math.ceil(size[1] / 2)
        if self.retuned is None:
            with torch.no_grad():
                patches = net(image, rows, columns)
        else:
            with torch.no_grad():
                tokens = net.trunk(image, rows, columns, len(net.blocks) - self.retuned.depth)
            patches = self.retuned(tokens, rows, columns)
        return F.interpolate(patches, size=size, mode="bilinear", align_corners=False)

    def _apply(self, fn: Callable[[torch.Tensor], torch.Tensor], recurse: bool = True) -> "LightRR":
        if self.described is not None:
            self.described.net._apply(fn, recurse)
        return super()._apply(fn, recurse)


def removing(mixed: torch.Tensor, coded: torch.Tensor) -> torch.Tensor:
    """The linear photograph `mixed` with the network's `coded` reflection taken out in linear light,
    never below black."""
    return mixed - torch.minimum(unstabilise(coded).clamp(min=0), mixed)


def taken(mixed: torch.Tensor, left: torch.Tensor, coded: torch.Tensor) -> torch.Tensor:
    """All a second look takes out of linear `mixed`, coded: the first's, which left `left`, and the
    second's `coded` reflection of what was left."""
    return stabilise(mixed - removing(left, coded))


def load(
    weights: Path, blocks: list[int] | None = None, backbone: str | None = None, retuned: int | None = None
) -> LightRR:
    """The exported weights in the folder `weights`; given `blocks`, deepened to them by blocks that
    pass their input through unchanged, so the network computes what it did. Given a `backbone` other
    than the one saved, the saved adapter goes and a new one starts adding nothing. Given `retuned`,
    that many of the backbone's last blocks train, starting from the saved ones or the released."""
    exported = load_exported(weights)
    if exported.plan.get("predicts") != "reflection" or exported.plan.get("coding_floor") != STABILISER_FLOOR:
        raise SystemExit(f"{weights} predicts {exported.plan.get('predicts')} under another coding")
    saved = exported.plan.get("blocks", BLOCKS)
    if blocks is not None and any(want < have for want, have in zip(blocks, saved)):
        raise SystemExit(f"{weights} has blocks {saved}, more than {blocks} somewhere")
    reading = backbone or exported.plan.get("semantics")
    saved_retuned = exported.plan.get("retuned", 0)
    depth = saved_retuned if retuned is None else retuned
    net = LightRR(saved if blocks is None else blocks, reading, exported.plan.get("passes", 1), depth)
    state = exported.state
    if reading != exported.plan.get("semantics"):
        state = {name: value for name, value in state.items() if not name.startswith(("semantics.", "retuned."))}
    elif depth != saved_retuned:
        state = {name: value for name, value in state.items() if not name.startswith("retuned.")}
    added = net.load_state_dict(state, strict=False).missing_keys
    lacking = [
        name
        for name in added
        if ".blocks." not in name and not name.startswith(("semantics.", "locate.", "retuned.", "hint_tokenizer."))
    ]
    if lacking:
        raise SystemExit(f"{weights} lacks {lacking}")
    with torch.no_grad():
        for name in added:
            if name.endswith("self_attention.out_proj.weight"):
                net.get_parameter(name).zero_()
    return net
