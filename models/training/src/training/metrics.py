import torch
import torch.nn.functional as F


def psnr(mse: torch.Tensor) -> float:
    """Against a peak of 1."""
    return float(-10 * torch.log10(mse))


def edge_loss(predicted: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
    """L1 between neighbouring-pixel differences across and along each plane, so a softened edge
    costs its whole slope."""
    across = F.l1_loss(predicted.diff(dim=-2), target.diff(dim=-2))
    along = F.l1_loss(predicted.diff(dim=-1), target.diff(dim=-1))
    return (across + along) / 2


def ssim_map(x: torch.Tensor, y: torch.Tensor, peak: float, window: int = 7) -> torch.Tensor:
    """(B, C, H - window + 1, W - window + 1) structural similarity of each plane over square windows,
    as skimage's `structural_similarity` defaults compute it before averaging."""
    sample = window**2 / (window**2 - 1)

    def mean(plane: torch.Tensor) -> torch.Tensor:
        return F.avg_pool2d(plane, window, 1)

    mx, my = mean(x), mean(y)
    vx, vy = (mean(x * x) - mx * mx) * sample, (mean(y * y) - my * my) * sample
    cxy = (mean(x * y) - mx * my) * sample
    c1, c2 = (0.01 * peak) ** 2, (0.03 * peak) ** 2
    return (2 * mx * my + c1) * (2 * cxy + c2) / ((mx * mx + my * my + c1) * (vx + vy + c2))


def detail(batch: torch.Tensor, cutoff: float) -> torch.Tensor:
    """Amplitude summed over each plane's frequencies past `cutoff` cycles a pixel on either axis."""
    spectrum = torch.fft.rfft2(batch, norm="ortho").abs()
    across = torch.fft.fftfreq(batch.shape[-2], device=batch.device).abs()[:, None]
    along = torch.fft.rfftfreq(batch.shape[-1], device=batch.device)[None, :]
    return spectrum[..., torch.maximum(across, along) > cutoff].sum()
