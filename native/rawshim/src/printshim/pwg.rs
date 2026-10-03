//! PWG raster (PWG 5102.4): the format an IPP Everywhere printer is required to take.

use super::page::Picture;
use super::{Job, Result, Space};

const SYNC: &[u8; 4] = b"RaS2";
const HEADER_BYTES: usize = 1796;
const MAX_LINE_REPEAT: usize = 256;
const MAX_PIXEL_RUN: usize = 128;

pub fn document(picture: &mut Picture, job: &Job, media: &str) -> Result<Vec<u8>> {
    let mut writer = Writer::new(&Header {
        width: job.page.width_px,
        height: job.page.height_px,
        dpi: job.resolution_dpi,
        bits: job.transport.bits,
        space: job.transport.space,
        media,
        media_type: job.media_type.as_deref().unwrap_or(""),
        image_box: [
            job.place.x,
            job.place.y,
            job.place.x + job.place.width,
            job.place.y + job.place.height,
        ],
    });
    picture.compose(job, |row| {
        writer.push(row);
        Ok(())
    })?;
    Ok(writer.finish())
}

struct Header<'a> {
    width: u32,
    height: u32,
    dpi: u32,
    bits: u8,
    space: Space,
    media: &'a str,
    media_type: &'a str,
    /// Left, top, right, bottom, in pixels.
    image_box: [u32; 4],
}

impl Header<'_> {
    fn bytes(&self) -> Vec<u8> {
        let mut header = vec![0u8; HEADER_BYTES];
        let mut int = |offset: usize, value: u32| {
            header[offset..offset + 4].copy_from_slice(&value.to_be_bytes());
        };
        let points = |pixels: u32| (pixels as f64 * 72.0 / self.dpi as f64).round() as u32;
        let bits = self.bits as u32;
        int(276, self.dpi);
        int(280, self.dpi);
        int(340, 1);
        int(352, points(self.width));
        int(356, points(self.height));
        int(372, self.width);
        int(376, self.height);
        int(384, bits);
        int(388, bits * 3);
        int(392, self.width * bits * 3 / 8);
        int(
            400,
            match self.space {
                Space::Device => 1,
                Space::Srgb => 19,
                Space::AdobeRgb => 20,
            },
        );
        int(420, 3);
        int(452, 1);
        int(456, 1);
        int(460, 1);
        for (i, edge) in self.image_box.into_iter().enumerate() {
            int(464 + 4 * i, edge);
        }
        int(480, 0x00FF_FFFF);
        int(484, 5);
        let mut string = |offset: usize, value: &str| {
            let bytes = &value.as_bytes()[..value.len().min(63)];
            header[offset..offset + bytes.len()].copy_from_slice(bytes);
        };
        string(0, "PwgRaster");
        string(128, self.media_type);
        string(192, "photo");
        string(1732, self.media);
        header
    }
}

struct Writer {
    out: Vec<u8>,
    pixel: usize,
    held: Vec<u8>,
    repeats: usize,
}

impl Writer {
    fn new(header: &Header) -> Writer {
        let mut out = SYNC.to_vec();
        out.extend_from_slice(&header.bytes());
        Writer {
            out,
            pixel: 3 * header.bits as usize / 8,
            held: Vec::new(),
            repeats: 0,
        }
    }

    fn push(&mut self, row: &[u8]) {
        if self.repeats > 0 && self.repeats < MAX_LINE_REPEAT && row == self.held {
            self.repeats += 1;
            return;
        }
        self.flush();
        self.held.clear();
        self.held.extend_from_slice(row);
        self.repeats = 1;
    }

    fn finish(mut self) -> Vec<u8> {
        self.flush();
        self.out
    }

    fn flush(&mut self) {
        if self.repeats == 0 {
            return;
        }
        self.out.push((self.repeats - 1) as u8);
        pack(&self.held, self.pixel, &mut self.out);
    }
}

fn pack(row: &[u8], pixel: usize, out: &mut Vec<u8>) {
    let count = row.len() / pixel;
    let at = |i: usize| &row[i * pixel..(i + 1) * pixel];
    let mut i = 0;
    while i < count {
        let mut run = 1;
        while i + run < count && run < MAX_PIXEL_RUN && at(i + run) == at(i) {
            run += 1;
        }
        if run > 1 || i + 1 == count {
            out.push((run - 1) as u8);
            out.extend_from_slice(at(i));
            i += run;
            continue;
        }
        let mut literal = 1;
        while i + literal < count
            && literal < MAX_PIXEL_RUN
            && (i + literal + 1 == count || at(i + literal) != at(i + literal + 1))
        {
            literal += 1;
        }
        if literal == 1 {
            out.push(0);
        } else {
            out.push((257 - literal) as u8);
        }
        out.extend_from_slice(&row[i * pixel..(i + literal) * pixel]);
        i += literal;
    }
}

#[cfg(test)]
mod tests {
    use super::super::page::tests::{job, png, scratch};
    use super::*;

    fn int(document: &[u8], offset: usize) -> u32 {
        let at = SYNC.len() + offset;
        u32::from_be_bytes(document[at..at + 4].try_into().unwrap())
    }

    fn string(document: &[u8], offset: usize) -> &str {
        let field = &document[SYNC.len() + offset..SYNC.len() + offset + 64];
        std::str::from_utf8(&field[..field.iter().position(|&b| b == 0).unwrap()]).unwrap()
    }

    #[test]
    fn a_tiny_page_encodes_to_its_literal_bytes() {
        let path = scratch("pwg.png");
        png(&path, 2, 2, 8, |x, y| match (x, y) {
            (0, 0) => [1, 2, 3],
            (1, 0) => [4, 5, 6],
            _ => [9, 9, 9],
        });
        let mut job = job((4, 4), (1, 2, 2, 2), 8);
        job.transport.space = Space::AdobeRgb;
        job.media_type = Some("photographic-glossy".into());
        let mut picture = Picture::open(&path, &job).unwrap();
        let document = document(&mut picture, &job, "iso_a4_210x297mm").unwrap();

        assert_eq!(&document[..4], b"RaS2");
        assert_eq!(string(&document, 0), "PwgRaster");
        assert_eq!(string(&document, 128), "photographic-glossy");
        assert_eq!(string(&document, 1732), "iso_a4_210x297mm");
        let fields = [
            (276, 300),
            (280, 300),
            (352, 1),
            (356, 1),
            (372, 4),
            (376, 4),
            (384, 8),
            (388, 24),
            (392, 12),
            (400, 20),
            (420, 3),
            (452, 1),
            (464, 1),
            (468, 2),
            (472, 3),
            (476, 4),
            (484, 5),
        ];
        for (offset, value) in fields {
            assert_eq!(int(&document, offset), value, "header field at {offset}");
        }
        assert_eq!(
            &document[4 + HEADER_BYTES..],
            &[
                // Two white lines: one line, repeated once, of four white pixels.
                1, 3, 0xFF, 0xFF, 0xFF,
                // White, then two pixels that differ, then white: four literal pixels.
                0, 253, 0xFF, 0xFF, 0xFF, 1, 2, 3, 4, 5, 6, 0xFF, 0xFF, 0xFF,
                // A lone white pixel, a run of two, and a lone white pixel to finish.
                0, 0, 0xFF, 0xFF, 0xFF, 1, 9, 9, 9, 0, 0xFF, 0xFF, 0xFF,
            ][..]
        );
    }

    #[test]
    fn sixteen_bit_samples_stay_big_endian_and_long_runs_split() {
        let row: Vec<u8> = (0..130)
            .flat_map(|_| [0x12, 0x34, 0, 0, 0xAB, 0xCD])
            .collect();
        let mut out = Vec::new();
        pack(&row, 6, &mut out);
        assert_eq!(
            out,
            [
                &[127u8, 0x12, 0x34, 0, 0, 0xAB, 0xCD][..],
                &[1, 0x12, 0x34, 0, 0, 0xAB, 0xCD]
            ]
            .concat()
        );
    }
}
