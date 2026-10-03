//! Against `scripts/print-sandbox.ts`'s CUPS and IPP Everywhere printers:
//!
//!   bun run scripts/print-sandbox.ts
//!   BOWERBIRD_PRINT_SANDBOX=1 bun run test:native --no-default-features printshim::sandbox -- --ignored

use super::cups::Cups;
use super::page::Picture;
use super::page::tests::{job, png, scratch};
use super::{Connection, Job, JobState, ProfileSource, Space, Transport};
use std::time::{Duration, Instant};

const RECEIVED: &str = "http://localhost:6631/received";
const JOB_TIMEOUT: Duration = Duration::from_secs(60);

fn sandbox() -> Option<Cups> {
    if std::env::var("BOWERBIRD_PRINT_SANDBOX").as_deref() != Ok("1") {
        return None;
    }
    let server = std::env::var("CUPS_SERVER").unwrap_or_else(|_| "localhost:6631".to_string());
    Some(Cups::at(&server))
}

fn t(space: Space, bits: u8) -> Transport {
    Transport { space, bits }
}

fn is_icc(bytes: &[u8]) -> bool {
    bytes.len() > 128 && &bytes[36..40] == b"acsp"
}

#[test]
#[ignore = "needs the print sandbox: bun run scripts/print-sandbox.ts"]
fn lists_the_sandbox_queues() {
    let Some(cups) = sandbox() else { return };
    let printers = cups.list().unwrap();
    let photo = printers
        .iter()
        .find(|printer| printer.id == "cups:Sandbox_Photo")
        .unwrap();
    assert_eq!(photo.name, "Sandbox Photo");
    assert!(photo.is_default);
    assert_eq!(photo.location.as_deref(), Some("Desk"));
    assert_eq!(photo.connection, Connection::Network);
    let pdf = printers
        .iter()
        .find(|printer| printer.id == "cups:Sandbox_Pdf")
        .unwrap();
    assert!(!pdf.is_default);
    assert_eq!(pdf.model.as_deref(), Some("Bowerbird Sandbox PDF"));
    assert_eq!(pdf.connection, Connection::Network);
    assert!(
        printers
            .iter()
            .any(|printer| printer.id == "cups:Sandbox_Relay")
    );
}

#[test]
#[ignore = "needs the print sandbox: bun run scripts/print-sandbox.ts"]
fn the_photo_printer_is_asked_directly() {
    let Some(cups) = sandbox() else { return };
    let capabilities = cups.capabilities("Sandbox_Photo").unwrap();
    assert_eq!(
        capabilities.colour.transports,
        vec![
            t(Space::Device, 16),
            t(Space::Device, 8),
            t(Space::AdobeRgb, 16),
            t(Space::AdobeRgb, 8),
            t(Space::Srgb, 16),
            t(Space::Srgb, 8),
        ]
    );
    let a4 = capabilities
        .media
        .iter()
        .find(|media| media.key == "iso_a4_210x297mm")
        .unwrap();
    assert!(a4.borderless);
    assert_eq!(
        (
            a4.margins.top,
            a4.margins.right,
            a4.margins.bottom,
            a4.margins.left
        ),
        (3.0, 3.0, 5.0, 3.0)
    );
    assert!(
        capabilities
            .media
            .iter()
            .any(|media| media.key == "na_index-4x6_4x6in" && media.borderless)
    );
    assert_eq!(
        capabilities.default_media.as_deref(),
        Some("iso_a4_210x297mm")
    );
    assert_eq!(
        capabilities.default_media_type.as_deref(),
        Some("photographic-glossy")
    );
    assert_eq!(capabilities.resolutions_dpi, vec![300, 600]);
    assert_eq!(capabilities.copies_max, 99);
    assert_eq!(capabilities.colour.profiles.len(), 1);
    assert_eq!(capabilities.colour.profiles[0].name, "Glossy");
    assert_eq!(
        capabilities.colour.profiles[0].source,
        ProfileSource::Printer
    );
    assert!(is_icc(&cups.profile("Sandbox_Photo", "Glossy").unwrap()));
}

#[test]
#[ignore = "needs the print sandbox: bun run scripts/print-sandbox.ts"]
fn a_printer_behind_an_http_device_is_asked_through_its_queue() {
    let Some(cups) = sandbox() else { return };
    let capabilities = cups.capabilities("Sandbox_Relay").unwrap();
    assert_eq!(
        capabilities.colour.transports,
        vec![
            t(Space::Device, 16),
            t(Space::Device, 8),
            t(Space::AdobeRgb, 16),
            t(Space::Srgb, 8),
        ]
    );
    assert!(capabilities.colour.profiles.is_empty());
}

#[test]
#[ignore = "needs the print sandbox: bun run scripts/print-sandbox.ts"]
fn a_pdf_queue_offers_pdf_and_its_drivers_profile() {
    let Some(cups) = sandbox() else { return };
    let capabilities = cups.capabilities("Sandbox_Pdf").unwrap();
    assert_eq!(
        capabilities.colour.transports,
        vec![t(Space::AdobeRgb, 16), t(Space::Srgb, 16)]
    );
    assert_eq!(capabilities.colour.profiles.len(), 1);
    assert_eq!(capabilities.colour.profiles[0].name, "Glossy photo");
    assert_eq!(
        capabilities.colour.profiles[0].source,
        ProfileSource::Driver
    );
    assert!(is_icc(
        &cups.profile("Sandbox_Pdf", "Glossy photo").unwrap()
    ));
    let a4 = capabilities
        .media
        .iter()
        .find(|media| media.key == "iso_a4_210x297mm")
        .unwrap();
    assert!(!a4.borderless);
}

/// A 4x6 page at 300 dpi with a small picture whose every pixel differs, so the printer's copy
/// can be checked sample by sample.
fn page(name: &str, transport: Transport, borderless: bool) -> (Job, Vec<[u16; 3]>) {
    let mut job = job((1200, 1800), (150, 300, 97, 61), transport.bits);
    job.name = name.to_string();
    job.media = "na_index-4x6_4x6in".to_string();
    job.media_type = Some("photographic-glossy".to_string());
    job.borderless = borderless;
    job.transport = transport;
    let pixel = |x: u32, y: u32| -> [u16; 3] {
        let scale = if transport.bits == 16 { 257 } else { 1 };
        [
            (x * 2 % 256) as u16 * scale,
            (y * 3 % 256) as u16 * scale,
            ((x + y) % 256) as u16 * scale,
        ]
    };
    let path = scratch(&format!("{name}.png"));
    png(&path, 97, 61, transport.bits, pixel);
    let pixels = (0..61)
        .flat_map(|y| (0..97).map(move |x| (x, y)))
        .map(|(x, y)| pixel(x, y))
        .collect();
    (job, pixels)
}

fn printed(cups: &Cups, queue: &str, job: &Job) -> i32 {
    let picture = Picture::open(&scratch(&format!("{}.png", job.name)), job).unwrap();
    let id = cups.submit(queue, picture, job).unwrap();
    let started = Instant::now();
    loop {
        let status = cups.job(queue, id).unwrap();
        match status.state {
            JobState::Completed => return id,
            JobState::Aborted | JobState::Canceled | JobState::Stopped => {
                panic!("job {id} on {queue} ended {status:?}")
            }
            _ => {}
        }
        assert!(
            started.elapsed() < JOB_TIMEOUT,
            "job {id} on {queue} is still {status:?}"
        );
        std::thread::sleep(Duration::from_millis(200));
    }
}

fn received(path: &str) -> Vec<u8> {
    ureq::get(&format!("{RECEIVED}/{path}"))
        .call()
        .unwrap()
        .body_mut()
        .with_config()
        .limit(1 << 30)
        .read_to_vec()
        .unwrap()
}

/// The page a PWG raster stream decodes to, with its header's fields, by a reader written from
/// PWG 5102.4 rather than from the encoder.
struct Raster {
    width: usize,
    height: usize,
    bits: u32,
    colour_space: u32,
    dpi: u32,
    media: String,
    pixels: Vec<Vec<u8>>,
}

fn decode_raster(stream: &[u8]) -> Raster {
    assert_eq!(&stream[..4], b"RaS2");
    let header = &stream[4..4 + 1796];
    let int = |offset: usize| u32::from_be_bytes(header[offset..offset + 4].try_into().unwrap());
    let (width, height, bits) = (int(372) as usize, int(376) as usize, int(384));
    let pixel = 3 * bits as usize / 8;
    let mut data = &stream[4 + 1796..];
    let mut pixels = Vec::new();
    while pixels.len() < height {
        let repeat = data[0] as usize + 1;
        data = &data[1..];
        let mut line = Vec::with_capacity(width * pixel);
        while line.len() < width * pixel {
            let control = data[0];
            data = &data[1..];
            if control < 128 {
                for _ in 0..=control {
                    line.extend_from_slice(&data[..pixel]);
                }
                data = &data[pixel..];
            } else {
                let count = 257 - control as usize;
                line.extend_from_slice(&data[..count * pixel]);
                data = &data[count * pixel..];
            }
        }
        pixels.extend(std::iter::repeat_n(line, repeat));
    }
    assert!(data.is_empty(), "one page and nothing after it");
    let media = &header[1732..1796];
    Raster {
        width,
        height,
        bits,
        colour_space: int(400),
        dpi: int(276),
        media: String::from_utf8(media[..media.iter().position(|&b| b == 0).unwrap()].to_vec())
            .unwrap(),
        pixels,
    }
}

fn samples(pixel: [u16; 3], bits: u32) -> Vec<u8> {
    pixel
        .iter()
        .flat_map(|&sample| {
            if bits == 16 {
                sample.to_be_bytes().to_vec()
            } else {
                vec![sample as u8]
            }
        })
        .collect()
}

fn check_raster(raster: &Raster, job: &Job, pixels: &[[u16; 3]]) {
    assert_eq!((raster.width, raster.height), (1200, 1800));
    assert_eq!(raster.bits, job.transport.bits as u32);
    assert_eq!(raster.dpi, 300);
    assert_eq!(raster.media, "na_index-4x6_4x6in");
    let pixel = 3 * raster.bits as usize / 8;
    let white = vec![0xFF; pixel];
    for (y, line) in raster.pixels.iter().enumerate() {
        for x in 0..raster.width {
            let got = &line[x * pixel..(x + 1) * pixel];
            let (px, py) = (x as i64 - 150, y as i64 - 300);
            let expected = if (0..97).contains(&px) && (0..61).contains(&py) {
                samples(pixels[(py * 97 + px) as usize], raster.bits)
            } else {
                white.clone()
            };
            assert_eq!(got, &expected[..], "pixel {x},{y}");
        }
    }
}

/// ippeveprinter keeps a job as `<id>-<name>.pwg` in the printer's spool.
fn spooled(printer: &str, id: i32, name: &str) -> Vec<u8> {
    received(&format!("{printer}/{id}-{name}.pwg"))
}

#[test]
#[ignore = "needs the print sandbox: bun run scripts/print-sandbox.ts"]
fn device_rgb_reaches_the_photo_printer_sample_for_sample() {
    let Some(cups) = sandbox() else { return };
    let (job, pixels) = page("direct16", t(Space::Device, 16), true);
    let id = printed(&cups, "Sandbox_Photo", &job);
    let raster = decode_raster(&spooled("photo", id, "direct16"));
    assert_eq!(raster.colour_space, 1);
    check_raster(&raster, &job, &pixels);
}

#[test]
#[ignore = "needs the print sandbox: bun run scripts/print-sandbox.ts"]
fn adobe_rgb_reaches_the_printer_behind_the_queue_unchanged() {
    let Some(cups) = sandbox() else { return };
    let (job, pixels) = page("relay16", t(Space::AdobeRgb, 16), false);
    printed(&cups, "Sandbox_Relay", &job);
    let raster = decode_raster(&relayed("relay", "relay16.pwg"));
    assert_eq!(raster.colour_space, 20);
    check_raster(&raster, &job, &pixels);
}

/// The job number printshim holds is cupsd's rather than the printer's, so the printer's spool is
/// searched by name, latest first.
fn relayed(printer: &str, file: &str) -> Vec<u8> {
    (1..64)
        .rev()
        .find_map(|id| {
            let mut response = ureq::get(&format!("{RECEIVED}/{printer}/{id}-{file}"))
                .call()
                .ok()?;
            response
                .body_mut()
                .with_config()
                .limit(1 << 30)
                .read_to_vec()
                .ok()
        })
        .unwrap_or_else(|| panic!("{printer} never received {file}"))
}

#[test]
#[ignore = "needs the print sandbox: bun run scripts/print-sandbox.ts"]
fn a_pdf_queue_receives_the_picture_at_full_depth_with_its_profile() {
    let Some(cups) = sandbox() else { return };
    let (mut job, pixels) = page("pdf16", t(Space::AdobeRgb, 16), false);
    job.media = "iso_a4_210x297mm".to_string();
    job.media_type = None;
    printed(&cups, "Sandbox_Pdf", &job);
    let pdf = relayed("pdf", "pdf16.pdf");
    assert!(pdf.starts_with(b"%PDF-1.7"));
    let after = |marker: &[u8]| {
        pdf.windows(marker.len())
            .position(|window| window == marker)
            .unwrap_or_else(|| panic!("no {}", String::from_utf8_lossy(marker)))
            + marker.len()
    };
    let at = after(b"/Width 97/Height 61/ColorSpace[/ICCBased 6 0 R]/BitsPerComponent 16/Filter/FlateDecode/Length ");
    let digits = pdf[at..].iter().take_while(|b| b.is_ascii_digit()).count();
    let length: usize = std::str::from_utf8(&pdf[at..at + digits])
        .unwrap()
        .parse()
        .unwrap();
    let start = at + digits + b">>\nstream\n".len();
    let mut inflated = Vec::new();
    std::io::Read::read_to_end(
        &mut flate2::read::ZlibDecoder::new(&pdf[start..start + length]),
        &mut inflated,
    )
    .unwrap();
    let expected: Vec<u8> = pixels
        .iter()
        .flat_map(|&pixel| samples(pixel, 16))
        .collect();
    assert_eq!(inflated, expected);
    assert!(
        pdf.windows(super::page::tests::TEST_ICC.len())
            .any(|window| window == super::page::tests::TEST_ICC)
    );
}
