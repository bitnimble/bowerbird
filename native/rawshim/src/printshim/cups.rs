//! A queue whose device is an IPP printer printshim can reach is printed to directly: through
//! cupsd its attributes describe CUPS's filters rather than what the printer takes.

use super::ipp_attributes::{self as attributes, Attributes};
use super::page::Picture;
use super::{
    Capabilities, Colour, Connection, Error, Job, JobStatus, Printer, Profile, ProfileSource,
    Result, Space, Transport, fail, pdf, printer_id, pwg,
};
use ipp::attribute::IppAttribute;
use ipp::model::{DelimiterTag, IppVersion, Operation};
use ipp::request::IppRequestResponse;
use ipp::value::IppValue;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::time::Duration;

const DEFAULT_SERVER: &str = "localhost:631";
const IPP_PORT: u16 = 631;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const SEND_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const RESPONSE_LIMIT: u64 = 64 << 20;
const CUPS_PROFILES: &str = "/usr/share/cups/profiles";
const CUPS_PRINTER_DEFAULT: i32 = 0x20000;
const CUPS_PRINTER_FAX: i32 = 0x40000;
const IPP_USB_PORTS: std::ops::RangeInclusive<u16> = 60000..=60099;
const PRINT_QUALITY_HIGH: i32 = 5;
const RESOLUTION_DPI: i8 = 3;
const PWG_RASTER: &str = "image/pwg-raster";
const PDF: &str = "application/pdf";

pub struct Cups {
    server: String,
    agent: ureq::Agent,
    /// For a printer's own HTTPS, which is self-signed.
    printer_agent: ureq::Agent,
}

struct Endpoint {
    uri: String,
    attributes: Attributes,
    raster: Vec<Transport>,
    pdf: bool,
    ppd: Option<String>,
}

impl Endpoint {
    fn transports(&self) -> Vec<Transport> {
        if !self.raster.is_empty() {
            return self.raster.clone();
        }
        if !self.pdf {
            return Vec::new();
        }
        [Space::AdobeRgb, Space::Srgb]
            .map(|space| Transport { space, bits: 16 })
            .to_vec()
    }

    fn profiles(&self) -> Vec<(Profile, Source)> {
        let printer = attributes::icc_profiles(&self.attributes)
            .into_iter()
            .map(|(name, url)| (profile(name, ProfileSource::Printer), Source::Url(url)));
        let driver = self
            .ppd
            .as_deref()
            .map(ppd_profiles)
            .unwrap_or_default()
            .into_iter()
            .map(|(name, path)| (profile(name, ProfileSource::Driver), Source::File(path)));
        printer.chain(driver).collect()
    }
}

fn profile(name: String, source: ProfileSource) -> Profile {
    Profile { name, source }
}

enum Source {
    Url(String),
    File(PathBuf),
}

impl Cups {
    pub fn from_env() -> Cups {
        Cups::at(&server(std::env::var("CUPS_SERVER").ok().as_deref()))
    }

    pub fn at(server: &str) -> Cups {
        let agent = |verify: bool| -> ureq::Agent {
            ureq::Agent::config_builder()
                .timeout_connect(Some(CONNECT_TIMEOUT))
                .timeout_send_body(Some(SEND_TIMEOUT))
                .timeout_recv_response(Some(RESPONSE_TIMEOUT))
                .timeout_recv_body(Some(RESPONSE_TIMEOUT))
                .tls_config(
                    ureq::tls::TlsConfig::builder()
                        .disable_verification(!verify)
                        .build(),
                )
                .build()
                .into()
        };
        Cups {
            server: server.to_string(),
            agent: agent(true),
            printer_agent: agent(false),
        }
    }

    pub fn list(&self) -> Result<Vec<Printer>> {
        let mut request = self.request(Operation::CupsGetPrinters, None)?;
        requested(
            &mut request,
            &[
                "printer-name",
                "printer-info",
                "printer-location",
                "printer-make-and-model",
                "device-uri",
                "printer-type",
            ],
        )?;
        let response = self.send(&format!("ipp://{}/", self.server), request, None)?;
        Ok(response
            .attributes()
            .groups_of(DelimiterTag::PrinterAttributes)
            .map(attributes::from_group)
            .filter_map(|printer| listed(&printer))
            .collect())
    }

    pub fn capabilities(&self, queue: &str) -> Result<Capabilities> {
        let endpoint = self.endpoint(queue)?;
        let printer = &endpoint.attributes;
        let sizes = attributes::media_sizes(printer);
        let resolutions = if endpoint.raster.is_empty() {
            "printer-resolution-supported"
        } else {
            "pwg-raster-document-resolution-supported"
        };
        Ok(Capabilities {
            media: sizes.iter().map(attributes::MediaSize::media).collect(),
            default_media: attributes::default_media(printer, &sizes),
            media_types: attributes::media_types(printer),
            default_media_type: attributes::default_media_type(printer),
            resolutions_dpi: attributes::resolutions(printer, resolutions),
            copies_max: attributes::copies_max(printer),
            colour: Colour {
                transports: endpoint.transports(),
                profiles: endpoint
                    .profiles()
                    .into_iter()
                    .map(|(profile, _)| profile)
                    .collect(),
            },
        })
    }

    pub fn profile(&self, queue: &str, name: &str) -> Result<Vec<u8>> {
        let endpoint = self.endpoint(queue)?;
        let Some((_, source)) = endpoint
            .profiles()
            .into_iter()
            .find(|(profile, _)| profile.name == name)
        else {
            return fail(format!("{queue} has no colour profile called {name}"));
        };
        match source {
            Source::Url(url) => {
                let agent = if host(&url) == host(&endpoint.uri) {
                    &self.printer_agent
                } else {
                    &self.agent
                };
                let mut response = agent
                    .get(&url)
                    .call()
                    .map_err(|error| unreachable(&url, error))?;
                response
                    .body_mut()
                    .with_config()
                    .limit(RESPONSE_LIMIT)
                    .read_to_vec()
                    .map_err(|error| unreachable(&url, error))
            }
            Source::File(path) => std::fs::read(&path).map_err(|error| {
                Error(format!(
                    "Can't read the profile at {}: {error}",
                    path.display()
                ))
            }),
        }
    }

    pub fn submit(&self, queue: &str, mut picture: Picture, job: &Job) -> Result<i32> {
        let endpoint = self.endpoint(queue)?;
        let sizes = attributes::media_sizes(&endpoint.attributes);
        let Some(size) = sizes.iter().find(|size| size.key == job.media) else {
            return fail(format!("{queue} doesn't take {} paper", job.media));
        };
        if job.borderless && !size.borderless {
            return fail(format!("{queue} can't print {} borderless", job.media));
        }
        if !endpoint.transports().contains(&job.transport) {
            return fail(format!(
                "{queue} doesn't take {}",
                attributes::raster_keyword(job.transport)
            ));
        }
        let (format, document) = if endpoint.raster.contains(&job.transport) {
            (PWG_RASTER, pwg::document(&mut picture, job, &job.media)?)
        } else {
            (PDF, pdf::document(&mut picture, job)?)
        };

        let mut request = self.request(Operation::PrintJob, Some(&endpoint.uri))?;
        operation(
            &mut request,
            "job-name",
            IppValue::new_name_without_language(&job.name),
        )?;
        operation(
            &mut request,
            "document-format",
            IppValue::new_mime_media_type(format),
        )?;
        let margins = if job.borderless { [0; 4] } else { size.margins };
        let mut media_col = vec![
            (
                "media-size",
                collection(vec![
                    ("x-dimension", IppValue::Integer(size.width)),
                    ("y-dimension", IppValue::Integer(size.height)),
                ])?,
            ),
            ("media-top-margin", IppValue::Integer(margins[0])),
            ("media-right-margin", IppValue::Integer(margins[1])),
            ("media-bottom-margin", IppValue::Integer(margins[2])),
            ("media-left-margin", IppValue::Integer(margins[3])),
        ];
        if let Some(media_type) = &job.media_type {
            media_col.push(("media-type", ipp_value(IppValue::new_keyword(media_type))?));
        }
        let dpi = i32::try_from(job.resolution_dpi)
            .map_err(|_| Error(format!("{} dpi is not a resolution", job.resolution_dpi)))?;
        let copies = i32::try_from(job.copies)
            .map_err(|_| Error(format!("{} copies is too many", job.copies)))?;
        for (name, value) in [
            ("media-col", collection(media_col)?),
            ("copies", IppValue::Integer(copies)),
            ("print-quality", IppValue::Enum(PRINT_QUALITY_HIGH)),
            (
                "print-color-mode",
                ipp_value(IppValue::new_keyword("color"))?,
            ),
            ("print-scaling", ipp_value(IppValue::new_keyword("none"))?),
            (
                "printer-resolution",
                IppValue::Resolution {
                    cross_feed: dpi,
                    feed: dpi,
                    units: RESOLUTION_DPI,
                },
            ),
        ] {
            add(&mut request, DelimiterTag::JobAttributes, name, Ok(value))?;
        }

        let response = self.send(&endpoint.uri, request, Some(document))?;
        let job_attributes = response
            .attributes()
            .groups_of(DelimiterTag::JobAttributes)
            .next()
            .map(attributes::from_group)
            .unwrap_or_default();
        match attributes::integer(&job_attributes, "job-id") {
            Some(id) => Ok(id),
            None => fail(format!("{queue} took the job but gave it no job number")),
        }
    }

    pub fn job(&self, queue: &str, job_id: i32) -> Result<JobStatus> {
        let endpoint = self.endpoint(queue)?;
        let mut request = self.request(Operation::GetJobAttributes, Some(&endpoint.uri))?;
        operation(&mut request, "job-id", Ok(IppValue::Integer(job_id)))?;
        requested(&mut request, &["job-state", "job-state-reasons"])?;
        let response = self.send(&endpoint.uri, request, None)?;
        response
            .attributes()
            .groups_of(DelimiterTag::JobAttributes)
            .next()
            .map(attributes::from_group)
            .and_then(|job| attributes::job_status(&job))
            .ok_or_else(|| Error(format!("{queue} gave no state for job {job_id}")))
    }

    fn endpoint(&self, queue: &str) -> Result<Endpoint> {
        let queue_uri = format!("ipp://{}/printers/{queue}", self.server);
        let queue_attributes = self.printer_attributes(&queue_uri)?;
        if let Some(device) = attributes::string(&queue_attributes, "device-uri")
            .filter(|uri| matches!(scheme(uri), "ipp" | "ipps"))
            && let Ok(printer) = self.printer_attributes(device)
        {
            let raster = attributes::raster_transports(&printer);
            if accepts(&printer, PWG_RASTER) && !raster.is_empty() {
                return Ok(Endpoint {
                    uri: device.to_string(),
                    attributes: printer,
                    raster,
                    pdf: false,
                    ppd: None,
                });
            }
        }
        let ppd = self.ppd(queue);
        Ok(Endpoint {
            raster: ppd.as_deref().map(ppd_transports).unwrap_or_default(),
            pdf: accepts(&queue_attributes, PDF),
            uri: queue_uri,
            attributes: queue_attributes,
            ppd,
        })
    }

    fn ppd(&self, queue: &str) -> Option<String> {
        let url = format!("http://{}/printers/{queue}.ppd", self.server);
        let mut response = self.agent.get(&url).call().ok()?;
        response
            .body_mut()
            .with_config()
            .limit(RESPONSE_LIMIT)
            .read_to_string()
            .ok()
    }

    fn printer_attributes(&self, uri: &str) -> Result<Attributes> {
        let mut request = self.request(Operation::GetPrinterAttributes, Some(uri))?;
        // `all` leaves out `media-col-database` (RFC 8011 5.3.2), which is the margins.
        requested(&mut request, &["all", "media-col-database"])?;
        let response = self.send(uri, request, None)?;
        response
            .attributes()
            .groups_of(DelimiterTag::PrinterAttributes)
            .next()
            .map(attributes::from_group)
            .ok_or_else(|| Error(format!("{uri} answered without its attributes")))
    }

    fn request(&self, op: Operation, printer: Option<&str>) -> Result<IppRequestResponse> {
        let mut request = IppRequestResponse::new(IppVersion::v2_0(), op, None)
            .map_err(|error| Error(format!("Can't build an IPP request: {error}")))?;
        if let Some(printer) = printer {
            operation(&mut request, "printer-uri", IppValue::new_uri(printer))?;
        }
        operation(
            &mut request,
            "requesting-user-name",
            IppValue::new_name_without_language(user_name()),
        )?;
        Ok(request)
    }

    fn send(
        &self,
        uri: &str,
        request: IppRequestResponse,
        document: Option<Vec<u8>>,
    ) -> Result<IppRequestResponse> {
        let url = http_url(uri)?;
        let agent = if scheme(&url) == "https" {
            &self.printer_agent
        } else {
            &self.agent
        };
        let header = request.to_bytes();
        let document = document.unwrap_or_default();
        let length = header.len() + document.len();
        let mut body = Cursor::new(header).chain(Cursor::new(document));
        let mut response = agent
            .post(&url)
            .header("Content-Type", "application/ipp")
            .header("Content-Length", length.to_string())
            .send(ureq::SendBody::from_reader(&mut body))
            .map_err(|error| unreachable(uri, error))?;
        let bytes = response
            .body_mut()
            .with_config()
            .limit(RESPONSE_LIMIT)
            .read_to_vec()
            .map_err(|error| unreachable(uri, error))?;
        let parsed = ipp::parser::IppParser::new(ipp::reader::IppReader::new(Cursor::new(bytes)))
            .parse()
            .map_err(|error| Error(format!("{uri} sent an unreadable IPP response: {error}")))?;
        let status = parsed.header().status_code();
        if status.is_success() {
            return Ok(parsed);
        }
        let operation_attributes = parsed
            .attributes()
            .groups_of(DelimiterTag::OperationAttributes)
            .next()
            .map(attributes::from_group)
            .unwrap_or_default();
        let message = attributes::string(&operation_attributes, "status-message")
            .map(str::to_string)
            .unwrap_or_else(|| format!("{status:?}"));
        fail(format!("{uri} refused the request: {message}"))
    }
}

fn listed(printer: &Attributes) -> Option<Printer> {
    let printer_type = attributes::integer(printer, "printer-type").unwrap_or(0);
    if printer_type & CUPS_PRINTER_FAX != 0 {
        return None;
    }
    let queue = attributes::string(printer, "printer-name")?;
    let present = |name: &str| {
        attributes::string(printer, name)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    Some(Printer {
        id: printer_id(queue),
        name: present("printer-info").unwrap_or_else(|| queue.to_string()),
        is_default: printer_type & CUPS_PRINTER_DEFAULT != 0,
        location: present("printer-location"),
        model: present("printer-make-and-model"),
        connection: connection(attributes::string(printer, "device-uri").unwrap_or("")),
    })
}

fn connection(device_uri: &str) -> Connection {
    match scheme(device_uri) {
        "usb" | "ippusb" => Connection::Usb,
        "ipp" | "ipps" if is_ipp_usb(device_uri) => Connection::Usb,
        "ipp" | "ipps" | "http" | "https" | "dnssd" | "mdns" | "socket" | "lpd" | "smb"
        | "implicitclass" => Connection::Network,
        _ => Connection::Unknown,
    }
}

/// The ipp-usb daemon, which serves a USB printer's IPP on a loopback port from 60000.
fn is_ipp_usb(uri: &str) -> bool {
    let Some(authority) = authority(uri) else {
        return false;
    };
    let (host, port) = split_port(authority);
    matches!(host, "localhost" | "127.0.0.1" | "[::1]")
        && port.is_some_and(|port| IPP_USB_PORTS.contains(&port))
}

fn accepts(printer: &Attributes, format: &str) -> bool {
    attributes::strings(printer, "document-format-supported").contains(&format)
}

/// What a queue's PPD forwards untouched as PWG raster: its `*ColorModel` choices, when a
/// `*cupsFilter2` passes `image/pwg-raster` through with no filter.
fn ppd_transports(ppd: &str) -> Vec<Transport> {
    let passes_raster = ppd.lines().any(|line| {
        let fields: Vec<&str> = quoted(line, "*cupsFilter2:")
            .or_else(|| quoted(line, "*cupsFilter:"))
            .map(|value| value.split_whitespace().collect())
            .unwrap_or_default();
        fields.first() == Some(&PWG_RASTER) && fields.last() == Some(&"-")
    });
    if !passes_raster {
        return Vec::new();
    }
    let setting = |code: &str, name: &str| -> Option<u32> {
        let after = &code[code.find(name)? + name.len()..];
        let digits = after
            .trim_start()
            .split(|c: char| !c.is_ascii_digit())
            .next()?;
        digits.parse().ok()
    };
    super::best_first(
        ppd.lines()
            .filter(|line| line.starts_with("*ColorModel "))
            .filter_map(|line| {
                let code = line.split_once(':')?.1;
                let space = match setting(code, "/cupsColorSpace")? {
                    1 => Space::Device,
                    19 => Space::Srgb,
                    20 => Space::AdobeRgb,
                    _ => return None,
                };
                let bits = match setting(code, "/cupsBitsPerColor")? {
                    8 => 8,
                    16 => 16,
                    _ => return None,
                };
                Some(Transport { space, bits })
            })
            .collect(),
    )
}

/// `*cupsICCProfile ColorModel.MediaType.Resolution/Description: "file"`, named by its
/// description where it has one. A relative file is under CUPS's profiles directory.
fn ppd_profiles(ppd: &str) -> Vec<(String, PathBuf)> {
    ppd.lines()
        .filter_map(|line| {
            let rest = line.strip_prefix("*cupsICCProfile ")?;
            let (selector, _) = rest.split_once(':')?;
            let file = quoted(line, &format!("*cupsICCProfile {selector}:"))?;
            let name = selector
                .split_once('/')
                .map_or(selector, |(_, description)| description);
            let path = Path::new(file);
            let path = if path.is_absolute() {
                path.to_owned()
            } else {
                Path::new(CUPS_PROFILES).join(path)
            };
            Some((name.trim().to_string(), path))
        })
        .collect()
}

fn quoted<'a>(line: &'a str, keyword: &str) -> Option<&'a str> {
    let value = line.strip_prefix(keyword)?.trim();
    value.strip_prefix('"')?.strip_suffix('"')
}

fn requested(request: &mut IppRequestResponse, names: &[&str]) -> Result<()> {
    let values = names
        .iter()
        .map(|name| ipp_value(IppValue::new_keyword(*name)))
        .collect::<Result<Vec<_>>>()?;
    operation(request, "requested-attributes", Ok(IppValue::Array(values)))
}

fn operation(
    request: &mut IppRequestResponse,
    name: &str,
    value: std::result::Result<IppValue, ipp::parser::IppParseError>,
) -> Result<()> {
    add(request, DelimiterTag::OperationAttributes, name, value)
}

fn add(
    request: &mut IppRequestResponse,
    group: DelimiterTag,
    name: &str,
    value: std::result::Result<IppValue, ipp::parser::IppParseError>,
) -> Result<()> {
    let attribute = IppAttribute::with_name(name, ipp_value(value)?)
        .map_err(|error| Error(format!("Can't encode {name}: {error}")))?;
    request.attributes_mut().add(group, attribute);
    Ok(())
}

fn ipp_value(value: std::result::Result<IppValue, ipp::parser::IppParseError>) -> Result<IppValue> {
    value.map_err(|error| Error(format!("Can't encode an IPP value: {error}")))
}

fn collection(members: Vec<(&str, IppValue)>) -> Result<IppValue> {
    members
        .into_iter()
        .map(|(name, value)| {
            let name = name
                .try_into()
                .map_err(|error| Error(format!("Can't encode {name}: {error}")))?;
            Ok((name, value))
        })
        .collect::<Result<_>>()
        .map(IppValue::Collection)
}

fn user_name() -> String {
    ["USER", "USERNAME", "LOGNAME"]
        .into_iter()
        .find_map(|name| std::env::var(name).ok().filter(|value| !value.is_empty()))
        .unwrap_or_else(|| "bowerbird".to_string())
}

fn unreachable(uri: &str, error: ureq::Error) -> Error {
    Error(format!("Can't reach {uri}: {error}"))
}

/// `CUPS_SERVER` as libcups reads it, less the domain socket, which has no HTTP to speak.
fn server(configured: Option<&str>) -> String {
    match configured.map(str::trim) {
        Some(server) if !server.is_empty() && !server.starts_with('/') => {
            match split_port(server) {
                (_, Some(_)) => server.to_string(),
                (host, None) => format!("{host}:{IPP_PORT}"),
            }
        }
        _ => DEFAULT_SERVER.to_string(),
    }
}

fn scheme(uri: &str) -> &str {
    uri.split_once(':').map_or("", |(scheme, _)| scheme)
}

fn authority(uri: &str) -> Option<&str> {
    let rest = uri.split_once("://")?.1;
    Some(rest.split(['/', '?']).next().unwrap_or(rest))
}

fn host(uri: &str) -> Option<&str> {
    authority(uri).map(|authority| split_port(authority).0)
}

fn split_port(authority: &str) -> (&str, Option<u16>) {
    let colon = match authority.rfind(':') {
        Some(colon) if !authority[colon..].contains(']') => colon,
        _ => return (authority, None),
    };
    match authority[colon + 1..].parse() {
        Ok(port) => (&authority[..colon], Some(port)),
        Err(_) => (authority, None),
    }
}

/// IPP's URI as the HTTP it is carried over; both schemes default to port 631 (RFC 8010,
/// RFC 7472).
fn http_url(uri: &str) -> Result<String> {
    let scheme = match scheme(uri) {
        "ipp" | "http" => "http",
        "ipps" | "https" => "https",
        _ => return fail(format!("{uri} is not an IPP address")),
    };
    let (Some(authority), Some((_, rest))) = (authority(uri), uri.split_once("://")) else {
        return fail(format!("{uri} is not an IPP address"));
    };
    let path = &rest[authority.len()..];
    let path = if path.is_empty() { "/" } else { path };
    let authority = match split_port(authority) {
        (_, Some(_)) => authority.to_string(),
        (host, None) => format!("{host}:{IPP_PORT}"),
    };
    Ok(format!("{scheme}://{authority}{path}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_uris_say_how_the_printer_is_connected() {
        assert_eq!(connection("usb://Canon/PRO-200S?serial=1"), Connection::Usb);
        assert_eq!(connection("ippusb://Canon/"), Connection::Usb);
        assert_eq!(
            connection("ipp://localhost:60001/ipp/print"),
            Connection::Usb
        );
        assert_eq!(
            connection("ipp://localhost:631/printers/x"),
            Connection::Network
        );
        assert_eq!(
            connection("ipps://printer.local:631/ipp/print"),
            Connection::Network
        );
        assert_eq!(
            connection("dnssd://Canon._ipps._tcp.local./?uuid=1"),
            Connection::Network
        );
        assert_eq!(connection("socket://10.0.0.5:9100"), Connection::Network);
        assert_eq!(connection("file:///dev/null"), Connection::Unknown);
        assert_eq!(connection(""), Connection::Unknown);
    }

    #[test]
    fn addresses_reach_the_right_port() {
        assert_eq!(server(None), "localhost:631");
        assert_eq!(server(Some("/run/cups/cups.sock")), "localhost:631");
        assert_eq!(server(Some("print.example")), "print.example:631");
        assert_eq!(server(Some("localhost:6631")), "localhost:6631");
        assert_eq!(server(Some("[::1]")), "[::1]:631");
        assert_eq!(
            http_url("ipps://printer.local/ipp/print").unwrap(),
            "https://printer.local:631/ipp/print"
        );
        assert_eq!(
            http_url("ipp://[::1]:8701/ipp/print?x=1").unwrap(),
            "http://[::1]:8701/ipp/print?x=1"
        );
        assert_eq!(
            http_url("ipp://localhost:6631").unwrap(),
            "http://localhost:6631/"
        );
        assert!(http_url("socket://10.0.0.5:9100").is_err());
        assert_eq!(host("http://127.0.0.1:6631/a.icc"), Some("127.0.0.1"));
    }

    const EVERYWHERE_PPD: &str = r#"*PPD-Adobe: "4.3"
*cupsFilter2: "image/pwg-raster image/pwg-raster 100 -"
*ColorModel AdobeRGB: "<</cupsColorSpace 20/cupsBitsPerColor 16/cupsColorOrder 0/cupsCompression 0>>setpagedevice"
*en_US.ColorModel AdobeRGB/Deep Color: ""
*ColorModel RGB: "<</cupsColorSpace 19/cupsBitsPerColor 8/cupsColorOrder 0/cupsCompression 0>>setpagedevice"
*ColorModel DeviceRGB: "<</cupsColorSpace 1/cupsBitsPerColor 16/cupsColorOrder 0/cupsCompression 0>>setpagedevice"
*ColorModel Gray: "<</cupsColorSpace 18/cupsBitsPerColor 8/cupsColorOrder 0/cupsCompression 0>>setpagedevice"
"#;

    #[test]
    fn a_ppd_that_passes_raster_through_offers_its_colour_models() {
        let t = |space, bits| Transport { space, bits };
        assert_eq!(
            ppd_transports(EVERYWHERE_PPD),
            vec![
                t(Space::Device, 16),
                t(Space::AdobeRgb, 16),
                t(Space::Srgb, 8)
            ]
        );
        let filtered = EVERYWHERE_PPD.replace(
            "image/pwg-raster image/pwg-raster 100 -",
            "image/pwg-raster application/vnd.cups-raster 100 rastertoacme",
        );
        assert_eq!(ppd_transports(&filtered), Vec::new());
    }

    #[test]
    fn ppd_profiles_resolve_relative_files_under_cups() {
        let ppd = "*cupsICCProfile RGB.Glossy.300dpi/Glossy photo: \"/opt/acme/glossy.icc\"\n\
                   *cupsICCProfile RGB.Plain.: \"acme/plain.icc\"\n";
        assert_eq!(
            ppd_profiles(ppd),
            vec![
                (
                    "Glossy photo".to_string(),
                    PathBuf::from("/opt/acme/glossy.icc")
                ),
                (
                    "RGB.Plain.".to_string(),
                    PathBuf::from("/usr/share/cups/profiles/acme/plain.icc")
                ),
            ]
        );
    }

    #[test]
    fn cups_get_printers_attributes_become_a_printer() {
        let name = |value: &str| IppValue::NameWithoutLanguage(value.try_into().unwrap());
        let text = |value: &str| IppValue::TextWithoutLanguage(value.try_into().unwrap());
        let mut printer = Attributes::new();
        printer.insert("printer-name".into(), name("Canon_PRO_200S"));
        printer.insert("printer-info".into(), text("Canon PRO-200S"));
        printer.insert("printer-location".into(), text(""));
        printer.insert(
            "printer-make-and-model".into(),
            text("Canon PRO-200S series"),
        );
        printer.insert(
            "device-uri".into(),
            IppValue::Uri("usb://Canon/PRO-200S".try_into().unwrap()),
        );
        printer.insert("printer-type".into(), IppValue::Enum(0x21004));
        assert_eq!(
            listed(&printer),
            Some(Printer {
                id: "cups:Canon_PRO_200S".into(),
                name: "Canon PRO-200S".into(),
                is_default: true,
                location: None,
                model: Some("Canon PRO-200S series".into()),
                connection: Connection::Usb,
            })
        );
        printer.insert("printer-type".into(), IppValue::Enum(0x41004));
        assert_eq!(listed(&printer), None, "a fax is not a printer here");
    }
}
