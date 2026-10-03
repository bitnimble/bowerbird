use super::ipp_attributes::{self as attributes, Attributes};
use super::page::Picture;
use super::{
    Capabilities, Colour, Connection, Error, Job, JobStatus, PROFILE_LIMIT, Printer, Profile,
    ProfileSource, Result, Space, Transport, checked_icc, pdf, printer_id, pwg, read_icc,
};
use ipp::attribute::IppAttribute;
use ipp::model::{DelimiterTag, IppVersion, Operation, StatusCode};
use ipp::request::IppRequestResponse;
use ipp::value::IppValue;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::time::Duration;

const DEFAULT_SERVER: &str = "localhost:631";
const IPP_PORT: u16 = 631;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const PRINT_RESPONSE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const PRINT_SEND_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const RESPONSE_LIMIT: u64 = 64 << 20;
const CUPS_PROFILES: &str = "/usr/share/cups/profiles";
const PROFILE_ROOTS: [&str; 6] = [
    CUPS_PROFILES,
    "/usr/share/color",
    "/var/lib/colord",
    "/Library/ColorSync",
    "/Library/Printers",
    "/System/Library/ColorSync",
];
// `all` leaves out `media-col-database` (RFC 8011 5.3.2), which is the margins.
const EVERY_ATTRIBUTE: [&str; 2] = ["all", "media-col-database"];
const ROUTE_ATTRIBUTES: [&str; 2] = [
    "document-format-supported",
    "pwg-raster-document-type-supported",
];
const VITAL_JOB_ATTRIBUTES: [(&str, &str); 3] = [
    ("media-col", "paper"),
    ("printer-resolution", "resolution"),
    ("print-scaling", "scaling"),
];
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
    pub(super) profile_roots: Vec<PathBuf>,
}

struct Endpoint {
    uri: String,
    attributes: Attributes,
    queue: Attributes,
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
        // A filtered PDF is rasterised again, at the filter's 8 bits.
        let bits = if self.ppd.as_deref().is_some_and(|ppd| passes(ppd, PDF)) {
            16
        } else {
            8
        };
        [Space::AdobeRgb, Space::Srgb]
            .map(|space| Transport { space, bits })
            .to_vec()
    }
}

enum Source {
    Url(String),
    File(PathBuf),
}

struct Listed {
    name: String,
    detail: String,
    source: ProfileSource,
    at: Source,
}

impl Cups {
    pub fn from_env() -> Cups {
        Cups::at(&server(std::env::var("CUPS_SERVER").ok().as_deref()))
    }

    pub fn at(server: &str) -> Cups {
        let agent = |verify: bool| -> ureq::Agent {
            ureq::Agent::config_builder()
                .timeout_connect(Some(CONNECT_TIMEOUT))
                .timeout_global(Some(REQUEST_TIMEOUT))
                .max_redirects(0)
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
            profile_roots: PROFILE_ROOTS.iter().map(PathBuf::from).collect(),
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
        let media_types = attributes::media_types(printer);
        // The queue's defaults are the ones the reader sets in the system's printer settings.
        let default_media_type = [&endpoint.queue, printer]
            .into_iter()
            .filter_map(attributes::default_media_type)
            .find(|key| media_types.iter().any(|offered| offered.key == *key));
        Ok(Capabilities {
            media: sizes.iter().map(attributes::MediaSize::media).collect(),
            default_media: attributes::default_media(&endpoint.queue, &sizes)
                .or_else(|| attributes::default_media(printer, &sizes)),
            media_types,
            default_media_type,
            resolutions_dpi: attributes::resolutions(printer, resolutions),
            copies_max: attributes::copies_max(printer),
            colour: Colour {
                transports: endpoint.transports(),
                profiles: self
                    .profiles(&endpoint)
                    .into_iter()
                    .map(|(profile, _)| profile)
                    .collect(),
            },
        })
    }

    pub fn profile(&self, queue: &str, name: &str) -> Result<Vec<u8>> {
        let endpoint = self.endpoint(queue)?;
        let Some((_, source)) = self
            .profiles(&endpoint)
            .into_iter()
            .find(|(profile, _)| profile.name == name)
        else {
            return Err(Error::missing(format!(
                "{queue} has no colour profile called {name}"
            )));
        };
        match source {
            Source::Url(url) => checked_icc(self.get(&url, PROFILE_LIMIT)?, &url),
            Source::File(path) => read_icc(&self.allowed_profile(&path)?),
        }
    }

    pub fn submit(&self, queue: &str, mut picture: Picture, job: &Job) -> Result<Option<i32>> {
        let endpoint = self.endpoint(queue)?;
        let sizes = attributes::media_sizes(&endpoint.attributes);
        let Some(size) = sizes.iter().find(|size| size.key == job.media) else {
            return Err(Error::invalid(format!(
                "{queue} doesn't take {} paper",
                job.media
            )));
        };
        if job.borderless && !size.borderless {
            return Err(Error::invalid(format!(
                "{queue} can't print {} borderless",
                job.media
            )));
        }
        if let Some(media_type) = &job.media_type
            && !attributes::media_types(&endpoint.attributes)
                .iter()
                .any(|offered| offered.key == *media_type)
        {
            return Err(Error::invalid(format!(
                "{queue} doesn't take {media_type} paper"
            )));
        }
        if !endpoint.transports().contains(&job.transport) {
            return Err(Error::invalid(format!(
                "{queue} doesn't take {}",
                attributes::raster_keyword(job.transport)
            )));
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
        let dpi = i32::try_from(job.resolution_dpi).map_err(|_| {
            Error::invalid(format!("{} dpi is not a resolution", job.resolution_dpi))
        })?;
        let copies = i32::try_from(job.copies)
            .map_err(|_| Error::invalid(format!("{} copies is too many", job.copies)))?;
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
        let job_id = response
            .attributes()
            .groups_of(DelimiterTag::JobAttributes)
            .next()
            .map(attributes::from_group)
            .and_then(|job| attributes::integer(&job, "job-id"));
        let ignored = ignored_vital_attributes(&response);
        if ignored.is_empty() {
            return Ok(job_id);
        }
        if let Some(job_id) = job_id {
            let _ = self.cancel(&endpoint.uri, job_id);
        }
        Err(Error::unavailable(format!(
            "{queue} can't print with the {} asked for",
            ignored.join(" and ")
        )))
    }

    pub fn job(&self, queue: &str, job_id: i32) -> Result<JobStatus> {
        let queue_uri = self.queue_uri(queue);
        let queue_attributes = self.printer_attributes(&queue_uri, &["device-uri"])?;
        let uri = self
            .direct(&queue_attributes, &ROUTE_ATTRIBUTES)
            .map_or(queue_uri, |(device, ..)| device);
        let mut request = self.request(Operation::GetJobAttributes, Some(&uri))?;
        operation(&mut request, "job-id", Ok(IppValue::Integer(job_id)))?;
        requested(&mut request, &["job-state", "job-state-reasons"])?;
        let response = self.send(&uri, request, None)?;
        response
            .attributes()
            .groups_of(DelimiterTag::JobAttributes)
            .next()
            .map(attributes::from_group)
            .and_then(|job| attributes::job_status(&job))
            .ok_or_else(|| Error::unavailable(format!("{queue} gave no state for job {job_id}")))
    }

    fn cancel(&self, uri: &str, job_id: i32) -> Result<()> {
        let mut request = self.request(Operation::CancelJob, Some(uri))?;
        operation(&mut request, "job-id", Ok(IppValue::Integer(job_id)))?;
        self.send(uri, request, None).map(drop)
    }

    fn endpoint(&self, queue: &str) -> Result<Endpoint> {
        let queue_uri = self.queue_uri(queue);
        let queue_attributes = self.printer_attributes(&queue_uri, &EVERY_ATTRIBUTE)?;
        if let Some((uri, attributes, raster)) = self.direct(&queue_attributes, &EVERY_ATTRIBUTE) {
            return Ok(Endpoint {
                uri,
                attributes,
                queue: queue_attributes,
                raster,
                pdf: false,
                ppd: None,
            });
        }
        let ppd = self.ppd(queue);
        Ok(Endpoint {
            raster: ppd.as_deref().map(ppd_transports).unwrap_or_default(),
            pdf: accepts(&queue_attributes, PDF),
            uri: queue_uri,
            attributes: queue_attributes.clone(),
            queue: queue_attributes,
            ppd,
        })
    }

    fn direct(
        &self,
        queue: &Attributes,
        requested: &[&str],
    ) -> Option<(String, Attributes, Vec<Transport>)> {
        let device = attributes::string(queue, "device-uri")
            .filter(|uri| matches!(scheme(uri), "ipp" | "ipps"))?;
        let printer = self.printer_attributes(device, requested).ok()?;
        let raster = attributes::raster_transports(&printer);
        (accepts(&printer, PWG_RASTER) && !raster.is_empty())
            .then(|| (device.to_string(), printer, raster))
    }

    fn queue_uri(&self, queue: &str) -> String {
        format!("ipp://{}/printers/{}", self.server, path_segment(queue))
    }

    fn ppd(&self, queue: &str) -> Option<String> {
        let url = format!(
            "http://{}/printers/{}.ppd",
            self.server,
            path_segment(queue)
        );
        let ppd = self.get(&url, RESPONSE_LIMIT).ok()?;
        Some(String::from_utf8_lossy(&ppd).into_owned())
    }

    fn get(&self, url: &str, limit: u64) -> Result<Vec<u8>> {
        let agent = if scheme(url) == "https" {
            &self.printer_agent
        } else {
            &self.agent
        };
        let mut response = agent
            .get(url)
            .call()
            .map_err(|error| unreachable(url, error))?;
        if !response.status().is_success() {
            return Err(Error::unavailable(format!(
                "{url} answered {}",
                response.status()
            )));
        }
        response
            .body_mut()
            .with_config()
            .limit(limit)
            .read_to_vec()
            .map_err(|error| unreachable(url, error))
    }

    fn profiles(&self, endpoint: &Endpoint) -> Vec<(Profile, Source)> {
        let printer = attributes::icc_profiles(&endpoint.attributes)
            .into_iter()
            .filter(|(_, url)| on_the_printer(url, &endpoint.uri))
            .map(|(name, url)| Listed {
                name,
                detail: url.clone(),
                source: ProfileSource::Printer,
                at: Source::Url(url),
            });
        let driver = endpoint
            .ppd
            .as_deref()
            .filter(|_| self.is_local())
            .map(ppd_profiles)
            .unwrap_or_default();
        unique(printer.chain(driver).collect())
    }

    fn is_local(&self) -> bool {
        is_loopback(split_port(&self.server).0)
    }

    fn allowed_profile(&self, path: &Path) -> Result<PathBuf> {
        let canonical = path.canonicalize().map_err(|error| {
            Error::missing(format!(
                "Can't find the profile at {}: {error}",
                path.display()
            ))
        })?;
        let allowed = self
            .profile_roots
            .iter()
            .filter_map(|root| root.canonicalize().ok())
            .any(|root| canonical.starts_with(root));
        if !allowed {
            return Err(Error::invalid(format!(
                "{} is outside the colour profile folders",
                canonical.display()
            )));
        }
        Ok(canonical)
    }

    fn printer_attributes(&self, uri: &str, names: &[&str]) -> Result<Attributes> {
        let mut request = self.request(Operation::GetPrinterAttributes, Some(uri))?;
        requested(&mut request, names)?;
        let response = self.send(uri, request, None)?;
        response
            .attributes()
            .groups_of(DelimiterTag::PrinterAttributes)
            .next()
            .map(attributes::from_group)
            .ok_or_else(|| Error::unavailable(format!("{uri} answered without its attributes")))
    }

    fn request(&self, op: Operation, printer: Option<&str>) -> Result<IppRequestResponse> {
        let mut request = IppRequestResponse::new(IppVersion::v2_0(), op, None)
            .map_err(|error| Error::unavailable(format!("Can't build an IPP request: {error}")))?;
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
        let mut post = agent.post(&url);
        if document.is_some() {
            post = post
                .config()
                .timeout_global(None)
                .timeout_send_body(Some(PRINT_SEND_TIMEOUT))
                .timeout_recv_response(Some(PRINT_RESPONSE_TIMEOUT))
                .timeout_recv_body(Some(REQUEST_TIMEOUT))
                .build();
        }
        let document = document.unwrap_or_default();
        let length = header.len() + document.len();
        let mut body = Cursor::new(header).chain(Cursor::new(document));
        let mut response = post
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
            .map_err(|error| {
                Error::unavailable(format!("{uri} sent an unreadable IPP response: {error}"))
            })?;
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
        let message = format!("{uri} refused the request: {message}");
        Err(if status == StatusCode::ClientErrorNotFound {
            Error::missing(message)
        } else {
            Error::unavailable(message)
        })
    }
}

fn ignored_vital_attributes(response: &IppRequestResponse) -> Vec<&'static str> {
    if response.header().status_code() != StatusCode::SuccessfulOkIgnoredOrSubstitutedAttributes {
        return Vec::new();
    }
    let ignored: Vec<String> = response
        .attributes()
        .groups_of(DelimiterTag::UnsupportedAttributes)
        .flat_map(|group| attributes::from_group(group).into_keys())
        .collect();
    VITAL_JOB_ATTRIBUTES
        .into_iter()
        .filter(|(name, _)| ignored.iter().any(|ignored| ignored == name))
        .map(|(_, setting)| setting)
        .collect()
}

fn unique(listed: Vec<Listed>) -> Vec<(Profile, Source)> {
    let names: Vec<String> = listed
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let namesakes = || listed.iter().filter(|other| other.name == entry.name);
            if namesakes().count() == 1 {
                return entry.name.clone();
            }
            let detail_tells_apart = entry.detail != entry.name
                && namesakes()
                    .filter(|other| other.detail == entry.detail)
                    .count()
                    == 1;
            if detail_tells_apart {
                return format!("{} ({})", entry.name, entry.detail);
            }
            let nth = listed[..=index]
                .iter()
                .filter(|other| other.name == entry.name)
                .count();
            format!("{} ({nth})", entry.name)
        })
        .collect();
    listed
        .into_iter()
        .zip(names)
        .map(|(entry, name)| {
            (
                Profile {
                    name,
                    source: entry.source,
                },
                entry.at,
            )
        })
        .collect()
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
    is_loopback(host) && port.is_some_and(|port| IPP_USB_PORTS.contains(&port))
}

fn is_loopback(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost") || matches!(host, "127.0.0.1" | "[::1]")
}

fn accepts(printer: &Attributes, format: &str) -> bool {
    attributes::strings(printer, "document-format-supported").contains(&format)
}

fn passes(ppd: &str, format: &str) -> bool {
    ppd.lines().any(|line| {
        let fields: Vec<&str> = quoted(line, "*cupsFilter2:")
            .or_else(|| quoted(line, "*cupsFilter:"))
            .map(|value| value.split_whitespace().collect())
            .unwrap_or_default();
        fields.first() == Some(&format) && fields.last() == Some(&"-")
    })
}

fn ppd_transports(ppd: &str) -> Vec<Transport> {
    if !passes(ppd, PWG_RASTER) {
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

fn ppd_profiles(ppd: &str) -> Vec<Listed> {
    ppd.lines()
        .filter_map(|line| {
            let rest = line.strip_prefix("*cupsICCProfile ")?;
            let (selector, _) = rest.split_once(':')?;
            let file = quoted(line, &format!("*cupsICCProfile {selector}:"))?;
            let (choice, name) = selector.split_once('/').unwrap_or((selector, selector));
            let path = Path::new(file);
            let path = if path.is_absolute() {
                path.to_owned()
            } else {
                Path::new(CUPS_PROFILES).join(path)
            };
            Some(Listed {
                name: name.trim().to_string(),
                detail: choice.trim().to_string(),
                source: ProfileSource::Driver,
                at: Source::File(path),
            })
        })
        .collect()
}

fn path_segment(text: &str) -> String {
    text.bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
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
        .map_err(|error| Error::invalid(format!("Can't encode {name}: {error}")))?;
    request.attributes_mut().add(group, attribute);
    Ok(())
}

fn ipp_value(value: std::result::Result<IppValue, ipp::parser::IppParseError>) -> Result<IppValue> {
    value.map_err(|error| Error::invalid(format!("Can't encode an IPP value: {error}")))
}

fn collection(members: Vec<(&str, IppValue)>) -> Result<IppValue> {
    members
        .into_iter()
        .map(|(name, value)| {
            let name = name
                .try_into()
                .map_err(|error| Error::invalid(format!("Can't encode {name}: {error}")))?;
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
    Error::unavailable(format!("Can't reach {uri}: {error}"))
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

fn on_the_printer(url: &str, printer: &str) -> bool {
    let same_host =
        matches!((host(url), host(printer)), (Some(a), Some(b)) if a.eq_ignore_ascii_case(b));
    matches!(scheme(url), "http" | "https")
        && same_host
        && port_of(url)
            .is_some_and(|port| port == 80 || port == 443 || Some(port) == port_of(printer))
}

fn port_of(uri: &str) -> Option<u16> {
    let explicit = split_port(authority(uri)?).1;
    explicit.or(match scheme(uri) {
        "ipp" | "ipps" => Some(IPP_PORT),
        "http" => Some(80),
        "https" => Some(443),
        _ => None,
    })
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
        _ => return Err(Error::unavailable(format!("{uri} is not an IPP address"))),
    };
    let (Some(authority), Some((_, rest))) = (authority(uri), uri.split_once("://")) else {
        return Err(Error::unavailable(format!("{uri} is not an IPP address")));
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
    use super::super::ErrorKind;
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

    fn named(profiles: &[(Profile, Source)]) -> Vec<(&str, &Path)> {
        profiles
            .iter()
            .map(|(profile, source)| match source {
                Source::File(path) => (profile.name.as_str(), path.as_path()),
                Source::Url(url) => (profile.name.as_str(), Path::new(url)),
            })
            .collect()
    }

    #[test]
    fn ppd_profiles_resolve_relative_files_under_cups() {
        let ppd = "*cupsICCProfile RGB.Glossy.300dpi/Glossy photo: \"/opt/acme/glossy.icc\"\n\
                   *cupsICCProfile RGB.Plain.: \"acme/plain.icc\"\n";
        assert_eq!(
            named(&unique(ppd_profiles(ppd))),
            vec![
                ("Glossy photo", Path::new("/opt/acme/glossy.icc")),
                (
                    "RGB.Plain.",
                    Path::new("/usr/share/cups/profiles/acme/plain.icc")
                ),
            ]
        );
    }

    #[test]
    fn profiles_sharing_a_description_are_told_apart_by_their_selector() {
        let ppd = "*cupsICCProfile RGB.Glossy.300dpi/Glossy photo: \"a.icc\"\n\
                   *cupsICCProfile RGB.Glossy.600dpi/Glossy photo: \"b.icc\"\n\
                   *cupsICCProfile RGB.Plain./Plain: \"c.icc\"\n\
                   *cupsICCProfile RGB.Matte.: \"d.icc\"\n\
                   *cupsICCProfile RGB.Matte.: \"e.icc\"\n";
        assert_eq!(
            named(&unique(ppd_profiles(ppd))),
            vec![
                (
                    "Glossy photo (RGB.Glossy.300dpi)",
                    Path::new("/usr/share/cups/profiles/a.icc")
                ),
                (
                    "Glossy photo (RGB.Glossy.600dpi)",
                    Path::new("/usr/share/cups/profiles/b.icc")
                ),
                ("Plain", Path::new("/usr/share/cups/profiles/c.icc")),
                (
                    "RGB.Matte. (1)",
                    Path::new("/usr/share/cups/profiles/d.icc")
                ),
                (
                    "RGB.Matte. (2)",
                    Path::new("/usr/share/cups/profiles/e.icc")
                ),
            ]
        );
    }

    #[test]
    fn a_printers_profile_is_fetched_only_from_the_printer() {
        let printer = "ipps://printer.local/ipp/print";
        assert!(on_the_printer("https://printer.local/glossy.icc", printer));
        assert!(on_the_printer(
            "http://PRINTER.local:80/glossy.icc",
            printer
        ));
        assert!(on_the_printer(
            "http://printer.local:631/glossy.icc",
            printer
        ));
        assert!(!on_the_printer(
            "http://printer.local:6379/glossy.icc",
            printer
        ));
        assert!(!on_the_printer(
            "http://elsewhere.local/glossy.icc",
            printer
        ));
        assert!(!on_the_printer(
            "http://printer.local@elsewhere.local/glossy.icc",
            printer
        ));
        assert!(!on_the_printer("file://printer.local/glossy.icc", printer));
        assert!(on_the_printer(
            "http://127.0.0.1:8701/icon.png",
            "ipp://127.0.0.1:8701/ipp/print"
        ));
        assert!(!on_the_printer(
            "http://127.0.0.1:6631/sandbox.icc",
            "ipp://127.0.0.1:8701/ipp/print"
        ));
    }

    #[test]
    fn a_pdf_keeps_its_depth_only_when_the_ppd_passes_it_through() {
        let endpoint = |ppd: Option<&str>| Endpoint {
            uri: "ipp://localhost/printers/Pdf".into(),
            attributes: Attributes::new(),
            queue: Attributes::new(),
            raster: Vec::new(),
            pdf: true,
            ppd: ppd.map(str::to_string),
        };
        let at = |bits| {
            vec![
                Transport {
                    space: Space::AdobeRgb,
                    bits,
                },
                Transport {
                    space: Space::Srgb,
                    bits,
                },
            ]
        };
        let passthrough = "*cupsFilter2: \"application/pdf application/pdf 0 -\"\n";
        let filtered =
            "*cupsFilter2: \"application/vnd.cups-raster application/vnd.acme 0 rastertoacme\"\n";
        assert_eq!(endpoint(Some(passthrough)).transports(), at(16));
        assert_eq!(endpoint(Some(filtered)).transports(), at(8));
        assert_eq!(endpoint(None).transports(), at(8));
    }

    #[test]
    fn a_job_whose_paper_resolution_or_scaling_was_ignored_is_caught() {
        let response = |status, ignored: &[&str]| {
            let mut response =
                IppRequestResponse::new_response(IppVersion::v2_0(), status, 1).unwrap();
            for name in ignored {
                add(
                    &mut response,
                    DelimiterTag::UnsupportedAttributes,
                    name,
                    IppValue::new_keyword("none"),
                )
                .unwrap();
            }
            response
        };
        let substituted = StatusCode::SuccessfulOkIgnoredOrSubstitutedAttributes;
        assert_eq!(
            ignored_vital_attributes(&response(
                substituted,
                &["print-quality", "printer-resolution", "media-col"]
            )),
            vec!["paper", "resolution"]
        );
        assert!(ignored_vital_attributes(&response(substituted, &["print-quality"])).is_empty());
        assert!(
            ignored_vital_attributes(&response(StatusCode::SuccessfulOk, &["media-col"]))
                .is_empty()
        );
    }

    #[test]
    fn a_queue_is_one_percent_encoded_path_segment() {
        assert_eq!(path_segment("Canon_PRO-200S.1~"), "Canon_PRO-200S.1~");
        assert_eq!(path_segment("a+b@c:d%"), "a%2Bb%40c%3Ad%25");
        assert_eq!(path_segment("Café"), "Caf%C3%A9");
        assert_eq!(
            Cups::at("localhost:631").queue_uri("a+b"),
            "ipp://localhost:631/printers/a%2Bb"
        );
    }

    #[test]
    #[cfg(unix)]
    fn driver_profiles_come_only_from_a_local_server_and_its_colour_folders() {
        assert!(Cups::at("localhost:631").is_local());
        assert!(Cups::at("127.0.0.1:6631").is_local());
        assert!(Cups::at("[::1]:631").is_local());
        assert!(!Cups::at("print.example:631").is_local());

        let root = std::env::temp_dir().join(format!(
            "bowerbird-printshim-profile-roots-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let allowed = root.join("allowed");
        std::fs::create_dir_all(&allowed).unwrap();
        std::fs::write(allowed.join("in.icc"), b"x").unwrap();
        std::fs::write(root.join("out.icc"), b"x").unwrap();
        std::os::unix::fs::symlink(root.join("out.icc"), allowed.join("escape.icc")).unwrap();
        let mut cups = Cups::at("localhost:631");
        cups.profile_roots = vec![allowed.clone()];
        assert_eq!(
            cups.allowed_profile(&allowed.join("in.icc")).unwrap(),
            allowed.join("in.icc").canonicalize().unwrap()
        );
        let kind = |path: PathBuf| cups.allowed_profile(&path).unwrap_err().kind;
        assert_eq!(kind(root.join("out.icc")), ErrorKind::Invalid);
        assert_eq!(kind(allowed.join("escape.icc")), ErrorKind::Invalid);
        assert_eq!(kind(allowed.join("../out.icc")), ErrorKind::Invalid);
        assert_eq!(kind(allowed.join("gone.icc")), ErrorKind::Missing);
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
