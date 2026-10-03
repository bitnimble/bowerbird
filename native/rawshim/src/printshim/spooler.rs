use super::page::Picture;
use super::{
    Capabilities, Colour, Connection, Error, Job, JobState, JobStatus, Margins, Media, MediaType,
    Printer, Profile, ProfileSource, Result, Space, Transport, fail, printer_id,
};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;
use windows::Win32::Foundation::{E_NOTIMPL, ERROR_INVALID_PARAMETER, RPC_E_CHANGED_MODE};
use windows::Win32::Graphics::Gdi::{
    CreateDCW, DEVMODEW, DEVMODEW_0_0, DM_COLOR, DM_COPIES, DM_IN_BUFFER, DM_MEDIATYPE,
    DM_ORIENTATION, DM_OUT_BUFFER, DM_PAPERSIZE, DM_PRINTQUALITY, DM_YRESOLUTION, DMCOLOR_COLOR,
    DMORIENT_LANDSCAPE, DMORIENT_PORTRAIT, DeleteDC, GET_DEVICE_CAPS_INDEX, GetDeviceCaps, HORZRES,
    LOGPIXELSX, LOGPIXELSY, PHYSICALHEIGHT, PHYSICALOFFSETX, PHYSICALOFFSETY, PHYSICALWIDTH,
    VERTRES,
};
use windows::Win32::Graphics::Printing::PrintTicket::{
    PTCloseProvider, PTConvertDevModeToPrintTicket, PTOpenProvider, kPTJobScope,
};
use windows::Win32::Graphics::Printing::{
    ClosePrinter, DocumentPropertiesW, EnumPrintersW, GetDefaultPrinterW, GetJobW, JOB_INFO_1W,
    JOB_STATUS_BLOCKED_DEVQ, JOB_STATUS_COMPLETE, JOB_STATUS_DELETED, JOB_STATUS_DELETING,
    JOB_STATUS_ERROR, JOB_STATUS_OFFLINE, JOB_STATUS_PAPEROUT, JOB_STATUS_PAUSED,
    JOB_STATUS_PRINTED, JOB_STATUS_PRINTING, JOB_STATUS_SPOOLING, JOB_STATUS_USER_INTERVENTION,
    OpenPrinterW, PRINTER_ENUM_CONNECTIONS, PRINTER_ENUM_LOCAL, PRINTER_HANDLE, PRINTER_INFO_2W,
};
use windows::Win32::Storage::Xps::Printing::{
    ID_DOCUMENTPACKAGETARGET_MSXPS, IPrintDocumentPackageStatusEvent, IPrintDocumentPackageTarget,
    IPrintDocumentPackageTargetFactory, PrintDocumentPackageTargetFactory,
};
use windows::Win32::Storage::Xps::{
    DC_COPIES, DC_ENUMRESOLUTIONS, DC_MEDIATYPENAMES, DC_MEDIATYPES, DC_PAPERNAMES, DC_PAPERS,
    DC_PAPERSIZE, DeviceCapabilitiesW, IXpsDocumentPackageTarget, IXpsOMBrush, IXpsOMVisual,
    PRINTER_DEVICE_CAPABILITIES, XPS_IMAGE_TYPE_PNG, XPS_POINT, XPS_RECT, XPS_SEGMENT_TYPE,
    XPS_SEGMENT_TYPE_LINE, XPS_SIZE,
};
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize,
    IConnectionPoint, IConnectionPointContainer, IStream, STREAM_SEEK_SET,
};
use windows::Win32::UI::ColorSystem::{
    ENUM_TYPE_VERSION, ENUMTYPEW, ET_DEVICECLASS, ET_DEVICENAME, EnumColorProfilesW,
    GetColorDirectoryW,
};
use windows::Win32::UI::Shell::SHCreateMemStream;
use windows::core::{BOOL, HSTRING, Interface, PCWSTR, PWSTR, w};

/// `'prtr'`, the ICC device class of a printer, which windows-rs does not name.
const CLASS_PRINTER: u32 = u32::from_be_bytes(*b"prtr");
const XPS_UNITS_PER_INCH: f32 = 96.0;
const MM_PER_INCH: f64 = 25.4;
const PAPER_NAME_CHARS: usize = 64;
/// Tenths of a millimetre within which two papers are the same size.
const SAME_SIZE: i32 = 10;
const JOB_NUMBER_TIMEOUT: Duration = Duration::from_secs(60);

pub struct Spooler;

impl Spooler {
    pub fn list(&self) -> Result<Vec<Printer>> {
        let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
        let (buffer, count) = filled(|buffer, needed| {
            let mut count = 0;
            #[expect(unsafe_code)]
            // SAFETY: `buffer` is writable for its length and `needed`/`count` are locals.
            let listed =
                unsafe { EnumPrintersW(flags, PCWSTR::null(), 2, buffer, needed, &mut count) };
            listed.map(|()| count)
        })
        .map_err(|error| Error(format!("Can't list the printers: {error}")))?;
        let default = default_printer();
        #[expect(unsafe_code)]
        // SAFETY: EnumPrintersW wrote `count` PRINTER_INFO_2W at the start of the buffer, which
        // is u64-aligned.
        let infos = unsafe {
            std::slice::from_raw_parts(buffer.as_ptr().cast::<PRINTER_INFO_2W>(), count as usize)
        };
        Ok(infos
            .iter()
            .filter_map(|info| {
                let name = text(info.pPrinterName)?;
                Some(Printer {
                    id: printer_id(&name),
                    is_default: default.as_deref() == Some(name.as_str()),
                    location: text(info.pLocation).filter(|location| !location.is_empty()),
                    model: text(info.pDriverName),
                    connection: connection(&name, &text(info.pPortName).unwrap_or_default()),
                    name,
                })
            })
            .collect())
    }

    pub fn capabilities(&self, name: &str) -> Result<Capabilities> {
        let device = HSTRING::from(name);
        let printer = PrinterHandle::open(&device)?;
        let defaults = DevMode::user_default(&printer, &device)?;
        let sizes = sizes(&device, &defaults);
        let media_types = media_types(&device);
        let default_paper = defaults.paper();
        let devmode = defaults.get();
        let default_media_type = (devmode.dmFields.0 & DM_MEDIATYPE.0 != 0)
            .then(|| devmode.dmMediaType.to_string())
            .filter(|key| media_types.iter().any(|media_type| &media_type.key == key));
        let mut resolutions: Vec<u32> = capability::<[i32; 2]>(&device, DC_ENUMRESOLUTIONS)
            .into_iter()
            .filter(|[x, y]| x == y && *x > 0)
            .map(|[x, _]| x as u32)
            .collect();
        resolutions.sort_unstable();
        resolutions.dedup();
        #[expect(unsafe_code)]
        // SAFETY: DC_COPIES writes nothing and returns the count.
        let copies = unsafe { DeviceCapabilitiesW(&device, PCWSTR::null(), DC_COPIES, None, None) };
        Ok(Capabilities {
            default_media: sizes
                .iter()
                .find(|size| size.holds(default_paper))
                .map(Size::key),
            media: sizes.iter().map(Size::media).collect(),
            media_types,
            default_media_type,
            resolutions_dpi: resolutions,
            copies_max: copies.max(1) as u32,
            colour: Colour {
                transports: [Space::AdobeRgb, Space::Srgb]
                    .map(|space| Transport { space, bits: 16 })
                    .to_vec(),
                profiles: colour_profiles(&device)
                    .into_iter()
                    .map(|name| Profile {
                        name,
                        source: ProfileSource::Driver,
                    })
                    .collect(),
            },
        })
    }

    pub fn profile(&self, name: &str, profile: &str) -> Result<Vec<u8>> {
        let device = HSTRING::from(name);
        if !colour_profiles(&device)
            .iter()
            .any(|listed| listed == profile)
        {
            return fail(format!("{name} has no colour profile called {profile}"));
        }
        let path = colour_directory()?.join(profile);
        std::fs::read(&path).map_err(|error| {
            Error(format!(
                "Can't read the profile at {}: {error}",
                path.display()
            ))
        })
    }

    pub fn submit(&self, name: &str, picture: Picture, job: &Job) -> Result<i32> {
        if job.transport.bits != 16 || job.transport.space == Space::Device {
            return fail(format!("{name} takes Adobe RGB or sRGB at 16 bits"));
        }
        let Some(icc) = picture.icc.as_deref() else {
            return fail("The image has no ICC profile to say what its colours are");
        };
        let device = HSTRING::from(name);
        let printer = PrinterHandle::open(&device)?;
        let mut devmode = DevMode::user_default(&printer, &device)?;
        let sizes = sizes(&device, &devmode);
        let Some(size) = sizes.iter().find(|size| size.key() == job.media) else {
            return fail(format!("{name} doesn't take paper {}", job.media));
        };
        let paper = if job.borderless {
            size.borderless_paper()
                .ok_or_else(|| Error(format!("{name} can't print {} borderless", size.main().1)))?
        } else {
            size.main().0
        };
        let media_type = job
            .media_type
            .as_deref()
            .map(|key| {
                key.parse::<u32>()
                    .map_err(|_| Error(format!("{name} has no media type {key}")))
            })
            .transpose()?;
        let dpi = i16::try_from(job.resolution_dpi)
            .map_err(|_| Error(format!("{} dpi is not a resolution", job.resolution_dpi)))?;
        let copies = i16::try_from(job.copies)
            .map_err(|_| Error(format!("{} copies is too many", job.copies)))?;
        {
            let printer_fields = devmode.printer();
            printer_fields.dmPaperSize = paper as i16;
            printer_fields.dmCopies = copies;
            printer_fields.dmPrintQuality = dpi;
            printer_fields.dmOrientation = if job.page.width_px > job.page.height_px {
                DMORIENT_LANDSCAPE
            } else {
                DMORIENT_PORTRAIT
            } as i16;
            let fields = devmode.get_mut();
            fields.dmYResolution = dpi;
            fields.dmColor = DMCOLOR_COLOR;
            fields.dmFields |= DM_PAPERSIZE
                | DM_COPIES
                | DM_PRINTQUALITY
                | DM_YRESOLUTION
                | DM_ORIENTATION
                | DM_COLOR;
            if let Some(media_type) = media_type {
                fields.dmMediaType = media_type;
                fields.dmFields |= DM_MEDIATYPE;
            }
        }
        let devmode = devmode.merged(&printer, &device)?;

        let _com = Com::init()?;
        let ticket = print_ticket(&device, &devmode)?;
        let windows_error = |what: &str| {
            let what = what.to_string();
            move |error: windows::core::Error| Error(format!("{what}: {error}"))
        };
        #[expect(unsafe_code)]
        // SAFETY: COM is initialised on this thread for as long as `_com` lives, and every
        // interface below is dropped before it.
        let id = unsafe {
            let factory: IPrintDocumentPackageTargetFactory = CoCreateInstance(
                &PrintDocumentPackageTargetFactory,
                None,
                CLSCTX_INPROC_SERVER,
            )
            .map_err(windows_error("Can't reach the print spooler"))?;
            let target = factory
                .CreateDocumentPackageTargetForPrintJob(
                    &device,
                    &HSTRING::from(job.name.as_str()),
                    None::<&IStream>,
                    &ticket,
                )
                .map_err(windows_error("The spooler refused the job"))?;
            let status = JobNumber::watch(&target)?;
            write_page(&target, &picture.path, picture.pixels_per_metre, icc, job)
                .map_err(windows_error("Can't send the page to the spooler"))?;
            status.wait()?
        };
        i32::try_from(id).map_err(|_| Error(format!("The spooler numbered the job {id}")))
    }

    pub fn job(&self, name: &str, job_id: i32) -> Result<JobStatus> {
        let device = HSTRING::from(name);
        let printer = PrinterHandle::open(&device)?;
        let Ok(job_id) = u32::try_from(job_id) else {
            return fail(format!("{job_id} is not a job number"));
        };
        let found = filled(|buffer, needed| {
            #[expect(unsafe_code)]
            // SAFETY: `buffer` is writable for its length and `needed` is a local.
            let got = unsafe { GetJobW(printer.0, job_id, 1, buffer, needed) };
            got.ok().map(|()| 1u32)
        });
        let buffer = match found {
            Ok((buffer, _)) => buffer,
            // The spooler forgets a job once it has printed.
            Err(error) if error.code() == ERROR_INVALID_PARAMETER.to_hresult() => {
                return Ok(JobStatus {
                    state: JobState::Completed,
                    reasons: Vec::new(),
                });
            }
            Err(error) => return fail(format!("Can't read job {job_id} on {name}: {error}")),
        };
        #[expect(unsafe_code)]
        // SAFETY: GetJobW wrote a JOB_INFO_1W at the start of the u64-aligned buffer.
        let status = unsafe { &*buffer.as_ptr().cast::<JOB_INFO_1W>() }.Status;
        Ok(job_status(status))
    }
}

fn job_status(status: u32) -> JobStatus {
    let has = |flag: u32| status & flag != 0;
    let state = if has(JOB_STATUS_PRINTED | JOB_STATUS_COMPLETE) {
        JobState::Completed
    } else if has(JOB_STATUS_DELETING | JOB_STATUS_DELETED) {
        JobState::Canceled
    } else if has(JOB_STATUS_ERROR
        | JOB_STATUS_OFFLINE
        | JOB_STATUS_PAPEROUT
        | JOB_STATUS_BLOCKED_DEVQ
        | JOB_STATUS_USER_INTERVENTION)
    {
        JobState::Stopped
    } else if has(JOB_STATUS_PAUSED) {
        JobState::Held
    } else if has(JOB_STATUS_PRINTING | JOB_STATUS_SPOOLING) {
        JobState::Processing
    } else {
        JobState::Pending
    };
    let reasons = [
        (JOB_STATUS_PAPEROUT, "media-empty"),
        (JOB_STATUS_OFFLINE, "offline"),
        (
            JOB_STATUS_ERROR | JOB_STATUS_USER_INTERVENTION,
            "printer-stopped",
        ),
    ]
    .into_iter()
    .filter(|(flag, _)| has(*flag))
    .map(|(_, reason)| reason.to_string())
    .collect();
    JobStatus { state, reasons }
}

fn connection(printer: &str, port: &str) -> Connection {
    let port = port.to_ascii_uppercase();
    if port.starts_with("USB") || port.starts_with("DOT4") {
        return Connection::Usb;
    }
    let networked = printer.starts_with("\\\\")
        || port.starts_with("\\\\")
        || ["WSD", "IP_", "HTTP", "IPP"]
            .iter()
            .any(|prefix| port.starts_with(prefix))
        || port.contains("TCP")
        || port.parse::<std::net::IpAddr>().is_ok();
    if networked {
        Connection::Network
    } else {
        Connection::Unknown
    }
}

/// One paper size, as the driver's papers of that size: a size can be listed twice, once
/// bordered and once named borderless.
struct Size {
    /// Tenths of a millimetre.
    width: i32,
    height: i32,
    bordered: Vec<(u16, String)>,
    borderless: Vec<(u16, String)>,
    margins: [f64; 4],
    zero_margins: bool,
}

impl Size {
    fn main(&self) -> &(u16, String) {
        self.bordered
            .first()
            .or(self.borderless.first())
            .expect("a size holds a paper")
    }

    fn key(&self) -> String {
        self.main().0.to_string()
    }

    fn borderless_paper(&self) -> Option<u16> {
        self.borderless
            .first()
            .map(|(paper, _)| *paper)
            .or(self.zero_margins.then(|| self.main().0))
    }

    fn holds(&self, paper: u16) -> bool {
        self.bordered
            .iter()
            .chain(&self.borderless)
            .any(|(held, _)| *held == paper)
    }

    fn media(&self) -> Media {
        Media {
            key: self.key(),
            name: Some(self.main().1.clone()),
            width_mm: self.width as f64 / 10.0,
            height_mm: self.height as f64 / 10.0,
            margins: Margins {
                top: self.margins[0],
                right: self.margins[1],
                bottom: self.margins[2],
                left: self.margins[3],
            },
            borderless: self.borderless_paper().is_some(),
        }
    }
}

fn sizes(device: &HSTRING, defaults: &DevMode) -> Vec<Size> {
    let papers = capability::<u16>(device, DC_PAPERS);
    let names = capability::<[u16; PAPER_NAME_CHARS]>(device, DC_PAPERNAMES);
    let dimensions = capability::<[i32; 2]>(device, DC_PAPERSIZE);
    let mut sizes: Vec<Size> = Vec::new();
    for ((&paper, name), &[width, height]) in papers.iter().zip(&names).zip(&dimensions) {
        let name = fixed_text(name);
        let index = sizes
            .iter()
            .position(|size| {
                (size.width - width).abs() <= SAME_SIZE && (size.height - height).abs() <= SAME_SIZE
            })
            .unwrap_or_else(|| {
                sizes.push(Size {
                    width,
                    height,
                    bordered: Vec::new(),
                    borderless: Vec::new(),
                    margins: [0.0; 4],
                    zero_margins: false,
                });
                sizes.len() - 1
            });
        let size = &mut sizes[index];
        if name.to_ascii_lowercase().contains("borderless") {
            size.borderless.push((paper, name));
        } else {
            size.bordered.push((paper, name));
        }
    }
    for size in &mut sizes {
        if let Some(margins) = paper_margins(device, defaults, size.main().0) {
            size.margins = margins;
            size.zero_margins = margins.iter().all(|&margin| margin < 0.05);
        }
    }
    sizes
}

/// Top, right, bottom and left, in millimetres: where the driver's DC for `paper` cannot print.
fn paper_margins(device: &HSTRING, defaults: &DevMode, paper: u16) -> Option<[f64; 4]> {
    let mut devmode = defaults.clone();
    devmode.printer().dmPaperSize = paper as i16;
    devmode.printer().dmOrientation = DMORIENT_PORTRAIT as i16;
    devmode.get_mut().dmFields |= DM_PAPERSIZE | DM_ORIENTATION;
    #[expect(unsafe_code)]
    // SAFETY: the DEVMODE is a whole driver-sized buffer, and the DC is deleted before return.
    unsafe {
        let dc = CreateDCW(w!("WINSPOOL"), device, PCWSTR::null(), Some(devmode.get()));
        if dc.is_invalid() {
            return None;
        }
        let caps = |index: GET_DEVICE_CAPS_INDEX| GetDeviceCaps(Some(dc), index) as f64;
        let (dpi_x, dpi_y) = (caps(LOGPIXELSX), caps(LOGPIXELSY));
        let (left, top) = (caps(PHYSICALOFFSETX), caps(PHYSICALOFFSETY));
        let right = caps(PHYSICALWIDTH) - caps(HORZRES) - left;
        let bottom = caps(PHYSICALHEIGHT) - caps(VERTRES) - top;
        let _ = DeleteDC(dc);
        if dpi_x <= 0.0 || dpi_y <= 0.0 {
            return None;
        }
        let mm = |dots: f64, dpi: f64| (dots.max(0.0) / dpi * MM_PER_INCH * 100.0).round() / 100.0;
        Some([
            mm(top, dpi_y),
            mm(right, dpi_x),
            mm(bottom, dpi_y),
            mm(left, dpi_x),
        ])
    }
}

fn media_types(device: &HSTRING) -> Vec<MediaType> {
    let ids = capability::<u32>(device, DC_MEDIATYPES);
    let names = capability::<[u16; PAPER_NAME_CHARS]>(device, DC_MEDIATYPENAMES);
    ids.iter()
        .zip(
            names
                .iter()
                .map(|name| Some(fixed_text(name)))
                .chain(std::iter::repeat(None)),
        )
        .map(|(id, name)| MediaType {
            key: id.to_string(),
            name,
        })
        .collect()
}

fn capability<T: bytemuck::Pod>(
    device: &HSTRING,
    capability: PRINTER_DEVICE_CAPABILITIES,
) -> Vec<T> {
    #[expect(unsafe_code)]
    // SAFETY: with no output buffer the call only counts.
    let count = unsafe { DeviceCapabilitiesW(device, PCWSTR::null(), capability, None, None) };
    if count <= 0 {
        return Vec::new();
    }
    let mut entries = vec![T::zeroed(); count as usize];
    #[expect(unsafe_code)]
    // SAFETY: `entries` holds `count` entries of the size this capability writes.
    let written = unsafe {
        DeviceCapabilitiesW(
            device,
            PCWSTR::null(),
            capability,
            Some(PWSTR(entries.as_mut_ptr().cast())),
            None,
        )
    };
    entries.truncate(written.max(0) as usize);
    entries
}

fn fixed_text(wide: &[u16]) -> String {
    let end = wide
        .iter()
        .position(|&unit| unit == 0)
        .unwrap_or(wide.len());
    String::from_utf16_lossy(&wide[..end])
}

fn text(wide: PWSTR) -> Option<String> {
    if wide.is_null() {
        return None;
    }
    #[expect(unsafe_code)]
    // SAFETY: the spooler's strings are NUL-terminated and live as long as their buffer.
    unsafe { wide.to_string() }.ok()
}

fn default_printer() -> Option<String> {
    let mut length = 0u32;
    #[expect(unsafe_code)]
    // SAFETY: with no buffer the call only reports the length.
    let _ = unsafe { GetDefaultPrinterW(None, &mut length) };
    if length == 0 {
        return None;
    }
    let mut name = vec![0u16; length as usize];
    #[expect(unsafe_code)]
    // SAFETY: `name` holds `length` characters.
    let found = unsafe { GetDefaultPrinterW(Some(PWSTR(name.as_mut_ptr())), &mut length) };
    found.as_bool().then(|| fixed_text(&name))
}

/// The ICC profiles associated with the printer, by file name in the colour directory.
fn colour_profiles(device: &HSTRING) -> Vec<String> {
    let record = ENUMTYPEW {
        dwSize: std::mem::size_of::<ENUMTYPEW>() as u32,
        dwVersion: ENUM_TYPE_VERSION,
        dwFields: ET_DEVICENAME | ET_DEVICECLASS,
        pDeviceName: PCWSTR(device.as_ptr()),
        dwDeviceClass: CLASS_PRINTER,
        ..Default::default()
    };
    let mut size = 0u32;
    #[expect(unsafe_code)]
    // SAFETY: with no buffer the call only reports the size.
    let _ = unsafe { EnumColorProfilesW(PCWSTR::null(), &record, None, &mut size, None) };
    if size == 0 {
        return Vec::new();
    }
    let mut names = vec![0u16; (size as usize).div_ceil(2)];
    let mut count = 0u32;
    #[expect(unsafe_code)]
    // SAFETY: `names` holds `size` bytes.
    let listed = unsafe {
        EnumColorProfilesW(
            PCWSTR::null(),
            &record,
            Some(names.as_mut_ptr().cast()),
            &mut size,
            Some(&mut count),
        )
    };
    if !listed.as_bool() {
        return Vec::new();
    }
    names
        .split(|&unit| unit == 0)
        .filter(|name| !name.is_empty())
        .take(count as usize)
        .map(String::from_utf16_lossy)
        .collect()
}

fn colour_directory() -> Result<std::path::PathBuf> {
    let mut size = 0u32;
    #[expect(unsafe_code)]
    // SAFETY: with no buffer the call only reports the size in bytes.
    let _ = unsafe { GetColorDirectoryW(PCWSTR::null(), None, &mut size) };
    let mut directory = vec![0u16; (size as usize).div_ceil(2).max(1)];
    #[expect(unsafe_code)]
    // SAFETY: `directory` holds `size` bytes.
    let found = unsafe {
        GetColorDirectoryW(
            PCWSTR::null(),
            Some(PWSTR(directory.as_mut_ptr())),
            &mut size,
        )
    };
    if !found.as_bool() {
        return fail("Can't find Windows' colour profile folder");
    }
    Ok(fixed_text(&directory).into())
}

/// Calls `fill` once to learn the size and once to fill a u64-aligned buffer of it, returning the
/// buffer and what the second call returned.
fn filled(
    mut fill: impl FnMut(Option<&mut [u8]>, &mut u32) -> windows::core::Result<u32>,
) -> windows::core::Result<(Vec<u64>, u32)> {
    let mut needed = 0u32;
    let _ = fill(None, &mut needed);
    let mut buffer = vec![0u64; (needed as usize).div_ceil(8).max(1)];
    let returned = fill(Some(bytemuck::cast_slice_mut(&mut buffer)), &mut needed)?;
    Ok((buffer, returned))
}

struct PrinterHandle(PRINTER_HANDLE);

impl PrinterHandle {
    fn open(device: &HSTRING) -> Result<PrinterHandle> {
        let mut handle = PRINTER_HANDLE::default();
        #[expect(unsafe_code)]
        // SAFETY: `handle` is a local the call writes.
        let opened = unsafe { OpenPrinterW(device, &mut handle, None) };
        opened.map_err(|error| Error(format!("Can't open the printer {device}: {error}")))?;
        Ok(PrinterHandle(handle))
    }
}

impl Drop for PrinterHandle {
    fn drop(&mut self) {
        #[expect(unsafe_code)]
        // SAFETY: opened by `open` and closed once.
        let _ = unsafe { ClosePrinter(self.0) };
    }
}

/// The driver's private bytes follow the public DEVMODEW fields; a copy of the struct alone
/// loses the driver's settings.
#[derive(Clone)]
struct DevMode {
    buffer: Vec<u64>,
    length: usize,
}

impl DevMode {
    /// The user's own defaults, which their printing preferences set.
    fn user_default(printer: &PrinterHandle, device: &HSTRING) -> Result<DevMode> {
        Self::properties(printer, device, None)
    }

    fn merged(&self, printer: &PrinterHandle, device: &HSTRING) -> Result<DevMode> {
        Self::properties(printer, device, Some(self))
    }

    fn properties(
        printer: &PrinterHandle,
        device: &HSTRING,
        input: Option<&DevMode>,
    ) -> Result<DevMode> {
        #[expect(unsafe_code)]
        // SAFETY: with no buffers the call only reports the size.
        let length = unsafe { DocumentPropertiesW(None, printer.0, device, None, None, 0) };
        if length <= 0 {
            return fail(format!("Can't read the settings of {device}"));
        }
        let length = length as usize;
        let mut buffer = vec![0u64; length.div_ceil(8)];
        let mode = DM_OUT_BUFFER.0 | input.map_or(0, |_| DM_IN_BUFFER.0);
        #[expect(unsafe_code)]
        // SAFETY: `buffer` holds the `length` bytes the driver asked for, and `input` is a whole
        // DEVMODE of the same driver.
        let done = unsafe {
            DocumentPropertiesW(
                None,
                printer.0,
                device,
                Some(buffer.as_mut_ptr().cast()),
                input.map(|input| input.get() as *const DEVMODEW),
                mode,
            )
        };
        if done < 0 {
            return fail(format!("{device} refused the print settings"));
        }
        Ok(DevMode { buffer, length })
    }

    fn get(&self) -> &DEVMODEW {
        #[expect(unsafe_code)]
        // SAFETY: the buffer is u64-aligned, at least a DEVMODEW long, and holds one the driver
        // wrote.
        unsafe {
            &*self.buffer.as_ptr().cast::<DEVMODEW>()
        }
    }

    fn get_mut(&mut self) -> &mut DEVMODEW {
        #[expect(unsafe_code)]
        // SAFETY: as `get`.
        unsafe {
            &mut *self.buffer.as_mut_ptr().cast::<DEVMODEW>()
        }
    }

    /// The printer arm of the DEVMODE's first union, which a printer's DEVMODE always uses.
    fn printer(&mut self) -> &mut DEVMODEW_0_0 {
        #[expect(unsafe_code)]
        // SAFETY: a printer's DEVMODE uses the printer arm.
        unsafe {
            &mut self.get_mut().Anonymous1.Anonymous1
        }
    }

    fn paper(&self) -> u16 {
        #[expect(unsafe_code)]
        // SAFETY: as `printer`.
        let paper = unsafe { self.get().Anonymous1.Anonymous1.dmPaperSize };
        paper as u16
    }
}

fn print_ticket(device: &HSTRING, devmode: &DevMode) -> Result<IStream> {
    let failed = |error: windows::core::Error| {
        Error(format!(
            "Can't turn the print settings into a print ticket: {error}"
        ))
    };
    #[expect(unsafe_code)]
    // SAFETY: the provider is closed before return, and the DEVMODE is a whole driver buffer of
    // `length` bytes. PTConvertDevModeToPrintTicket takes the Unicode DEVMODE; its binding names
    // the ANSI one.
    unsafe {
        let provider = PTOpenProvider(device, 1).map_err(failed)?;
        let stream = SHCreateMemStream(None);
        let converted = match &stream {
            Some(stream) => PTConvertDevModeToPrintTicket(
                provider,
                devmode.length as u32,
                (devmode.get() as *const DEVMODEW).cast(),
                kPTJobScope,
                stream,
            ),
            None => Err(windows::core::Error::from(E_NOTIMPL)),
        };
        let _ = PTCloseProvider(provider);
        converted.map_err(failed)?;
        let stream = stream.expect("converted into it");
        stream.Seek(0, STREAM_SEEK_SET, None).map_err(failed)?;
        Ok(stream)
    }
}

#[expect(unsafe_code)]
unsafe fn write_page(
    target: &IPrintDocumentPackageTarget,
    image: &std::path::Path,
    pixels_per_metre: Option<(u32, u32)>,
    icc: &[u8],
    job: &Job,
) -> windows::core::Result<()> {
    // SAFETY: the caller holds COM initialised; every call is a COM method on a live interface.
    unsafe {
        let package: IXpsDocumentPackageTarget =
            target.GetPackageTarget(&ID_DOCUMENTPACKAGETARGET_MSXPS)?;
        let om = package.GetXpsOMFactory()?;
        let part = |uri: PCWSTR| om.CreatePartUri(uri);
        let writer = package.GetXpsOMPackageWriter(
            &part(w!("/FixedDocumentSequence.fdseq"))?,
            &part(w!("/DiscardControl.xml"))?,
        )?;
        writer.StartNewDocument(
            &part(w!("/Documents/1/FixedDocument.fdoc"))?,
            None,
            None,
            None,
            None,
        )?;

        let units = |pixels: u32| pixels as f32 * XPS_UNITS_PER_INCH / job.resolution_dpi as f32;
        let size = XPS_SIZE {
            width: units(job.page.width_px),
            height: units(job.page.height_px),
        };
        let page = om.CreatePage(&size, w!("en-US"), &part(w!("/Documents/1/Pages/1.fpage"))?)?;
        let picture = om.CreateImageResource(
            &om.CreateReadOnlyStreamOnFile(&HSTRING::from(image.as_os_str()))?,
            XPS_IMAGE_TYPE_PNG,
            &part(w!("/Resources/Images/1.png"))?,
        )?;
        // An image's own units are 1/96 inch at its stated density, 96 dpi where it states none.
        let image_units = |pixels: u32, per_metre: Option<u32>| match per_metre {
            Some(per_metre) => pixels as f32 * XPS_UNITS_PER_INCH / (per_metre as f32 * 0.0254),
            None => pixels as f32,
        };
        let viewbox = XPS_RECT {
            x: 0.0,
            y: 0.0,
            width: image_units(job.place.width, pixels_per_metre.map(|(x, _)| x)),
            height: image_units(job.place.height, pixels_per_metre.map(|(_, y)| y)),
        };
        let place = XPS_RECT {
            x: units(job.place.x),
            y: units(job.place.y),
            width: units(job.place.width),
            height: units(job.place.height),
        };
        let brush = om.CreateImageBrush(&picture, &viewbox, &place)?;
        let profile = om.CreateColorProfileResource(
            &SHCreateMemStream(Some(icc)).ok_or_else(|| windows::core::Error::from(E_NOTIMPL))?,
            &part(w!("/Resources/Profiles/1.icc"))?,
        )?;
        brush.SetColorProfileResource(&profile)?;

        let figure = om.CreateGeometryFigure(&XPS_POINT {
            x: place.x,
            y: place.y,
        })?;
        let corners = [
            place.x + place.width,
            place.y,
            place.x + place.width,
            place.y + place.height,
            place.x,
            place.y + place.height,
        ];
        let lines: [XPS_SEGMENT_TYPE; 3] = [XPS_SEGMENT_TYPE_LINE; 3];
        let strokes = [BOOL(0); 3];
        figure.SetSegments(3, 6, lines.as_ptr(), corners.as_ptr(), strokes.as_ptr())?;
        figure.SetIsClosed(true)?;
        figure.SetIsFilled(true)?;
        let geometry = om.CreateGeometry()?;
        geometry.GetFigures()?.Append(&figure)?;
        let path = om.CreatePath()?;
        path.SetGeometryLocal(&geometry)?;
        path.SetFillBrushLocal(&brush.cast::<IXpsOMBrush>()?)?;
        page.GetVisuals()?.Append(&path.cast::<IXpsOMVisual>()?)?;

        writer.AddPage(&page, &size, None, None, None, None)?;
        writer.Close()
    }
}

struct Com {
    initialised: bool,
}

impl Com {
    fn init() -> Result<Com> {
        #[expect(unsafe_code)]
        // SAFETY: balanced by `Drop` on this thread.
        let result = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if result == RPC_E_CHANGED_MODE {
            return Ok(Com { initialised: false });
        }
        result
            .ok()
            .map_err(|error| Error(format!("Can't start COM: {error}")))?;
        Ok(Com { initialised: true })
    }
}

impl Drop for Com {
    fn drop(&mut self) {
        if self.initialised {
            #[expect(unsafe_code)]
            // SAFETY: `init` initialised COM on this thread.
            unsafe {
                CoUninitialize()
            };
        }
    }
}

/// The spooler's job number, which arrives in a package status event once the job exists.
struct JobNumber {
    seen: status_sink::Outcome,
    point: IConnectionPoint,
    cookie: u32,
}

impl JobNumber {
    #[expect(unsafe_code)]
    unsafe fn watch(target: &IPrintDocumentPackageTarget) -> Result<JobNumber> {
        let seen: status_sink::Outcome = Arc::new((Mutex::new(None), Condvar::new()));
        let sink: IPrintDocumentPackageStatusEvent = status_sink::StatusSink(seen.clone()).into();
        let failed = |error: windows::core::Error| Error(format!("Can't follow the job: {error}"));
        // SAFETY: COM methods on live interfaces, on a thread the caller initialised.
        let (point, cookie) = unsafe {
            let container: IConnectionPointContainer = target.cast().map_err(failed)?;
            let point = container
                .FindConnectionPoint(&IPrintDocumentPackageStatusEvent::IID)
                .map_err(failed)?;
            let cookie = point.Advise(&sink).map_err(failed)?;
            (point, cookie)
        };
        Ok(JobNumber {
            seen,
            point,
            cookie,
        })
    }

    fn wait(self) -> Result<u32> {
        let (lock, arrived) = &*self.seen;
        let held = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let (held, _) = arrived
            .wait_timeout_while(held, JOB_NUMBER_TIMEOUT, |outcome| outcome.is_none())
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match *held {
            Some(Ok(id)) => Ok(id),
            Some(Err(status)) => fail(format!(
                "The spooler couldn't print the job: {}",
                windows::core::Error::from(status)
            )),
            None => fail("The spooler took the job but never numbered it"),
        }
    }
}

impl Drop for JobNumber {
    fn drop(&mut self) {
        #[expect(unsafe_code)]
        // SAFETY: the cookie came from this connection point's `Advise`.
        let _ = unsafe { self.point.Unadvise(self.cookie) };
    }
}

/// `#[implement]` generates the COM object's unsafe glue, which no statement-level marker can
/// reach, so the exemption covers this module the way it covers bindgen's.
mod status_sink {
    #![expect(unsafe_code)]

    use super::{Arc, Condvar, Mutex};
    use windows::Win32::Foundation::E_NOTIMPL;
    use windows::Win32::Storage::Xps::Printing::{
        IPrintDocumentPackageStatusEvent, IPrintDocumentPackageStatusEvent_Impl,
        PrintDocumentPackageCompletion_Canceled, PrintDocumentPackageCompletion_Failed,
        PrintDocumentPackageStatus,
    };
    use windows::Win32::System::Com::{
        DISPATCH_FLAGS, DISPPARAMS, EXCEPINFO, IDispatch_Impl, ITypeInfo,
    };
    use windows::Win32::System::Variant::VARIANT;
    use windows::core::{GUID, HRESULT, PCWSTR, Result, implement};

    /// The job's number once the spooler has one, or why the package failed before it did.
    pub type Outcome = Arc<(Mutex<Option<std::result::Result<u32, HRESULT>>>, Condvar)>;

    #[implement(IPrintDocumentPackageStatusEvent)]
    pub struct StatusSink(pub Outcome);

    impl IPrintDocumentPackageStatusEvent_Impl for StatusSink_Impl {
        fn PackageStatusUpdated(&self, status: *const PrintDocumentPackageStatus) -> Result<()> {
            // SAFETY: the spooler passes a status that lives for the call.
            let Some(status) = (unsafe { status.as_ref() }) else {
                return Ok(());
            };
            let failed = status.Completion == PrintDocumentPackageCompletion_Failed
                || status.Completion == PrintDocumentPackageCompletion_Canceled;
            let outcome = match (status.JobId, failed) {
                (0, false) => return Ok(()),
                (id, false) => Ok(id),
                (_, true) => Err(status.PackageStatus),
            };
            let (lock, arrived) = &*self.0;
            let mut held = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if held.is_none() {
                *held = Some(outcome);
                arrived.notify_all();
            }
            Ok(())
        }
    }

    impl IDispatch_Impl for StatusSink_Impl {
        fn GetTypeInfoCount(&self) -> Result<u32> {
            Err(E_NOTIMPL.into())
        }

        fn GetTypeInfo(&self, _: u32, _: u32) -> Result<ITypeInfo> {
            Err(E_NOTIMPL.into())
        }

        fn GetIDsOfNames(
            &self,
            _: *const GUID,
            _: *const PCWSTR,
            _: u32,
            _: u32,
            _: *mut i32,
        ) -> Result<()> {
            Err(E_NOTIMPL.into())
        }

        fn Invoke(
            &self,
            _: i32,
            _: *const GUID,
            _: u32,
            _: DISPATCH_FLAGS,
            _: *const DISPPARAMS,
            _: *mut VARIANT,
            _: *mut EXCEPINFO,
            _: *mut u32,
        ) -> Result<()> {
            Err(E_NOTIMPL.into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ports_say_how_the_printer_is_connected() {
        assert_eq!(connection("Canon PRO-200S", "USB001"), Connection::Usb);
        assert_eq!(connection("Epson", "WSD-6a1c-4b8e"), Connection::Network);
        assert_eq!(connection("Epson", "192.168.1.20"), Connection::Network);
        assert_eq!(connection("Epson", "IP_192.168.1.20"), Connection::Network);
        assert_eq!(
            connection("\\\\server\\Epson", "Ne01:"),
            Connection::Network
        );
        assert_eq!(
            connection("Microsoft Print to PDF", "PORTPROMPT:"),
            Connection::Unknown
        );
    }

    #[test]
    fn job_status_bits_map_to_ipp_states() {
        assert_eq!(job_status(0).state, JobState::Pending);
        assert_eq!(job_status(JOB_STATUS_SPOOLING).state, JobState::Processing);
        assert_eq!(job_status(JOB_STATUS_PAUSED).state, JobState::Held);
        let out = job_status(JOB_STATUS_PRINTING | JOB_STATUS_PAPEROUT);
        assert_eq!(out.state, JobState::Stopped);
        assert_eq!(out.reasons, vec!["media-empty".to_string()]);
        assert_eq!(
            job_status(JOB_STATUS_PRINTED | JOB_STATUS_DELETING).state,
            JobState::Completed
        );
    }
}
