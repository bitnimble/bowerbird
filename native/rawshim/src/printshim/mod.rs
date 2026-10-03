use serde::{Deserialize, Serialize};
use std::path::PathBuf;

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error(pub String);

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;

pub(crate) fn fail<T>(message: impl Into<String>) -> Result<T> {
    Err(Error(message.into()))
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
    job_id: i32,
}

#[cfg(not(windows))]
const PREFIX: &str = "cups:";
#[cfg(windows)]
const PREFIX: &str = "windows:";

fn native_name(id: &str) -> Result<&str> {
    match id.strip_prefix(PREFIX) {
        Some(name) if !name.is_empty() => Ok(name),
        _ => fail(format!("{id} is not a printer on this system")),
    }
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
