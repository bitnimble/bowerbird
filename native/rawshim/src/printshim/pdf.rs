use super::page::Picture;
use super::{Job, Result, fail};
use flate2::Compression;
use flate2::write::ZlibEncoder;
use std::io::Write;

pub fn document(picture: &mut Picture, job: &Job) -> Result<Vec<u8>> {
    let Some(icc) = picture.icc.take() else {
        return fail("The image has no ICC profile to say what its colours are");
    };
    let mut samples = ZlibEncoder::new(Vec::new(), Compression::fast());
    for _ in 0..job.place.height {
        samples
            .write_all(picture.next_row()?)
            .map_err(|error| super::Error(format!("Can't compress the image: {error}")))?;
    }
    let samples = samples
        .finish()
        .map_err(|error| super::Error(format!("Can't compress the image: {error}")))?;
    Ok(write(job, &icc, &samples))
}

/// `samples` are the picture's rows, zlib-compressed.
fn write(job: &Job, icc: &[u8], samples: &[u8]) -> Vec<u8> {
    let points = |pixels: u32| pixels as f64 * 72.0 / job.resolution_dpi as f64;
    let place = job.place;
    let (width, height) = (points(job.page.width_px), points(job.page.height_px));
    let draw = format!(
        "q {} 0 0 {} {} {} cm /Im0 Do Q",
        number(points(place.width)),
        number(points(place.height)),
        number(points(place.x)),
        number(height - points(place.y + place.height)),
    );
    let mut pdf = Pdf::default();
    pdf.object(b"<</Type/Catalog/Pages 2 0 R>>");
    pdf.object(b"<</Type/Pages/Kids[3 0 R]/Count 1>>");
    pdf.object(
        format!(
            "<</Type/Page/Parent 2 0 R/MediaBox[0 0 {} {}]/Resources<</XObject<</Im0 5 0 R>>>>/Contents 4 0 R>>",
            number(width),
            number(height)
        )
        .as_bytes(),
    );
    pdf.stream("", draw.as_bytes());
    pdf.stream(
        &format!(
            "/Type/XObject/Subtype/Image/Width {}/Height {}/ColorSpace[/ICCBased 6 0 R]/BitsPerComponent {}/Filter/FlateDecode",
            place.width, place.height, job.transport.bits
        ),
        samples,
    );
    pdf.stream("/N 3/Alternate/DeviceRGB", icc);
    pdf.finish()
}

struct Pdf {
    out: Vec<u8>,
    offsets: Vec<usize>,
}

impl Default for Pdf {
    fn default() -> Self {
        Pdf {
            out: b"%PDF-1.7\n%\xE2\xE3\xCF\xD3\n".to_vec(),
            offsets: Vec::new(),
        }
    }
}

impl Pdf {
    fn object(&mut self, body: &[u8]) {
        self.begin();
        self.out.extend_from_slice(body);
        self.out.extend_from_slice(b"\nendobj\n");
    }

    fn stream(&mut self, dictionary: &str, data: &[u8]) {
        self.begin();
        self.out.extend_from_slice(
            format!("<<{dictionary}/Length {}>>\nstream\n", data.len()).as_bytes(),
        );
        self.out.extend_from_slice(data);
        self.out.extend_from_slice(b"\nendstream\nendobj\n");
    }

    fn begin(&mut self) {
        self.offsets.push(self.out.len());
        self.out
            .extend_from_slice(format!("{} 0 obj\n", self.offsets.len()).as_bytes());
    }

    fn finish(mut self) -> Vec<u8> {
        let xref = self.out.len();
        let size = self.offsets.len() + 1;
        self.out
            .extend_from_slice(format!("xref\n0 {size}\n0000000000 65535 f \n").as_bytes());
        for offset in &self.offsets {
            self.out
                .extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
        }
        self.out.extend_from_slice(
            format!("trailer\n<</Size {size}/Root 1 0 R>>\nstartxref\n{xref}\n%%EOF\n").as_bytes(),
        );
        self.out
    }
}

fn number(value: f64) -> String {
    let fixed = format!("{value:.4}");
    fixed
        .trim_end_matches('0')
        .trim_end_matches('.')
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::super::page::tests::{TEST_ICC, job, png, scratch};
    use super::*;

    #[test]
    fn a_tiny_page_writes_its_literal_bytes() {
        let job = job((600, 300), (150, 75, 2, 1), 16);
        let pdf = write(&job, b"ICC", b"ZZ");
        let expected = "%PDF-1.7\n%\u{E2}\u{E3}\u{CF}\u{D3}\n";
        let mut expected: Vec<u8> = expected.chars().map(|c| c as u8).collect();
        expected.extend_from_slice(
            b"1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n\
2 0 obj\n<</Type/Pages/Kids[3 0 R]/Count 1>>\nendobj\n\
3 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 144 72]/Resources<</XObject<</Im0 5 0 R>>>>/Contents 4 0 R>>\nendobj\n\
4 0 obj\n<</Length 37>>\nstream\nq 0.48 0 0 0.24 36 53.76 cm /Im0 Do Q\nendstream\nendobj\n\
5 0 obj\n<</Type/XObject/Subtype/Image/Width 2/Height 1/ColorSpace[/ICCBased 6 0 R]/BitsPerComponent 16/Filter/FlateDecode/Length 2>>\nstream\nZZ\nendstream\nendobj\n\
6 0 obj\n<</N 3/Alternate/DeviceRGB/Length 3>>\nstream\nICC\nendstream\nendobj\n\
xref\n0 7\n0000000000 65535 f \n0000000015 00000 n \n0000000060 00000 n \n0000000111 00000 n \n0000000226 00000 n \n0000000311 00000 n \n0000000471 00000 n \n\
trailer\n<</Size 7/Root 1 0 R>>\nstartxref\n545\n%%EOF\n",
        );
        assert_eq!(pdf, expected);
    }

    #[test]
    fn the_image_carries_the_pngs_profile_and_its_samples_unchanged() {
        let path = scratch("pdf.png");
        png(&path, 3, 2, 16, |x, y| {
            [x as u16 * 0x0102, y as u16 * 0xFF00, 0xBEEF]
        });
        let job = job((10, 10), (2, 2, 3, 2), 16);
        let mut picture = Picture::open(&path, &job).unwrap();
        let pdf = document(&mut picture, &job).unwrap();
        let after = |marker: &[u8]| {
            pdf.windows(marker.len())
                .position(|window| window == marker)
                .unwrap()
                + marker.len()
        };
        let image = after(b"/Filter/FlateDecode/Length ");
        let digits = pdf[image..]
            .iter()
            .take_while(|b| b.is_ascii_digit())
            .count();
        let length: usize = std::str::from_utf8(&pdf[image..image + digits])
            .unwrap()
            .parse()
            .unwrap();
        let start = image + digits + b">>\nstream\n".len();
        let mut samples = Vec::new();
        std::io::Read::read_to_end(
            &mut flate2::read::ZlibDecoder::new(&pdf[start..start + length]),
            &mut samples,
        )
        .unwrap();
        let expected: Vec<u8> = (0..2u16)
            .flat_map(|y| (0..3u16).flat_map(move |x| [x * 0x0102, y * 0xFF00, 0xBEEF]))
            .flat_map(u16::to_be_bytes)
            .collect();
        assert_eq!(samples, expected);
        let profile = after(b"/N 3/Alternate/DeviceRGB/Length ");
        assert!(pdf[profile..].starts_with(format!("{}>>\nstream\n", TEST_ICC.len()).as_bytes()));
        assert!(pdf.windows(TEST_ICC.len()).any(|window| window == TEST_ICC));
    }
}
