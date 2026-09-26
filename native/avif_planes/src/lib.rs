//! An AVIF's picture as planar samples, for a browser with no `ImageDecoder` to hand them over.
//!
//! Safari has no `ImageDecoder`, and everything else it offers flattens an HDR picture to SDR
//! before a canvas sees it. So this is rav1d, built for `wasm32-wasip1-threads` and threaded
//! through a pool of the page's workers (`web/src/avif/`), and what it hands back is what
//! `VideoFrame.copyTo` hands back where there is one: the planes, laid out as rawshim's
//! `planes::Layout` reads them. The viewer's planar draw and the editor's `hold_planes` then take
//! either without knowing which decoded it.
//!
//! Planar PQ only, like the draw: anything else is declined, and the caller decodes it the way it
//! would have anyway.

use rav1d::include::dav1d::data::Dav1dData;
use rav1d::include::dav1d::dav1d::{Dav1dContext, Dav1dSettings};
use rav1d::include::dav1d::headers::{DAV1D_PIXEL_LAYOUT_I420, DAV1D_PIXEL_LAYOUT_I444};
use rav1d::include::dav1d::picture::Dav1dPicture;
use rav1d::src::lib::{
    dav1d_close, dav1d_data_create, dav1d_data_unref, dav1d_default_settings, dav1d_flush,
    dav1d_get_picture, dav1d_open, dav1d_picture_unref, dav1d_send_data,
};
use std::cell::RefCell;
use std::mem::MaybeUninit;
use std::ptr::NonNull;

/// Three planes of samples, luma then the two chroma, one after another with every row packed.
pub struct Planes {
    pub width: usize,
    pub height: usize,
    pub bits: u32,
    pub subsampled: bool,
    pub samples: Vec<u16>,
}

impl Planes {
    /// Each plane's first sample and its row length, in samples.
    pub fn layout(&self) -> [(usize, usize); 3] {
        let (chroma_width, chroma_height) = chroma_size(self.width, self.height, self.subsampled);
        let luma = self.width * self.height;
        [(0, self.width), (luma, chroma_width), (luma + chroma_width * chroma_height, chroma_width)]
    }
}

pub enum Decoded {
    Planes(Planes),
    /// A picture the planar draw does not read, and why.
    Declined(String),
}

/// The file's primary picture - an ISO 21496-1 file's HDR base - decoded on `threads` threads.
pub fn decode(bytes: &[u8], threads: u32) -> Result<Decoded, String> {
    let file = heif::read(bytes)?;
    let picture = file.primary;
    if picture.codec != heif::Codec::Av1 {
        return Ok(Decoded::Declined("this HEIF is HEVC, not AV1".to_string()));
    }
    match picture.nclx {
        Some(nclx) if nclx.transfer == TRANSFER_PQ && !nclx.full_range => {}
        _ => return Ok(Decoded::Declined("this AVIF is not limited-range PQ".to_string())),
    }
    DECODER.with_borrow_mut(|held| {
        if held.as_ref().is_none_or(|it| it.threads != threads) {
            // Closed before the next opens: each keeps its threads for as long as it lives, and
            // the page's pool is sized for one.
            *held = None;
            *held = Some(Decoder::open(threads)?);
        }
        let decoder = held.as_mut().expect("opened above");
        assembled(decoder, &picture)
    })
}

const TRANSFER_PQ: u16 = 16;

thread_local! {
    static DECODER: RefCell<Option<Decoder>> = const { RefCell::new(None) };
}

/// A grid's tiles decoded into one raster, cropped to the size the grid declares.
fn assembled(decoder: &mut Decoder, picture: &heif::Picture) -> Result<Decoded, String> {
    let (columns, _) = picture.grid;
    let mut out: Option<Planes> = None;
    for (at, tile) in picture.tiles.iter().enumerate() {
        let origin = ((at % columns) * picture.tile.0, (at / columns) * picture.tile.1);
        let declined = decoder.decode(tile, |decoded| {
            let p = &decoded.p;
            let subsampled = match p.layout {
                DAV1D_PIXEL_LAYOUT_I420 => true,
                DAV1D_PIXEL_LAYOUT_I444 => false,
                _ => return Some("this AVIF is neither 4:2:0 nor 4:4:4".to_string()),
            };
            if p.bpc != 10 && p.bpc != 12 {
                return Some(format!("this AVIF is {}-bit", p.bpc));
            }
            let planes = out.get_or_insert_with(|| {
                let (chroma_width, chroma_height) =
                    chroma_size(picture.width, picture.height, subsampled);
                Planes {
                    width: picture.width,
                    height: picture.height,
                    bits: p.bpc as u32,
                    subsampled,
                    samples: vec![0; picture.width * picture.height + 2 * chroma_width * chroma_height],
                }
            });
            let size = (p.w as usize, p.h as usize);
            if size != picture.tile || planes.subsampled != subsampled || planes.bits != p.bpc as u32 {
                return Some("this AVIF's grid tiles are not all alike".to_string());
            }
            if subsampled && (origin.0 % 2 == 1 || origin.1 % 2 == 1) {
                return Some("this AVIF's 4:2:0 grid starts a tile between two chroma samples".to_string());
            }
            // SAFETY: `decoded` is a live picture of `size` at more than eight bits, so each plane
            // is rows of `u16` at its stride.
            unsafe { place(planes, decoded, origin, size) };
            None
        })?;
        if let Some(why) = declined {
            return Ok(Decoded::Declined(why));
        }
    }
    out.map(Decoded::Planes).ok_or_else(|| "this AVIF has no tiles".to_string())
}

/// One decoded tile copied into the raster at `origin`, as much of it as falls inside.
///
/// # Safety
///
/// `decoded` holds `size` samples per plane (halved for 4:2:0 chroma) as `u16` rows at its strides.
unsafe fn place(planes: &mut Planes, decoded: &Dav1dPicture, origin: (usize, usize), size: (usize, usize)) {
    let shift = usize::from(planes.subsampled);
    let layout = planes.layout();
    let full = (planes.width, planes.height);
    for (plane, (first, row_length)) in layout.into_iter().enumerate() {
        let scale = if plane == 0 { 0 } else { shift };
        let (x0, y0) = (origin.0 >> scale, origin.1 >> scale);
        let (raster_width, raster_height) = if plane == 0 { full } else { chroma_size(full.0, full.1, planes.subsampled) };
        let (tile_width, tile_height) = ((size.0 + scale) >> scale, (size.1 + scale) >> scale);
        let columns = tile_width.min(raster_width.saturating_sub(x0));
        let rows = tile_height.min(raster_height.saturating_sub(y0));
        let Some(base) = decoded.data[plane] else { continue };
        let stride = decoded.stride[plane.min(1)];
        for row in 0..rows {
            // SAFETY: `row < tile_height` and `columns <= tile_width`, inside the plane.
            let source = unsafe {
                let start = base.as_ptr().cast::<u8>().offset(row as isize * stride).cast::<u16>();
                std::slice::from_raw_parts(start, columns)
            };
            let at = first + (y0 + row) * row_length + x0;
            planes.samples[at..at + columns].copy_from_slice(source);
        }
    }
}

fn chroma_size(width: usize, height: usize, subsampled: bool) -> (usize, usize) {
    match subsampled {
        true => (width.div_ceil(2), height.div_ceil(2)),
        false => (width, height),
    }
}

/// An open rav1d context, which keeps its threads between stills.
struct Decoder {
    context: Dav1dContext,
    threads: u32,
}

impl Decoder {
    fn open(threads: u32) -> Result<Decoder, String> {
        let mut settings = MaybeUninit::<Dav1dSettings>::zeroed();
        // SAFETY: `settings` is writable, and `dav1d_default_settings` initialises all of it.
        let mut settings = unsafe {
            dav1d_default_settings(NonNull::from(&mut settings).cast());
            settings.assume_init()
        };
        settings.n_threads = threads as i32;
        // One still at a time, so no frame is held back waiting for the next.
        settings.max_frame_delay = 1;
        let mut context: Option<Dav1dContext> = None;
        // SAFETY: both pointers are live for the call.
        let status = unsafe { dav1d_open(Some(NonNull::from(&mut context)), Some(NonNull::from(&mut settings))) };
        match context {
            Some(context) if status.0 == 0 => Ok(Decoder { context, threads }),
            _ => Err(format!("rav1d would not open on {threads} threads ({})", status.0)),
        }
    }

    /// One AV1 still, handed to `read` while it is decoded.
    fn decode<T>(&mut self, coded: &[u8], read: impl FnOnce(&Dav1dPicture) -> T) -> Result<T, String> {
        let eagain = -libc::EAGAIN;
        // SAFETY: every rav1d call gets the open context and pointers live for the call; `data`
        // is created at `coded`'s length and filled before it is sent, and unreferenced after.
        unsafe {
            let mut data = MaybeUninit::<Dav1dData>::zeroed().assume_init();
            let buffer = dav1d_data_create(Some(NonNull::from(&mut data)), coded.len());
            if buffer.is_null() {
                return Err("rav1d would not allocate the coded bytes".to_string());
            }
            std::ptr::copy_nonoverlapping(coded.as_ptr(), buffer, coded.len());
            let mut picture = MaybeUninit::<Dav1dPicture>::zeroed().assume_init();
            let mut status = eagain;
            for _ in 0..MAX_ATTEMPTS {
                if data.sz > 0 {
                    let sent = dav1d_send_data(Some(self.context.clone()), Some(NonNull::from(&mut data)));
                    if sent.0 < 0 && sent.0 != eagain {
                        status = sent.0;
                        break;
                    }
                }
                status = dav1d_get_picture(Some(self.context.clone()), Some(NonNull::from(&mut picture))).0;
                if status != eagain {
                    break;
                }
            }
            dav1d_data_unref(Some(NonNull::from(&mut data)));
            if status != 0 {
                dav1d_flush(self.context.clone());
                return Err(format!("rav1d could not decode this AVIF ({status})"));
            }
            let answer = read(&picture);
            dav1d_picture_unref(Some(NonNull::from(&mut picture)));
            dav1d_flush(self.context.clone());
            Ok(answer)
        }
    }
}

/// Send and receive rounds before a still that produces no picture is given up on.
const MAX_ATTEMPTS: usize = 64;

impl Drop for Decoder {
    fn drop(&mut self) {
        let mut context = Some(self.context.clone());
        // SAFETY: the context came from `dav1d_open` and is closed once, here.
        unsafe { dav1d_close(Some(NonNull::from(&mut context))) };
    }
}

/// The browser's entry points. The page reads what `avif_planes_decode` writes through `out`, then
/// calls `avif_planes_release`.
#[cfg(target_os = "wasi")]
mod exports {
    use super::{Decoded, decode};
    use std::cell::RefCell;

    thread_local! {
        static HELD: RefCell<(Vec<u16>, String)> = const { RefCell::new((Vec::new(), String::new())) };
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn avif_planes_alloc(len: usize) -> *mut u8 {
        let mut bytes = std::mem::ManuallyDrop::new(Vec::<u8>::with_capacity(len));
        bytes.as_mut_ptr()
    }

    /// # Safety
    ///
    /// `ptr` came from `avif_planes_alloc(len)` and is freed once.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn avif_planes_free(ptr: *mut u8, len: usize) {
        drop(unsafe { Vec::from_raw_parts(ptr, 0, len) });
    }

    /// Writes `ANSWER_WORDS` words to `out`: a status, a pointer and a length in bytes, then for
    /// status 0 the width, height, bits, whether 4:2:0, and each plane's offset and stride in
    /// bytes from the pointer. Status 1 is a picture declined and 2 a failure, with the reason at
    /// the pointer as UTF-8.
    ///
    /// # Safety
    ///
    /// `file` is `len` readable bytes and `out` `ANSWER_WORDS` writable words.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn avif_planes_decode(file: *const u8, len: usize, threads: u32, out: *mut u32) {
        let bytes = unsafe { std::slice::from_raw_parts(file, len) };
        let words = HELD.with_borrow_mut(|(samples, message)| {
            let mut words = [0u32; ANSWER_WORDS];
            match decode(bytes, threads) {
                Ok(Decoded::Planes(planes)) => {
                    let shape = [planes.width as u32, planes.height as u32, planes.bits, u32::from(planes.subsampled)];
                    let layout = planes.layout().map(|(first, row)| [first as u32 * 2, row as u32 * 2]);
                    *samples = planes.samples;
                    words[..3].copy_from_slice(&[0, samples.as_ptr() as u32, (samples.len() * 2) as u32]);
                    words[3..7].copy_from_slice(&shape);
                    words[7..].copy_from_slice(layout.as_flattened());
                }
                Ok(Decoded::Declined(why)) => {
                    *message = why;
                    words[..3].copy_from_slice(&[1, message.as_ptr() as u32, message.len() as u32]);
                }
                Err(why) => {
                    *message = why;
                    words[..3].copy_from_slice(&[2, message.as_ptr() as u32, message.len() as u32]);
                }
            }
            words
        });
        unsafe { std::ptr::copy_nonoverlapping(words.as_ptr(), out, words.len()) };
    }

    const ANSWER_WORDS: usize = 13;

    #[unsafe(no_mangle)]
    pub extern "C" fn avif_planes_release() {
        HELD.with_borrow_mut(|held| *held = (Vec::new(), String::new()));
    }
}
