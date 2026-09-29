//! The noise fit held against the alpha PMRID finds no lift at.
//!
//! ```text
//! noise_alpha <raw>...
//! ```
//!
//! PMRID is only unbiased when its k-sigma transform is handed the frame's real noise, so the lift
//! `pmrid::lift` measures at a model is how wrong that model is, in noise sigmas. Per frame: the
//! fit, the lift at it, and the scale on both its terms at which the lift crosses zero - which is
//! what `ne_finalize`'s `ENVELOPE_RATIO` was set from.

use rawshim::galosh::NoiseFit;

fn main() {
    let gpu = rawshim::gpu::device().expect("an adapter");
    let kernels = rawshim::galosh::device(gpu).expect("the GALOSH kernels");
    let network = rawshim::pmrid::device(gpu).expect("the network's weights");
    println!(
        "{:<16} {:>9} {:>9} {:>7}   {:>9}",
        "frame", "alpha", "sigma_sq", "lift", "zero at"
    );
    for path in std::env::args().skip(1) {
        let bytes = std::fs::read(&path).expect("read the raw");
        let Some(held) = pollster::block_on(rawshim::decode_rawler::hold_bytes(&bytes)) else {
            eprintln!("{path}: not a raw this decodes");
            continue;
        };
        let cfa = held.cfa();
        if !rawshim::pmrid::filters(&cfa) {
            eprintln!("{path}: not a Bayer frame");
            continue;
        }
        let mosaic = held.device_mosaic();
        let fit = pollster::block_on(rawshim::galosh::fit(gpu, kernels, mosaic, &cfa));
        let image = rawler::decode_file(&path).expect("rawler reads the coefficients");
        let gains = rawshim::decode_rawler::channel_ceilings(&image);
        let lift_at = |scale: f64| {
            let fit = NoiseFit {
                alpha: (f64::from(fit.alpha) * scale) as f32,
                sigma_sq: (f64::from(fit.sigma_sq) * scale) as f32,
                ..fit
            };
            pollster::block_on(rawshim::pmrid::lift(gpu, network, mosaic, &cfa, gains, fit))
        };
        let name = std::path::Path::new(&path)
            .file_name()
            .map_or(path.clone(), |name| name.to_string_lossy().to_string());
        let zero = zero_lift(lift_at);
        println!(
            "{name:<16} {:>9.2e} {:>9.2e} {:>7}   {:>9}",
            fit.alpha,
            fit.sigma_sq,
            lift_at(1.0).map_or("-".to_string(), |lift| format!("{lift:+.3}")),
            zero.map_or("-".to_string(), |zero| format!("{zero:.3}")),
        );
    }
}

/// The scale on both of the fit's terms at which the network lifts nothing: the highest crossing
/// from lifting to darkening on a log grid from a twentieth to twenty, bisected.
fn zero_lift(lift_at: impl Fn(f64) -> Option<f64>) -> Option<f64> {
    let grid: Vec<f64> = (0..=24)
        .map(|n| (0.05f64.ln() + n as f64 * 0.25).exp())
        .collect();
    let lifts: Vec<Option<f64>> = grid.iter().map(|scale| lift_at(*scale)).collect();
    let n = (0..grid.len() - 1)
        .rev()
        .find(|&n| matches!((lifts[n], lifts[n + 1]), (Some(a), Some(b)) if a > 0.0 && b <= 0.0))?;
    let (mut low, mut high) = (grid[n].ln(), grid[n + 1].ln());
    for _ in 0..10 {
        let middle = (low + high) / 2.0;
        match lift_at(middle.exp())? > 0.0 {
            true => low = middle,
            false => high = middle,
        }
    }
    Some(((low + high) / 2.0).exp())
}
