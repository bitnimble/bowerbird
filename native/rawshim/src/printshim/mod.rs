use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::{Path, PathBuf};

#[cfg(not(windows))]
mod cups;
pub mod ffi;
#[cfg(not(windows))]
mod ipp_attributes;
mod page;
#[cfg(not(windows))]
mod pdf;
#[cfg(not(windows))]
mod pwg;
#[cfg(all(test, not(windows)))]
mod sandbox_tests;
#[cfg(windows)]
mod spooler;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ErrorKind {
    Invalid,
    Missing,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error {
    pub kind: ErrorKind,
    pub message: String,
}

impl Error {
    pub(crate) fn invalid(message: impl Into<String>) -> Error {
        Error::new(ErrorKind::Invalid, message)
    }

    pub(crate) fn missing(message: impl Into<String>) -> Error {
        Error::new(ErrorKind::Missing, message)
    }

    pub(crate) fn unavailable(message: impl Into<String>) -> Error {
        Error::new(ErrorKind::Unavailable, message)
    }

    fn new(kind: ErrorKind, message: impl Into<String>) -> Error {
        Error {
            kind,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;

const PROFILE_LIMIT: u64 = 16 << 20;

fn is_icc(bytes: &[u8]) -> bool {
    bytes.len() > 128 && &bytes[36..40] == b"acsp"
}

fn checked_icc(bytes: Vec<u8>, source: &str) -> Result<Vec<u8>> {
    if bytes.len() as u64 > PROFILE_LIMIT {
        return Err(Error::invalid(format!(
            "The profile at {source} is larger than 16 MiB"
        )));
    }
    if !is_icc(&bytes) {
        return Err(Error::invalid(format!(
            "The file at {source} isn't an ICC profile"
        )));
    }
    Ok(bytes)
}

fn read_icc(path: &Path) -> Result<Vec<u8>> {
    let source = path.display().to_string();
    let failed = |error: std::io::Error| {
        let message = format!("Can't read the profile at {source}: {error}");
        if error.kind() == std::io::ErrorKind::NotFound {
            Error::missing(message)
        } else {
            Error::unavailable(message)
        }
    };
    if !std::fs::metadata(path).map_err(failed)?.is_file() {
        return Err(Error::invalid(format!(
            "The profile at {source} isn't a file"
        )));
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .and_then(|file| file.take(PROFILE_LIMIT + 1).read_to_end(&mut bytes))
        .map_err(failed)?;
    checked_icc(bytes, &source)
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Command {
    List,
    Capabilities {
        printer: String,
    },
    Profile {
        printer: String,
        name: String,
    },
    Submit {
        printer: String,
        image: PathBuf,
        job: Job,
    },
    Job {
        printer: String,
        job_id: i32,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub name: String,
    pub media: String,
    pub media_type: Option<String>,
    pub borderless: bool,
    pub copies: u32,
    pub resolution_dpi: u32,
    pub transport: Transport,
    pub page: PageSize,
    pub place: Place,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageSize {
    pub width_px: u32,
    pub height_px: u32,
}

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Place {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Space {
    Device,
    AdobeRgb,
    Srgb,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Transport {
    pub space: Space,
    pub bits: u8,
}

/// Space first, then depth: a profile describes device RGB, and Adobe RGB holds more of a
/// print's gamut than sRGB.
#[cfg(not(windows))]
pub(crate) fn best_first(mut transports: Vec<Transport>) -> Vec<Transport> {
    transports.sort_by_key(|transport| (transport.space, std::cmp::Reverse(transport.bits)));
    transports.dedup();
    transports
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Connection {
    Usb,
    Network,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Printer {
    pub id: String,
    pub name: String,
    pub is_default: bool,
    pub location: Option<String>,
    pub model: Option<String>,
    pub connection: Connection,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub media: Vec<Media>,
    pub default_media: Option<String>,
    pub media_types: Vec<MediaType>,
    pub default_media_type: Option<String>,
    pub resolutions_dpi: Vec<u32>,
    pub copies_max: u32,
    pub colour: Colour,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Media {
    pub key: String,
    pub name: Option<String>,
    pub width_mm: f64,
    pub height_mm: f64,
    pub margins: Margins,
    pub borderless: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Margins {
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub left: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MediaType {
    pub key: String,
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Colour {
    pub transports: Vec<Transport>,
    pub profiles: Vec<Profile>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Profile {
    pub name: String,
    pub source: ProfileSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProfileSource {
    Printer,
    Driver,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct JobStatus {
    pub state: JobState,
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum JobState {
    Pending,
    Held,
    Processing,
    Stopped,
    Canceled,
    Aborted,
    Completed,
}

#[derive(Serialize)]
struct Printers {
    printers: Vec<Printer>,
}

#[derive(Serialize)]
struct Icc {
    icc: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Submitted {
    job_id: Option<i32>,
}

#[cfg(not(windows))]
const PREFIX: &str = "cups:";
#[cfg(windows)]
const PREFIX: &str = "windows:";

fn native_name(id: &str) -> Result<&str> {
    let name = match id.strip_prefix(PREFIX) {
        Some(name) if !name.is_empty() => name,
        _ => {
            return Err(Error::missing(format!(
                "{id} is not a printer on this system"
            )));
        }
    };
    if name.chars().any(forbidden_in_name) {
        return Err(Error::invalid(format!("{id} is not a printer name")));
    }
    Ok(name)
}

#[cfg(not(windows))]
fn forbidden_in_name(c: char) -> bool {
    c.is_control() || c.is_whitespace() || matches!(c, '/' | '#' | '?')
}

#[cfg(windows)]
fn forbidden_in_name(c: char) -> bool {
    c.is_control()
}

pub(crate) fn printer_id(name: &str) -> String {
    format!("{PREFIX}{name}")
}

pub fn run(command: Command) -> Result<Reply> {
    #[cfg(not(windows))]
    let backend = cups::Cups::from_env();
    #[cfg(windows)]
    let backend = spooler::Spooler;
    let reply = match command {
        Command::List => to_value(Printers {
            printers: backend.list()?,
        }),
        Command::Capabilities { printer } => {
            to_value(backend.capabilities(native_name(&printer)?)?)
        }
        Command::Profile { printer, name } => to_value(Icc {
            icc: base64(&backend.profile(native_name(&printer)?, &name)?),
        }),
        Command::Submit {
            printer,
            image,
            job,
        } => {
            let picture = page::Picture::open(&image, &job)?;
            to_value(Submitted {
                job_id: backend.submit(native_name(&printer)?, picture, &job)?,
            })
        }
        Command::Job { printer, job_id } => to_value(backend.job(native_name(&printer)?, job_id)?),
    };
    Ok(reply)
}

pub type Reply = serde_json::Map<String, serde_json::Value>;

fn to_value(reply: impl Serialize) -> Reply {
    match serde_json::to_value(reply) {
        Ok(serde_json::Value::Object(fields)) => fields,
        _ => unreachable!("every reply is a struct of plain fields"),
    }
}

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let triple = chunk
            .iter()
            .enumerate()
            .fold(0u32, |acc, (i, &byte)| acc | (byte as u32) << (16 - 8 * i));
        for i in 0..4 {
            out.push(if i <= chunk.len() {
                ALPHABET[(triple >> (18 - 6 * i) & 63) as usize] as char
            } else {
                '='
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_pads_each_tail() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(&[0xFF, 0xFE, 0xFD, 0x00]), "//79AA==");
    }

    #[test]
    fn commands_read_the_contracts_json() {
        let submit: Command = serde_json::from_str(
            r#"{"kind":"submit","printer":"cups:Photo","image":"/tmp/a.png","job":{"name":"IMG_1234","media":"iso_a4_210x297mm","mediaType":null,"borderless":false,"copies":1,"resolutionDpi":300,"transport":{"space":"adobe-rgb","bits":16},"page":{"widthPx":2480,"heightPx":3508},"place":{"x":59,"y":59,"width":2362,"height":3390}}}"#,
        )
        .unwrap();
        let Command::Submit { job, .. } = submit else {
            panic!("not a submit: {submit:?}");
        };
        assert_eq!(
            job.transport,
            Transport {
                space: Space::AdobeRgb,
                bits: 16
            }
        );
        assert_eq!(job.place.height, 3390);
        let status: Command =
            serde_json::from_str(r#"{"kind":"job","printer":"cups:Photo","jobId":42}"#).unwrap();
        assert!(matches!(status, Command::Job { job_id: 42, .. }));
    }

    #[test]
    fn the_servers_submit_reads_as_a_command() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../test/fixtures/tables/print-json.json");
        let tables: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let submit: Command = serde_json::from_value(tables["submit"].clone()).unwrap();
        let Command::Submit {
            printer,
            image,
            job,
        } = submit
        else {
            panic!("not a submit: {submit:?}");
        };
        assert_eq!(printer, "cups:Sandbox_Photo");
        assert_eq!(image, PathBuf::from("/tmp/print.png"));
        assert_eq!(
            (
                job.name.as_str(),
                job.media.as_str(),
                job.media_type.as_deref()
            ),
            ("IMG_0001", "iso_a4_210x297mm", Some("photographic-glossy"))
        );
        assert_eq!(
            (job.borderless, job.copies, job.resolution_dpi),
            (false, 1, 300)
        );
        assert_eq!((job.page.width_px, job.page.height_px), (2480, 3508));
        assert_eq!(
            (job.place.x, job.place.y, job.place.width, job.place.height),
            (36, 36, 2408, 3436)
        );
        assert_eq!(
            job.transport,
            Transport {
                space: Space::Device,
                bits: 16
            }
        );
    }

    #[test]
    fn a_profile_is_a_capped_icc_file() {
        let dir =
            std::env::temp_dir().join(format!("bowerbird-printshim-icc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut icc = vec![0u8; 132];
        icc[36..40].copy_from_slice(b"acsp");
        std::fs::write(dir.join("good.icc"), &icc).unwrap();
        std::fs::write(dir.join("text.icc"), [b'x'; 132]).unwrap();
        std::fs::write(dir.join("short.icc"), &icc[..100]).unwrap();
        let mut huge = icc.clone();
        huge.resize(PROFILE_LIMIT as usize + 1, 0);
        std::fs::write(dir.join("huge.icc"), &huge).unwrap();
        assert_eq!(read_icc(&dir.join("good.icc")), Ok(icc));
        let kind = |name: &str| read_icc(&dir.join(name)).unwrap_err().kind;
        assert_eq!(kind("text.icc"), ErrorKind::Invalid);
        assert_eq!(kind("short.icc"), ErrorKind::Invalid);
        assert_eq!(kind("huge.icc"), ErrorKind::Invalid);
        assert_eq!(kind("."), ErrorKind::Invalid);
        assert_eq!(kind("gone.icc"), ErrorKind::Missing);
    }

    #[test]
    #[cfg(not(windows))]
    fn a_cups_name_is_one_path_segment() {
        assert_eq!(native_name("cups:Canon_PRO-200S.1"), Ok("Canon_PRO-200S.1"));
        let kind = |id: &str| native_name(id).unwrap_err().kind;
        for id in [
            "cups:a/b",
            "cups:a#b",
            "cups:a?b",
            "cups:a b",
            "cups:a\tb",
            "cups:a\u{7f}",
        ] {
            assert_eq!(kind(id), ErrorKind::Invalid, "{id:?}");
        }
        assert_eq!(kind("cups:"), ErrorKind::Missing);
        assert_eq!(kind("windows:Canon"), ErrorKind::Missing);
    }

    #[test]
    #[cfg(not(windows))]
    fn transports_rank_device_then_adobe_then_srgb_deepest_first() {
        let t = |space, bits| Transport { space, bits };
        let ranked = best_first(vec![
            t(Space::Srgb, 8),
            t(Space::AdobeRgb, 16),
            t(Space::Device, 8),
            t(Space::Srgb, 8),
            t(Space::Device, 16),
        ]);
        assert_eq!(
            ranked,
            vec![
                t(Space::Device, 16),
                t(Space::Device, 8),
                t(Space::AdobeRgb, 16),
                t(Space::Srgb, 8)
            ]
        );
        assert_eq!(
            serde_json::to_string(&ranked[2]).unwrap(),
            r#"{"space":"adobe-rgb","bits":16}"#
        );
    }
}
