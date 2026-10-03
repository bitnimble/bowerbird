use super::{Error, Job, Place, Result};
use std::fs::File;
use std::io::BufReader;
use std::path::Path;

pub struct Picture {
    #[cfg(windows)]
    pub path: std::path::PathBuf,
    #[cfg(not(windows))]
    bits: u8,
    pub icc: Option<Vec<u8>>,
    #[cfg(windows)]
    pub pixels_per_metre: Option<(u32, u32)>,
    #[cfg_attr(windows, expect(dead_code))]
    reader: png::Reader<BufReader<File>>,
}

impl Picture {
    pub fn open(path: &Path, job: &Job) -> Result<Picture> {
        check_job(job)?;
        let file = File::open(path).map_err(|error| {
            Error::unavailable(format!("Can't open {}: {error}", path.display()))
        })?;
        let mut decoder = png::Decoder::new(BufReader::new(file));
        decoder.set_transformations(png::Transformations::IDENTITY);
        let reader = decoder.read_info().map_err(|error| {
            Error::invalid(format!("{} isn't a readable PNG: {error}", path.display()))
        })?;
        let info = reader.info();
        let bits = match info.bit_depth {
            png::BitDepth::Eight => 8,
            png::BitDepth::Sixteen => 16,
            other => {
                return Err(Error::invalid(format!(
                    "The image is {other:?}-bit; printing takes 8 or 16"
                )));
            }
        };
        if info.color_type != png::ColorType::Rgb {
            return Err(Error::invalid(format!(
                "The image is {:?}; printing takes RGB with no alpha",
                info.color_type
            )));
        }
        if info.interlaced {
            return Err(Error::invalid("The image is interlaced"));
        }
        if bits != job.transport.bits {
            return Err(Error::invalid(format!(
                "The image is {bits}-bit but the job asks for {}",
                job.transport.bits
            )));
        }
        if (info.width, info.height) != (job.place.width, job.place.height) {
            return Err(Error::invalid(format!(
                "The image is {}x{} but the job places {}x{}",
                info.width, info.height, job.place.width, job.place.height
            )));
        }
        Ok(Picture {
            #[cfg(windows)]
            path: path.to_owned(),
            #[cfg(not(windows))]
            bits,
            icc: info.icc_profile.as_ref().map(|icc| icc.to_vec()),
            #[cfg(windows)]
            pixels_per_metre: info
                .pixel_dims
                .filter(|dims| dims.unit == png::Unit::Meter && dims.xppu > 0 && dims.yppu > 0)
                .map(|dims| (dims.xppu, dims.yppu)),
            reader,
        })
    }

    #[cfg(not(windows))]
    pub fn next_row(&mut self) -> Result<&[u8]> {
        match self.reader.next_row() {
            Ok(Some(row)) => Ok(row.data()),
            Ok(None) => Err(Error::invalid("The image ended early")),
            Err(error) => Err(Error::invalid(format!("The image is damaged: {error}"))),
        }
    }

    #[cfg(not(windows))]
    pub fn compose(&mut self, job: &Job, mut sink: impl FnMut(&[u8]) -> Result<()>) -> Result<()> {
        let pixel = 3 * self.bits as usize / 8;
        let Place {
            x,
            y,
            width,
            height,
        } = job.place;
        let (start, end) = (x as usize * pixel, (x + width) as usize * pixel);
        let mut row = vec![0xFF; job.page.width_px as usize * pixel];
        for line in 0..job.page.height_px {
            let inside = (y..y + height).contains(&line);
            if inside {
                row[start..end].copy_from_slice(self.next_row()?);
            } else if line == y + height {
                row[start..end].fill(0xFF);
            }
            sink(&row)?;
        }
        Ok(())
    }
}

fn check_job(job: &Job) -> Result<()> {
    let Place {
        x,
        y,
        width,
        height,
    } = job.place;
    if !matches!(job.transport.bits, 8 | 16) {
        return Err(Error::invalid(format!(
            "{} bits per colour isn't a depth printing takes",
            job.transport.bits
        )));
    }
    if job.resolution_dpi == 0 || job.copies == 0 || width == 0 || height == 0 {
        return Err(Error::invalid(
            "The job has a zero resolution, copy count or picture size",
        ));
    }
    let fits =
        |at: u32, length: u32, page: u32| at.checked_add(length).is_some_and(|end| end <= page);
    if !fits(x, width, job.page.width_px) || !fits(y, height, job.page.height_px) {
        return Err(Error::invalid(format!(
            "The picture at {x},{y} sized {width}x{height} runs off the {}x{} page",
            job.page.width_px, job.page.height_px
        )));
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::super::{Job, PageSize, Place, Space, Transport};
    use super::*;

    pub(crate) fn job(page: (u32, u32), place: (u32, u32, u32, u32), bits: u8) -> Job {
        Job {
            name: "test".into(),
            media: "iso_a4_210x297mm".into(),
            media_type: None,
            borderless: false,
            copies: 1,
            resolution_dpi: 300,
            transport: Transport {
                space: Space::Device,
                bits,
            },
            page: PageSize {
                width_px: page.0,
                height_px: page.1,
            },
            place: Place {
                x: place.0,
                y: place.1,
                width: place.2,
                height: place.3,
            },
        }
    }

    pub(crate) fn png(
        path: &Path,
        width: u32,
        height: u32,
        bits: u8,
        pixel: impl Fn(u32, u32) -> [u16; 3],
    ) {
        let mut info = png::Info::with_size(width, height);
        info.color_type = png::ColorType::Rgb;
        info.bit_depth = if bits == 16 {
            png::BitDepth::Sixteen
        } else {
            png::BitDepth::Eight
        };
        info.icc_profile = Some(TEST_ICC.into());
        let encoder = png::Encoder::with_info(File::create(path).unwrap(), info).unwrap();
        let mut writer = encoder.write_header().unwrap();
        let mut data = Vec::new();
        for y in 0..height {
            for x in 0..width {
                for sample in pixel(x, y) {
                    if bits == 16 {
                        data.extend_from_slice(&sample.to_be_bytes());
                    } else {
                        data.push(sample as u8);
                    }
                }
            }
        }
        writer.write_image_data(&data).unwrap();
    }

    pub(crate) const TEST_ICC: &[u8] = b"not really a profile, but iCCP carries any bytes";

    pub(crate) fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("bowerbird-printshim-tests");
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    #[test]
    #[cfg(not(windows))]
    fn the_page_is_white_around_the_picture_and_the_picture_is_untouched() {
        let path = scratch("compose.png");
        png(&path, 2, 2, 16, |x, y| {
            [x as u16 * 0x1234, y as u16 * 0x0101, 7]
        });
        let job = job((4, 4), (1, 1, 2, 2), 16);
        let mut picture = Picture::open(&path, &job).unwrap();
        assert_eq!(picture.icc.as_deref(), Some(TEST_ICC));
        let mut rows = Vec::new();
        picture
            .compose(&job, |row| {
                rows.push(row.to_vec());
                Ok(())
            })
            .unwrap();
        let white = vec![0xFF; 4 * 6];
        let inside = |y: u8| -> Vec<u8> {
            let mut row = vec![0xFF; 6];
            row.extend_from_slice(&[0, 0, y, y, 0, 7, 0x12, 0x34, y, y, 0, 7]);
            row.extend_from_slice(&[0xFF; 6]);
            row
        };
        assert_eq!(rows, vec![white.clone(), inside(0), inside(1), white]);
    }

    #[test]
    fn a_picture_that_disagrees_with_its_job_is_refused() {
        let path = scratch("refused.png");
        png(&path, 2, 2, 8, |_, _| [0, 0, 0]);
        let refusal = |job: Job| {
            let error = Picture::open(&path, &job).err().unwrap();
            assert_eq!(error.kind, super::super::ErrorKind::Invalid);
            error.message
        };
        assert_eq!(
            refusal(job((4, 4), (1, 1, 2, 2), 16)),
            "The image is 8-bit but the job asks for 16"
        );
        assert_eq!(
            refusal(job((4, 4), (1, 1, 3, 2), 8)),
            "The image is 2x2 but the job places 3x2"
        );
        assert_eq!(
            refusal(job((4, 4), (3, 1, 2, 2), 8)),
            "The picture at 3,1 sized 2x2 runs off the 4x4 page"
        );
    }
}
