import torch
import torch.nn.functional as F


def psnr(mse: torch.Tensor) -> float:
    """Against a peak of 1."""
    return float(-10 * torch.log10(mse))


def spectrum_loss(predicted: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
    """L1 between amplitude spectra, blind to phase."""
    return F.l1_loss(torch.fft.rfft2(predicted, norm="ortho").abs(), torch.fft.rfft2(target, norm="ortho").abs())


def edge_loss(predicted: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
    """L1 between neighbouring-pixel differences across and along each plane, so a softened edge
    costs its whole slope."""
    across = F.l1_loss(predicted.diff(dim=-2), target.diff(dim=-2))
    along = F.l1_loss(predicted.diff(dim=-1), target.diff(dim=-1))
    return (across + along) / 2


def detail(batch: torch.Tensor, cutoff: float) -> torch.Tensor:
    """Amplitude summed over each plane's frequencies past `cutoff` cycles a pixel on either axis."""
    spectrum = torch.fft.rfft2(batch, norm="ortho").abs()
    across = torch.fft.fftfreq(batch.shape[-2], device=batch.device).abs()[:, None]
    along = torch.fft.rfftfreq(batch.shape[-1], device=batch.device)[None, :]
    return spectrum[..., torch.maximum(across, along) > cutoff].sum()
