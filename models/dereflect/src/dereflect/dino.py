"""DINOv2 (Oquab et al., 2023): a vision transformer whose last layer describes what each 14-pixel
patch of a picture shows. The reflection remover reads it, frozen, to know what a photograph is of,
which is what tells a reflection from the scene once neither is blurred. Parameter names are the
released checkpoints', which Meta publishes under Apache 2.0."""

import torch
import torch.nn.functional as F
from torch import nn

from training.crops import DEFAULT_CACHE
from training.files import fetched

BACKBONES = {"vits14": (384, 12, 6)}
"""Width, depth and heads of each released size the remover reads."""
PATCH = 14
TRAINED_GRID = 37
"""Patches a side of the positions were learned for: 518 pixels."""
POSITION_OFFSET = 0.1
SOURCE = "https://dl.fbaipublicfiles.com/dinov2/dinov2_{name}/dinov2_{name}_pretrain.pth"
HASHES = {"vits14": "b938bf1bc15cd2ec0feacfe3a1bb553fe8ea9ca46a7e1d8d00217f29aef60cd9"}
MEAN = (0.485, 0.456, 0.406)
STD = (0.229, 0.224, 0.225)


class Attention(nn.Module):
    def __init__(self, dim: int, heads: int) -> None:
        super().__init__()
        self.heads = heads
        self.qkv = nn.Linear(dim, 3 * dim)
        self.proj = nn.Linear(dim, dim)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        batch, tokens, dim = x.shape
        q, k, v = self.qkv(x).reshape(batch, tokens, 3, self.heads, dim // self.heads).permute(2, 0, 3, 1, 4)
        return self.proj(F.scaled_dot_product_attention(q, k, v).transpose(1, 2).reshape(batch, tokens, dim))


class Mlp(nn.Module):
    def __init__(self, dim: int) -> None:
        super().__init__()
        self.fc1 = nn.Linear(dim, 4 * dim)
        self.fc2 = nn.Linear(4 * dim, dim)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.fc2(F.gelu(self.fc1(x)))


class LayerScale(nn.Module):
    def __init__(self, dim: int) -> None:
        super().__init__()
        self.gamma = nn.Parameter(torch.ones(dim))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return x * self.gamma


class Block(nn.Module):
    def __init__(self, dim: int, heads: int) -> None:
        super().__init__()
        self.norm1 = nn.LayerNorm(dim, eps=1e-6)
        self.attn = Attention(dim, heads)
        self.ls1 = LayerScale(dim)
        self.norm2 = nn.LayerNorm(dim, eps=1e-6)
        self.mlp = Mlp(dim)
        self.ls2 = LayerScale(dim)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = x + self.ls1(self.attn(self.norm1(x)))
        return x + self.ls2(self.mlp(self.norm2(x)))


class PatchEmbed(nn.Module):
    def __init__(self, dim: int) -> None:
        super().__init__()
        self.proj = nn.Conv2d(3, dim, PATCH, PATCH)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.proj(x).flatten(2).transpose(1, 2)


class Dino(nn.Module):
    def __init__(self, name: str) -> None:
        super().__init__()
        self.name = name
        self.width, depth, heads = BACKBONES[name]
        self.patch_embed = PatchEmbed(self.width)
        self.cls_token = nn.Parameter(torch.zeros(1, 1, self.width))
        self.pos_embed = nn.Parameter(torch.zeros(1, 1 + TRAINED_GRID**2, self.width))
        self.mask_token = nn.Parameter(torch.zeros(1, self.width))
        self.blocks = nn.ModuleList(Block(self.width, heads) for _ in range(depth))
        self.norm = nn.LayerNorm(self.width, eps=1e-6)

    def forward(self, coded: torch.Tensor, rows: int, columns: int) -> torch.Tensor:
        """(B, 3, H, W) light coded by `stabilise`, to (B, width, `rows`, `columns`): the description
        of each patch, the picture resized to fit that grid exactly."""
        given = F.interpolate(coded, size=(rows * PATCH, columns * PATCH), mode="bilinear", antialias=True)
        mean, std = (torch.tensor(v, device=coded.device, dtype=coded.dtype)[:, None, None] for v in (MEAN, STD))
        # Coded light is near enough sRGB's curve for the features, which were trained on sRGB.
        x = self.patch_embed((given.clamp(0, 1) - mean) / std)
        x = torch.cat([self.cls_token.expand(x.shape[0], -1, -1), x], 1) + self.positions(rows, columns)
        for block in self.blocks:
            x = block(x)
        x = self.norm(x)
        return x[:, 1:].transpose(1, 2).reshape(x.shape[0], self.width, rows, columns)

    def positions(self, rows: int, columns: int) -> torch.Tensor:
        """As Meta's `interpolate_pos_encoding`, its scale offset included, which the features were
        trained with."""
        if rows == columns == TRAINED_GRID:
            return self.pos_embed
        learned = self.pos_embed[:, 1:].reshape(1, TRAINED_GRID, TRAINED_GRID, self.width).permute(0, 3, 1, 2)
        scale = ((rows + POSITION_OFFSET) / TRAINED_GRID, (columns + POSITION_OFFSET) / TRAINED_GRID)
        grid = F.interpolate(learned, scale_factor=scale, mode="bicubic")
        return torch.cat([self.pos_embed[:, :1], grid.flatten(2).transpose(1, 2)], 1)


def load(name: str) -> Dino:
    """The released `name`, fetched once into the cache and checked against its pinned hash, frozen."""
    path = fetched(SOURCE.format(name=name), DEFAULT_CACHE.parent / "dinov2" / f"dinov2_{name}_pretrain.pth", HASHES[name])
    net = Dino(name)
    net.load_state_dict(torch.load(path, map_location="cpu", weights_only=True))
    return net.eval().requires_grad_(False)
