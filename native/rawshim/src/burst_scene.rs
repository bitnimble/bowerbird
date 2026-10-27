//! A handheld burst whose every displacement is known: an analytic scene photographed through a
//! per-frame shake, integrated over each photosite and the exposure, sampled through a Bayer
//! filter and given a sensor's noise.

use rayon::prelude::*;

const WAVES: usize = 40;
const DISCS: usize = 24;
/// The waves' standard deviation about the scene's mean light.
const CONTRAST: f64 = 0.1;

pub struct Scene {
    waves: Vec<[f64; 4]>,
    discs: Vec<[f64; 4]>,
}

/// How one frame's sensor moved against the scene.
#[derive(Clone, Copy, Default)]
pub struct Shake {
    pub shift: [f64; 2],
    pub roll: f64,
    /// Where the last row was read against the first, the rolling shutter's skew.
    pub drift: [f64; 2],
    /// The straight part of the path a point travels during the exposure.
    pub blur: [f64; 2],
    /// How far that path bows out of a line, at its middle.
    pub bend: [f64; 2],
    /// A tremor across the exposure: amplitude in x and y, then cycles.
    pub tremor: [f64; 3],
}

#[derive(Clone, Copy)]
pub struct Noise {
    pub alpha: f64,
    pub sigma_sq: f64,
}

struct Random(u64);

impl Random {
    fn next(&mut self) -> f64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (self.0 >> 11) as f64 / (1u64 << 53) as f64
    }
}

impl Scene {
    pub fn new(seed: u64) -> Scene {
        let mut random = Random(seed.wrapping_mul(0x9e3779b97f4a7c15) | 1);
        let waves = (0..WAVES)
            .map(|_| {
                let cycles = 0.004 * (0.8f64 / 0.004).powf(random.next());
                let angle = random.next() * std::f64::consts::TAU;
                let k = cycles * std::f64::consts::TAU;
                [
                    k * angle.cos(),
                    k * angle.sin(),
                    random.next() * std::f64::consts::TAU,
                    // Equal amplitude at log-spaced frequencies is a photograph's equal energy a
                    // octave.
                    CONTRAST * (2.0 / WAVES as f64).sqrt(),
                ]
            })
            .collect();
        let discs = (0..DISCS)
            .map(|_| {
                [
                    random.next() * 1536.0,
                    random.next() * 1024.0,
                    8.0 + random.next() * 120.0,
                    (random.next() - 0.5) * 0.3,
                ]
            })
            .collect();
        Scene { waves, discs }
    }

    pub fn at(&self, x: f64, y: f64, channel: usize) -> f64 {
        let mut light = 0.4;
        for &[kx, ky, phase, amplitude] in &self.waves {
            light += amplitude * (kx * x + ky * y + phase).sin();
        }
        for &[cx, cy, radius, step] in &self.discs {
            let edge = radius - ((x - cx).powi(2) + (y - cy).powi(2)).sqrt();
            light += step * 0.5 * (1.0 + (edge * 3.0).tanh());
        }
        let tint = 0.85 + 0.15 * (x * 0.0021 + y * 0.0013 + channel as f64 * 2.1).sin();
        (light * tint).clamp(0.02, 0.95)
    }
}

impl Shake {
    fn scene_at(&self, x: f64, y: f64, height: f64, centre: [f64; 2], time: f64) -> [f64; 2] {
        let (sin, cos) = self.roll.sin_cos();
        let (dx, dy) = (x - centre[0], y - centre[1]);
        let read = y / height - 0.5;
        let [path_x, path_y] = self.path(time);
        [
            centre[0] + cos * dx - sin * dy + self.shift[0] + self.drift[0] * read + path_x,
            centre[1] + sin * dx + cos * dy + self.shift[1] + self.drift[1] * read + path_y,
        ]
    }

    /// Where the exposure has carried a point at `time` in -0.5..0.5, zero on average so the
    /// blur is centred on `shift`.
    fn path(&self, time: f64) -> [f64; 2] {
        let bow = 4.0 * time * time - 1.0 / 3.0;
        let [ax, ay, cycles] = self.tremor;
        let wave = (cycles * std::f64::consts::TAU * time).sin();
        [
            self.blur[0] * time + self.bend[0] * bow + ax * wave,
            self.blur[1] * time + self.bend[1] * bow + ay * wave,
        ]
    }

    fn travel(&self) -> f64 {
        let [ax, ay, cycles] = self.tremor;
        self.blur[0].hypot(self.blur[1])
            + 2.0 * self.bend[0].hypot(self.bend[1])
            + 2.0 * ax.hypot(ay) * cycles.max(1.0)
    }
}

pub struct Burst {
    pub width: usize,
    pub height: usize,
    pub cfa: mosaic::cfa::Cfa,
    pub shakes: Vec<Shake>,
    pub subject: Option<Subject>,
    pub focus: Option<Focus>,
}

/// Even frames in focus left of `split` and odd frames right of it, the rest of each frame a disc
/// of `radius` out of focus.
#[derive(Clone, Copy)]
pub struct Focus {
    pub split: f64,
    pub radius: f64,
}

/// A flat disc moving across the scene by `step` a frame, which no alignment can follow.
#[derive(Clone, Copy)]
pub struct Subject {
    pub centre: [f64; 2],
    pub radius: f64,
    pub step: [f64; 2],
    pub light: f64,
}

impl Subject {
    fn covers(&self, frame: usize, x: f64, y: f64) -> bool {
        let cx = self.centre[0] + self.step[0] * frame as f64;
        let cy = self.centre[1] + self.step[1] * frame as f64;
        (x - cx).hypot(y - cy) <= self.radius
    }
}

impl Burst {
    fn centre(&self) -> [f64; 2] {
        [self.width as f64 * 0.5, self.height as f64 * 0.5]
    }

    /// Frame `frame`, given `exposure` times the reference's light, saturating at 1.
    pub fn photograph(
        &self,
        scene: &Scene,
        frame: usize,
        exposure: f64,
        noise: Option<Noise>,
    ) -> Vec<f32> {
        let shake = self.shakes[frame];
        let centre = self.centre();
        let height = self.height as f64;
        let moments = (shake.travel() * 2.0).ceil().max(1.0) as usize;
        let within = [-1.0 / 3.0, 0.0, 1.0 / 3.0];
        (0..self.width * self.height)
            .into_par_iter()
            .map(|index| {
                let (x, y) = (index % self.width, index / self.width);
                let channel = usize::from(self.cfa.colour_at(y, x));
                let mut sum = 0.0;
                for moment in 0..moments {
                    let time = (moment as f64 + 0.5) / moments as f64 - 0.5;
                    for oy in within {
                        for ox in within {
                            let [sx, sy] =
                                shake.scene_at(x as f64 + ox, y as f64 + oy, height, centre, time);
                            sum += self.seen(scene, frame, x as f64, [sx, sy], channel);
                        }
                    }
                }
                let light = exposure * sum / (moments * 9) as f64;
                let deviation = noise.map_or(0.0, |noise| {
                    (noise.alpha * light + noise.sigma_sq).max(0.0).sqrt()
                });
                (light + deviation * gaussian(x, y, frame)).min(1.0) as f32
            })
            .collect()
    }

    /// The light photosite column `x` of `frame` gathers from scene point `at`, through its focus.
    fn seen(&self, scene: &Scene, frame: usize, x: f64, at: [f64; 2], channel: usize) -> f64 {
        let sharp = self.light(scene, frame, at[0], at[1], channel);
        let Some(focus) = self.focus else {
            return sharp;
        };
        if (x < focus.split) == (frame % 2 == 0) {
            return sharp;
        }
        let ring: f64 = (0..8)
            .map(|k| {
                let (sin, cos) = (k as f64 * std::f64::consts::TAU / 8.0).sin_cos();
                let (dx, dy) = (focus.radius * cos, focus.radius * sin);
                self.light(scene, frame, at[0] + dx, at[1] + dy, channel)
            })
            .sum();
        (sharp + ring) / 9.0
    }

    fn light(&self, scene: &Scene, frame: usize, x: f64, y: f64, channel: usize) -> f64 {
        match self.subject {
            Some(subject) if subject.covers(frame, x, y) => subject.light,
            _ => scene.at(x, y, channel),
        }
    }

    /// What a merge onto `scale` pixels a photosite should find, starting at photosite
    /// `(left, top)` of the reference: every channel over one photosite's aperture, no mosaic, no
    /// noise.
    pub fn truth(
        &self,
        scene: &Scene,
        (left, top): (usize, usize),
        (width, height): (usize, usize),
        scale: usize,
    ) -> Vec<f32> {
        let shake = self.shakes[0];
        let centre = self.centre();
        let rows = self.height as f64;
        let within = [-1.0 / 3.0, 0.0, 1.0 / 3.0];
        (0..width * height * 3)
            .into_par_iter()
            .map(|index| {
                let (pixel, channel) = (index / 3, index % 3);
                let x = left as f64 + ((pixel % width) as f64 + 0.5) / scale as f64 - 0.5;
                let y = top as f64 + ((pixel / width) as f64 + 0.5) / scale as f64 - 0.5;
                let mut sum = 0.0;
                for oy in within {
                    for ox in within {
                        let [sx, sy] = shake.scene_at(x + ox, y + oy, rows, centre, 0.0);
                        sum += self.light(scene, 0, sx, sy, channel);
                    }
                }
                (sum / 9.0) as f32
            })
            .collect()
    }

    /// Where `frame` saw what the reference saw at sensor `(x, y)`, as an offset from `(x, y)`.
    pub fn displacement(&self, frame: usize, x: f64, y: f64) -> [f64; 2] {
        let centre = self.centre();
        let height = self.height as f64;
        let want = self.shakes[0].scene_at(x, y, height, centre, 0.0);
        let (sin, cos) = self.shakes[frame].roll.sin_cos();
        let mut at = [x, y];
        for _ in 0..20 {
            let got = self.shakes[frame].scene_at(at[0], at[1], height, centre, 0.0);
            let (ex, ey) = (want[0] - got[0], want[1] - got[1]);
            at[0] += cos * ex + sin * ey;
            at[1] += -sin * ex + cos * ey;
        }
        [at[0] - x, at[1] - y]
    }
}

fn gaussian(x: usize, y: usize, frame: usize) -> f64 {
    let hash = |salt: u32| {
        let mut h = (x as u32).wrapping_mul(0x9e3779b9)
            ^ (y as u32).wrapping_mul(0x85ebca6b)
            ^ (frame as u32).wrapping_mul(0xc2b2ae35)
            ^ salt.wrapping_mul(0x27d4eb2f);
        h ^= h >> 16;
        h = h.wrapping_mul(0x7feb352d);
        h ^= h >> 15;
        h = h.wrapping_mul(0x846ca68b);
        h ^= h >> 16;
        (h as f64 + 0.5) / (u32::MAX as f64 + 1.0)
    };
    (-2.0 * hash(1).ln()).sqrt() * (std::f64::consts::TAU * hash(2)).cos()
}

#[cfg(test)]
mod tests {
    use super::{Burst, Focus, Noise, Random, Scene, Shake, Subject};
    use crate::align::{self, Exposure};
    use crate::burst::Offset;
    use crate::merge::{Frame, Grid, Merge};
    use denoise::galosh::NoiseModel;
    use units::px::{At, Rect};

    const WIDTH: usize = 1024;
    const HEIGHT: usize = 768;
    const HIGH_ISO: Noise = Noise {
        alpha: 0.002,
        sigma_sq: 0.0001,
    };
    const BASE_ISO: Noise = Noise {
        alpha: 0.0001,
        sigma_sq: 0.000001,
    };

    fn read(gpu: &'static gpu::Gpu, buffer: &gpu::Buffer, count: usize) -> Vec<f32> {
        pollster::block_on(gpu::read_floats(gpu, buffer, count)).expect("read back")
    }

    struct Accuracy {
        rms: f64,
        /// The error every tile shares.
        offset: f64,
        /// The rms about that shared error.
        spread: f64,
        found: usize,
        tiles: usize,
    }

    #[derive(Clone, Copy)]
    struct Case {
        name: &'static str,
        shake: Shake,
        noise: Option<Noise>,
        /// The frame's light against the reference's.
        exposure: f64,
        /// How far a lopsided blur may sit every tile off its centroid.
        lopsided: f64,
    }

    fn accuracy(case: Case) -> Option<Accuracy> {
        let gpu = gpu::device()?;
        let burst = Burst {
            width: WIDTH,
            height: HEIGHT,
            cfa: mosaic::cfa::Cfa::bayer([0, 1, 1, 2]).unwrap(),
            shakes: vec![Shake::default(), case.shake],
            subject: None,
            focus: None,
        };
        let scene = Scene::new(7);
        let upload = |frame, exposure| {
            mosaic::condition::Mosaic::upload(
                gpu,
                &burst.photograph(&scene, frame, exposure, case.noise),
                WIDTH,
                HEIGHT,
            )
        };
        let (reference, frame) = (upload(0, 1.0), upload(1, case.exposure));
        let white = |gain| align::Exposure {
            gain,
            ceilings: [1.0; 4],
        };
        let pyramid = align::Pyramid::of(gpu, &reference, white(1.0));
        let window = Rect::exact(256, 256, WIDTH - 512, HEIGHT - 512);
        let field = align::measure(
            gpu,
            &pyramid,
            &frame,
            white((1.0 / case.exposure) as f32),
            At::ORIGIN,
            At::ORIGIN,
            window,
            |x, y| {
                let [dx, dy] = burst.displacement(1, x, y);
                Offset::exactly((dx + 2.6).round(), (dy - 3.3).round())
            },
            align::Search::AROUND_PRIOR,
        );
        let values = read(gpu, &field.buffer, field.width * field.height * 4);
        let tile = align::TILE.raw() as f64;
        let mut errors = Vec::new();
        let mut tiles = 0;
        for ty in 0..field.height {
            for tx in 0..field.width {
                let x = field.left as f64 + tx as f64 * tile + tile * 0.5;
                let y = field.top as f64 + ty as f64 * tile + tile * 0.5;
                if x < 256.0 || y < 256.0 || x > (WIDTH - 256) as f64 || y > (HEIGHT - 256) as f64 {
                    continue;
                }
                tiles += 1;
                let at = (ty * field.width + tx) * 4;
                if values[at + 3] == 0.0 {
                    continue;
                }
                let [dx, dy] = burst.displacement(1, x, y);
                errors.push([values[at] as f64 - dx, values[at + 1] as f64 - dy]);
            }
        }
        let found = errors.len().max(1) as f64;
        let mean = errors.iter().fold([0.0, 0.0], |sum, e| {
            [sum[0] + e[0] / found, sum[1] + e[1] / found]
        });
        let rms_about = |centre: [f64; 2]| {
            let squared: f64 = errors
                .iter()
                .map(|e| (e[0] - centre[0]).powi(2) + (e[1] - centre[1]).powi(2))
                .sum();
            (squared / found).sqrt()
        };
        Some(Accuracy {
            rms: rms_about([0.0, 0.0]),
            offset: mean[0].hypot(mean[1]),
            spread: rms_about(mean),
            found: errors.len(),
            tiles,
        })
    }

    #[test]
    fn the_aligner_finds_a_handheld_burst_to_a_tenth_of_a_photosite() {
        let shift = [13.37, -7.81];
        let roll = 0.15f64.to_radians();
        let drift = [2.4, -1.1];
        let handheld = Shake {
            shift,
            roll,
            drift,
            ..Shake::default()
        };
        let straight = Shake {
            blur: [3.0, 1.2],
            ..handheld
        };
        let tremor = Shake {
            tremor: [0.8, 0.5, 1.5],
            ..straight
        };
        let bowed = Shake {
            bend: [0.6, -1.4],
            ..tremor
        };
        let case = |name, shake| Case {
            name,
            shake,
            noise: None,
            exposure: 1.0,
            lopsided: 0.0,
        };
        let cases = [
            case(
                "translation",
                Shake {
                    shift,
                    ..Shake::default()
                },
            ),
            case(
                "roll",
                Shake {
                    shift,
                    roll,
                    ..Shake::default()
                },
            ),
            case("rolling shutter", handheld),
            case("straight blur", straight),
            case("tremor blur", tremor),
            // A bowed path's blur is lopsided, so there is no one place it sits: the aligner
            // overlays the frame's detail, which lies off the blur's centroid by up to half the bow.
            Case {
                lopsided: 0.5 * bowed.bend[0].hypot(bowed.bend[1]),
                ..case("bowed blur", bowed)
            },
            Case {
                noise: Some(HIGH_ISO),
                ..case("high ISO", handheld)
            },
            Case {
                noise: Some(HIGH_ISO),
                ..case("high ISO, tremor blur", tremor)
            },
            Case {
                noise: Some(BASE_ISO),
                exposure: 2.0,
                ..case("1 stop over, saturating", handheld)
            },
            Case {
                noise: Some(BASE_ISO),
                exposure: 0.25,
                ..case("2 stops under", handheld)
            },
        ];
        let mut failed = Vec::new();
        for case in cases {
            let Some(accuracy) = accuracy(case) else {
                return;
            };
            println!(
                "{}: rms {:.3}, offset {:.3} spread {:.3}, {} of {} tiles",
                case.name,
                accuracy.rms,
                accuracy.offset,
                accuracy.spread,
                accuracy.found,
                accuracy.tiles
            );
            let placed = match case.lopsided > 0.0 {
                true => accuracy.spread <= 0.1 && accuracy.offset <= case.lopsided,
                false => accuracy.rms <= 0.1,
            };
            if !placed || accuracy.found < accuracy.tiles {
                failed.push(case.name);
            }
        }
        assert!(failed.is_empty(), "missed: {failed:?}");
    }

    fn rms(got: &[f32], want: &[f32]) -> f64 {
        let squared: f64 = got
            .iter()
            .zip(want)
            .map(|(got, want)| (*got as f64 - *want as f64).powi(2))
            .sum();
        (squared / want.len() as f64).sqrt()
    }

    /// A photosite-a-pixel RGB plane `width` across, read bilinearly at the grid's pixels.
    fn on_grid(values: &[f32], width: usize, grid: Grid) -> Vec<f32> {
        let at = |x: usize, y: usize, channel: usize| values[(y * width + x) * 3 + channel];
        (0..grid.width * grid.height * 3)
            .map(|index| {
                let (pixel, channel) = (index / 3, index % 3);
                let x = grid.left as f64 + ((pixel % grid.width) as f64 + 0.5) / grid.scale as f64
                    - 0.5;
                let y =
                    grid.top as f64 + ((pixel / grid.width) as f64 + 0.5) / grid.scale as f64 - 0.5;
                let (ix, iy) = (x.floor() as usize, y.floor() as usize);
                let (fx, fy) = ((x - x.floor()) as f32, (y - y.floor()) as f32);
                let top = at(ix, iy, channel) * (1.0 - fx) + at(ix + 1, iy, channel) * fx;
                let bottom =
                    at(ix, iy + 1, channel) * (1.0 - fx) + at(ix + 1, iy + 1, channel) * fx;
                top * (1.0 - fy) + bottom * fy
            })
            .collect()
    }

    #[derive(Clone, Copy)]
    struct Merging {
        name: &'static str,
        frames: usize,
        noise: Option<Noise>,
        scale: usize,
        subject: Option<Subject>,
        /// Every other frame shaken during its exposure.
        blurred: bool,
        /// A sensor-shift burst: whole photosites apart, on a tripod.
        tripod: bool,
        /// Each frame's light, the first the reference's.
        exposures: Option<&'static [f64]>,
        focus: Option<Focus>,
        /// The most of the reference RCD's error the merge may keep.
        within: f64,
    }

    /// The reference's own RCD and the merge, each against the truth on the grid: over all of it,
    /// then over everywhere the subject went in any frame, or where the reference is out of focus.
    struct Errors {
        rcd: f64,
        merged: f64,
        rcd_swept: f64,
        merged_swept: f64,
    }

    fn merged_against_truth(case: Merging) -> Option<Errors> {
        let Merging {
            frames,
            noise,
            scale,
            subject,
            focus,
            ..
        } = case;
        let light = |frame: usize| case.exposures.map_or(1.0, |exposures| exposures[frame]);
        let exposure = |frame: usize| match case.exposures {
            None => Exposure::UNCLIPPED,
            Some(exposures) => Exposure {
                gain: (exposures[0] / exposures[frame]) as f32,
                ceilings: [1.0; 4],
            },
        };
        let gpu = gpu::device()?;
        let mut random = Random(0x5eed);
        let mut around = |reach: f64| (random.next() * 2.0 - 1.0) * reach;
        let shakes = (0..frames)
            .map(|frame| match frame {
                0 => Shake::default(),
                _ if case.tripod => {
                    let shift = crate::burst::SHIFTS[frame % crate::burst::SHIFTS.len()];
                    Shake {
                        shift: [shift.x.raw(), shift.y.raw()],
                        ..Shake::default()
                    }
                }
                _ => {
                    let still = Shake {
                        shift: [around(6.0), around(6.0)],
                        roll: around(0.05f64.to_radians()),
                        drift: [around(1.0), around(1.0)],
                        ..Shake::default()
                    };
                    let shaken = Shake {
                        blur: [around(3.0), around(3.0)],
                        tremor: [around(0.8), around(0.8), 1.5],
                        ..still
                    };
                    if frame % 2 == 1 && case.blurred {
                        shaken
                    } else {
                        still
                    }
                }
            })
            .collect();
        let cfa = mosaic::cfa::Cfa::bayer([0, 1, 1, 2]).unwrap();
        let burst = Burst {
            width: WIDTH,
            height: HEIGHT,
            cfa: cfa.clone(),
            shakes,
            subject,
            focus,
        };
        let scene = Scene::new(7);
        let mosaics: Vec<_> = (0..frames)
            .map(|frame| {
                mosaic::condition::Mosaic::upload(
                    gpu,
                    &burst.photograph(&scene, frame, light(frame), noise),
                    WIDTH,
                    HEIGHT,
                )
            })
            .collect();
        let model = noise.map_or(
            NoiseModel {
                alpha: 0.0,
                sigma_sq: 1e-8,
            },
            |noise| NoiseModel {
                alpha: noise.alpha as f32,
                sigma_sq: noise.sigma_sq as f32,
            },
        );
        let frame = |index: usize| Frame {
            mosaic: &mosaics[index],
            cfa: &cfa,
            origin: At::ORIGIN,
            exposure: exposure(index),
            noise: model,
        };
        let interior = Rect::exact(256, 256, WIDTH - 512, HEIGHT - 512);
        let grid = Grid {
            left: 256,
            top: 256,
            width: (WIDTH - 512) * scale,
            height: (HEIGHT - 512) * scale,
            scale,
        };
        let pyramid = align::Pyramid::of(gpu, &mosaics[0], exposure(0));
        let weights = match focus {
            Some(_) => crate::merge::Weights::FOCUS,
            None => crate::merge::Weights::MOMENT,
        };
        let rcd = mosaic::demosaic::device(gpu).expect("RCD on the device");
        let merge = Merge::new(gpu, rcd, frame(0), pyramid.sites(), grid, frames, weights)
            .expect("a merge of a Bayer burst");
        for index in 1..frames {
            let field = align::measure(
                gpu,
                &pyramid,
                &mosaics[index],
                exposure(index),
                At::ORIGIN,
                At::ORIGIN,
                interior,
                |x, y| {
                    let [dx, dy] = burst.displacement(index, x, y);
                    Offset::exactly((dx + 2.6).round(), (dy - 3.3).round())
                },
                align::Search::AROUND_PRIOR,
            );
            merge.add(gpu, frame(index), &field).expect("a frame added");
        }
        let merged = read(gpu, &merge.settle(gpu), grid.width * grid.height * 3);
        let rcd = pollster::block_on(mosaic::demosaic::demosaic_plane(
            gpu,
            rcd,
            &mosaics[0],
            &cfa,
            |bytes| bytemuck::cast_slice::<u8, f32>(bytes).to_vec(),
        ))
        .expect("the reference demosaiced");
        let truth: Vec<f32> = burst
            .truth(
                &scene,
                (grid.left, grid.top),
                (grid.width, grid.height),
                scale,
            )
            .into_iter()
            .map(|value| value * light(0) as f32)
            .collect();
        let rcd = on_grid(&rcd, WIDTH, grid);
        let swept = |values: &[f32]| -> f64 {
            if subject.is_none() && focus.is_none() {
                return 0.0;
            }
            let (got, want): (Vec<f32>, Vec<f32>) = (0..grid.width * grid.height * 3)
                .filter(|index| {
                    let pixel = index / 3;
                    let x = grid.left as f64 + ((pixel % grid.width) as f64 + 0.5) / scale as f64;
                    let y = grid.top as f64 + ((pixel / grid.width) as f64 + 0.5) / scale as f64;
                    let moved =
                        subject.is_some_and(|subject| (0..frames).any(|f| subject.covers(f, x, y)));
                    let blurred = focus.is_some_and(|focus| x >= focus.split);
                    moved || blurred
                })
                .map(|index| (values[index], truth[index]))
                .unzip();
            rms(&got, &want)
        };
        Some(Errors {
            rcd: rms(&rcd, &truth),
            merged: rms(&merged, &truth),
            rcd_swept: swept(&rcd),
            merged_swept: swept(&merged),
        })
    }

    #[test]
    fn the_merge_finds_what_the_reference_demosaic_cannot() {
        let case = |name, noise, scale, within| Merging {
            name,
            frames: 8,
            noise,
            scale,
            subject: None,
            blurred: false,
            tripod: false,
            exposures: None,
            focus: None,
            within,
        };
        let cases = [
            Merging {
                frames: 4,
                tripod: true,
                ..case("a sensor shift", None, 1, 0.32)
            },
            Merging {
                frames: 4,
                tripod: true,
                ..case("a sensor shift at base ISO", Some(BASE_ISO), 1, 0.46)
            },
            case("8 frames", None, 1, 0.58),
            case("8 frames, high ISO", Some(HIGH_ISO), 1, 0.85),
            case("8 frames at 2x", None, 2, 0.64),
            case("8 frames at 2x, high ISO", Some(HIGH_ISO), 2, 0.85),
            Merging {
                subject: Some(Subject {
                    centre: [420.0, 380.0],
                    radius: 40.0,
                    step: [18.0, 6.0],
                    light: 0.85,
                }),
                ..case("8 frames, a subject moving", None, 1, 0.66)
            },
            Merging {
                blurred: true,
                ..case("8 frames, half of them blurred", None, 1, 0.76)
            },
            Merging {
                blurred: true,
                ..case("8 frames at 2x, half of them blurred", None, 2, 0.85)
            },
            Merging {
                frames: 3,
                exposures: Some(&[2.0, 0.5, 8.0]),
                ..case(
                    "an exposure bracket, the reference clipping",
                    Some(BASE_ISO),
                    1,
                    0.98,
                )
            },
            Merging {
                frames: 4,
                focus: Some(Focus {
                    split: WIDTH as f64 / 2.0,
                    radius: 3.0,
                }),
                ..case(
                    "a focus bracket, each half sharp in turn",
                    Some(BASE_ISO),
                    1,
                    0.75,
                )
            },
        ];
        let mut failed = Vec::new();
        for case in cases {
            let Some(errors) = merged_against_truth(case) else {
                return;
            };
            println!(
                "{}: RCD {:.5}, merged {:.5}; where the subject went or the reference is out of \
                 focus, RCD {:.5}, merged {:.5}",
                case.name, errors.rcd, errors.merged, errors.rcd_swept, errors.merged_swept
            );
            if errors.merged > case.within * errors.rcd || errors.merged_swept > errors.rcd_swept {
                failed.push(case.name);
            }
        }
        assert!(
            failed.is_empty(),
            "kept more of the reference's error than allowed: {failed:?}"
        );
    }

    #[test]
    fn a_merge_at_2x_remosaics_and_pastes_onto_the_magnified_region() {
        let Some(gpu) = gpu::device() else {
            return;
        };
        let quad = [0, 1, 1, 2];
        let cfa = mosaic::cfa::Cfa::bayer(quad).unwrap();
        let burst = Burst {
            width: WIDTH,
            height: HEIGHT,
            cfa: cfa.clone(),
            shakes: vec![Shake::default(); 2],
            subject: None,
            focus: None,
        };
        let scene = Scene::new(7);
        let mosaics: Vec<_> = (0..2)
            .map(|frame| {
                mosaic::condition::Mosaic::upload(
                    gpu,
                    &burst.photograph(&scene, frame, 1.0, None),
                    WIDTH,
                    HEIGHT,
                )
            })
            .collect();
        let frame = |index: usize| Frame {
            mosaic: &mosaics[index],
            cfa: &cfa,
            origin: At::ORIGIN,
            exposure: Exposure::UNCLIPPED,
            noise: NoiseModel {
                alpha: 0.0,
                sigma_sq: 1e-8,
            },
        };
        let (left, top) = (256, 256);
        let grid = Grid {
            left,
            top,
            width: 128 * 2,
            height: 96 * 2,
            scale: 2,
        };
        let pyramid = align::Pyramid::of(gpu, &mosaics[0], Exposure::UNCLIPPED);
        let rcd = mosaic::demosaic::device(gpu).expect("RCD on the device");
        let merge = Merge::new(
            gpu,
            rcd,
            frame(0),
            pyramid.sites(),
            grid,
            2,
            crate::merge::Weights::MOMENT,
        )
        .expect("a merge of a Bayer burst");
        let field = align::measure(
            gpu,
            &pyramid,
            &mosaics[1],
            Exposure::UNCLIPPED,
            At::ORIGIN,
            At::ORIGIN,
            Rect::exact(left, top, 128, 96),
            |_, _| Offset::exactly(0.0, 0.0),
            align::Search::AROUND_PRIOR,
        );
        merge.add(gpu, frame(1), &field).expect("a frame added");
        let settled = merge.settle(gpu);
        let merged = read(gpu, &settled, grid.width * grid.height * 3);
        let prior = pollster::block_on(mosaic::demosaic::demosaic_plane(
            gpu,
            rcd,
            &mosaics[0],
            &cfa,
            |bytes| bytemuck::cast_slice::<u8, f32>(bytes).to_vec(),
        ))
        .expect("the reference demosaiced");

        let mosaic = merge.remosaic(gpu, &settled);
        assert_eq!((mosaic.width, mosaic.height), (WIDTH * 2, HEIGHT * 2));
        let remosaiced = read(gpu, &mosaic.buffer, mosaic.width * mosaic.height);
        let colour = |x: usize, y: usize| quad[(y & 1) * 2 + (x & 1)] as usize;
        let merged_at = |x: usize, y: usize, channel: usize| {
            merged[((y - top * 2) * grid.width + x - left * 2) * 3 + channel]
        };
        for (x, y) in [(512, 512), (523, 518), (767, 703)] {
            assert_eq!(
                remosaiced[y * mosaic.width + x],
                merged_at(x, y, colour(x, y))
            );
        }
        for (x, y) in [(0, 0), (101, 90), (511, 600), (768, 512), (2047, 1535)] {
            let site = prior[((y / 2) * WIDTH + x / 2) * 3 + colour(x, y)];
            assert!(
                (remosaiced[y * mosaic.width + x] - site).abs() <= 1e-5,
                "({x}, {y})"
            );
        }

        let (wide, deep) = (16, 8);
        let rgb = gpu.own_buffer(&wgpu::BufferDescriptor {
            label: Some("pasted"),
            size: (wide * deep * 3 * 4) as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let mut recording = gpu.record();
        merge.paste(gpu, &mut recording, &settled, &rgb, (530, 520, wide, deep));
        recording.submit();
        let pasted = read(gpu, &rgb, wide * deep * 3);
        for (y, x, channel) in [(0, 0, 0), (3, 7, 1), (7, 15, 2)] {
            assert_eq!(
                pasted[(y * wide + x) * 3 + channel],
                merged_at(530 + x, 520 + y, channel)
            );
        }
    }
}
