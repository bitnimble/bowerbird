//! The editor's stage as a VP9 keyframe, for Firefox: its compositor shows HDR for video and
//! nothing else (DESIGN §21.2).
//!
//! libvpx, built for `wasm32-wasip1-threads` by `get:vpx` and threaded through a pool of the page's
//! workers (`web/src/wasi/`). A frame arrives as the planes `pq420.slang` writes
//! and leaves as one profile 2 keyframe, which `avif-hdr-video` wraps in an MP4. The encoder stays
//! open between frames of one size, since opening it is most of a small frame's cost.

#[allow(
    non_camel_case_types,
    non_snake_case,
    non_upper_case_globals,
    dead_code,
    unsafe_op_in_unsafe_fn
)]
mod vpx {
    include!(concat!(env!("OUT_DIR"), "/vpx.rs"));
}

use std::ffi::{CStr, c_int};
use std::mem::MaybeUninit;
use vpx::*;

/// libvpx's quality scale, 0 to 63.
const CQ_LEVEL: c_int = 4;
const CPU_USED: c_int = 9;
const TILE_COLUMNS_LOG2: c_int = 2;

/// Where a frame's planes are, in samples from the first: luma then the two chroma, each a row of
/// its stride after another.
pub struct Planes<'a> {
    pub samples: &'a [u16],
    pub width: u32,
    pub height: u32,
    pub luma_stride: u32,
    pub chroma_stride: u32,
    pub cb_offset: u32,
    pub cr_offset: u32,
}

struct Encoder {
    context: Box<vpx_codec_ctx_t>,
    width: u32,
    height: u32,
    threads: u32,
    frames: i64,
}

impl Encoder {
    fn open(width: u32, height: u32, threads: u32) -> Result<Encoder, String> {
        // SAFETY: the interface is a static libvpx owns; `config` is written whole by the default.
        let mut config = unsafe {
            let mut config = MaybeUninit::<vpx_codec_enc_cfg_t>::zeroed();
            checked(
                vpx_codec_enc_config_default(vpx_codec_vp9_cx(), config.as_mut_ptr(), 0),
                "libvpx has no VP9 defaults",
            )?;
            config.assume_init()
        };
        config.g_w = width;
        config.g_h = height;
        // 10-bit 4:2:0, which is what Firefox's compositor shows as HDR; 4:4:4 and 12-bit it
        // shows flat (DESIGN §10.7.2).
        config.g_profile = 2;
        config.g_bit_depth = vpx_bit_depth::VPX_BITS_10;
        config.g_input_bit_depth = 10;
        config.g_threads = threads;
        config.g_lag_in_frames = 0;
        config.g_pass = vpx_enc_pass::VPX_RC_ONE_PASS;
        config.rc_end_usage = vpx_rc_mode::VPX_Q;
        config.rc_min_quantizer = 0;
        config.rc_max_quantizer = 63;
        config.kf_max_dist = 0;

        // SAFETY: zeroed is how libvpx's own examples start a context, and init fills it.
        let mut context =
            Box::new(unsafe { MaybeUninit::<vpx_codec_ctx_t>::zeroed().assume_init() });
        // SAFETY: every pointer is live for the call.
        let opened = unsafe {
            vpx_codec_enc_init_ver(
                &mut *context,
                vpx_codec_vp9_cx(),
                &config,
                VPX_CODEC_USE_HIGHBITDEPTH as vpx_codec_flags_t,
                VPX_ENCODER_ABI_VERSION as c_int,
            )
        };
        checked(opened, "libvpx would not open a VP9 encoder")?;
        let mut encoder = Encoder {
            context,
            width,
            height,
            threads,
            frames: 0,
        };
        encoder.control(vp8e_enc_control_id::VP8E_SET_CPUUSED, CPU_USED)?;
        encoder.control(vp8e_enc_control_id::VP8E_SET_CQ_LEVEL, CQ_LEVEL)?;
        encoder.control(
            vp8e_enc_control_id::VP9E_SET_COLOR_SPACE,
            vpx_color_space::VPX_CS_BT_2020.0 as c_int,
        )?;
        encoder.control(
            vp8e_enc_control_id::VP9E_SET_COLOR_RANGE,
            vpx_color_range::VPX_CR_STUDIO_RANGE.0 as c_int,
        )?;
        encoder.control(
            vp8e_enc_control_id::VP9E_SET_TILE_COLUMNS,
            TILE_COLUMNS_LOG2,
        )?;
        encoder.control(vp8e_enc_control_id::VP9E_SET_ROW_MT, 1)?;
        Ok(encoder)
    }

    fn control(&mut self, id: vp8e_enc_control_id, value: c_int) -> Result<(), String> {
        // SAFETY: the context is open, and every control this sets takes an `int`.
        let status = unsafe { vpx_codec_control_(&mut *self.context, id.0 as c_int, value) };
        checked(status, "libvpx refused a setting")
    }

    fn encode(&mut self, planes: &Planes, coded: &mut Vec<u8>) -> Result<(), String> {
        let rows = u64::from(planes.height);
        let chroma_rows = u64::from(planes.height.div_ceil(2));
        let ends = [
            u64::from(planes.luma_stride) * rows,
            u64::from(planes.cb_offset) + u64::from(planes.chroma_stride) * chroma_rows,
            u64::from(planes.cr_offset) + u64::from(planes.chroma_stride) * chroma_rows,
        ];
        let held = planes.samples.len() as u64;
        if planes.luma_stride < planes.width
            || planes.chroma_stride < planes.width.div_ceil(2)
            || ends.into_iter().any(|end| end > held)
        {
            return Err("the planes do not hold their layout".to_string());
        }
        let byte_stride = |samples: u32| -> Result<c_int, String> {
            c_int::try_from(u64::from(samples) * 2)
                .map_err(|_| "a stride past libvpx's".to_string())
        };
        let strides = [
            byte_stride(planes.luma_stride)?,
            byte_stride(planes.chroma_stride)?,
            byte_stride(planes.chroma_stride)?,
        ];
        let base = planes.samples.as_ptr();
        // SAFETY: `image` is written whole by the wrap, then pointed at planes checked above to
        // be in bounds, which outlive the encode.
        let mut image = unsafe {
            let mut image = MaybeUninit::<vpx_image_t>::zeroed();
            let wrapped = vpx_img_wrap(
                image.as_mut_ptr(),
                vpx_img_fmt::VPX_IMG_FMT_I42016,
                planes.width,
                planes.height,
                1,
                base.cast_mut().cast(),
            );
            if wrapped.is_null() {
                return Err("libvpx would not take planes of this size".to_string());
            }
            image.assume_init()
        };
        image.planes[0] = base.cast_mut().cast();
        image.planes[1] = base
            .wrapping_add(planes.cb_offset as usize)
            .cast_mut()
            .cast();
        image.planes[2] = base
            .wrapping_add(planes.cr_offset as usize)
            .cast_mut()
            .cast();
        image.stride[..3].copy_from_slice(&strides);
        image.bit_depth = 10;
        image.cs = vpx_color_space::VPX_CS_BT_2020;
        image.range = vpx_color_range::VPX_CR_STUDIO_RANGE;

        // SAFETY: the context is open and `image` points at live planes for the call.
        let status = unsafe {
            vpx_codec_encode(
                &mut *self.context,
                &image,
                self.frames,
                1,
                VPX_EFLAG_FORCE_KF as vpx_enc_frame_flags_t,
                VPX_DL_REALTIME as std::ffi::c_ulong,
            )
        };
        self.frames += 1;
        checked(status, "libvpx could not encode the frame")?;

        coded.clear();
        let mut iterator: vpx_codec_iter_t = std::ptr::null();
        loop {
            // SAFETY: the context is open and the iterator is libvpx's own cursor.
            let packet = unsafe { vpx_codec_get_cx_data(&mut *self.context, &mut iterator) };
            // SAFETY: libvpx hands back null or a packet live until the next call.
            let Some(packet) = (unsafe { packet.as_ref() }) else {
                break;
            };
            if packet.kind != vpx_codec_cx_pkt_kind::VPX_CODEC_CX_FRAME_PKT {
                continue;
            }
            // SAFETY: a frame packet's `frame` member is the live one, `sz` bytes at `buf`.
            let bytes = unsafe {
                let frame = packet.data.frame;
                std::slice::from_raw_parts(frame.buf.cast::<u8>(), frame.sz)
            };
            coded.extend_from_slice(bytes);
        }
        match coded.is_empty() {
            true => Err("libvpx produced no frame".to_string()),
            false => Ok(()),
        }
    }
}

impl Drop for Encoder {
    fn drop(&mut self) {
        // SAFETY: the context was opened and is destroyed once, here.
        unsafe { vpx_codec_destroy(&mut *self.context) };
    }
}

fn checked(status: vpx_codec_err_t, what: &str) -> Result<(), String> {
    if status == vpx_codec_err_t::VPX_CODEC_OK {
        return Ok(());
    }
    // SAFETY: libvpx returns a static string for every status.
    let reason = unsafe { CStr::from_ptr(vpx_codec_err_to_string(status)) };
    Err(format!("{what}: {}", reason.to_string_lossy()))
}

/// The browser's entry points, named outside libvpx's own `vp9_` and `vpx_`. The page reads what
/// `hdr_video_encode` writes through `out`.
mod exports {
    use super::{Encoder, Planes};
    use std::cell::RefCell;

    /// The stage, the loupe and the colour wheel, which take turns at three sizes: an encoder each,
    /// since one would reopen on every turn.
    const SURFACES: usize = 3;

    thread_local! {
        static HELD: RefCell<([Option<Encoder>; SURFACES], Vec<u8>, String)> =
            const { RefCell::new(([const { None }; SURFACES], Vec::new(), String::new())) };
    }

    /// `len` bytes, eight-aligned: the page views them as samples and words.
    #[unsafe(no_mangle)]
    pub extern "C" fn hdr_video_alloc(len: usize) -> *mut u8 {
        let mut words = std::mem::ManuallyDrop::new(Vec::<u64>::with_capacity(len.div_ceil(8)));
        words.as_mut_ptr().cast()
    }

    /// # Safety
    ///
    /// `ptr` came from `hdr_video_alloc(len)` and is freed once.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn hdr_video_free(ptr: *mut u8, len: usize) {
        drop(unsafe { Vec::from_raw_parts(ptr.cast::<u64>(), 0, len.div_ceil(8)) });
    }

    /// `surface`'s frame on its own encoder, on `threads` of them. Writes three words to `out`: a
    /// status, a pointer and a length in bytes. Status 0 is the coded frame at the pointer, 1 a
    /// failure with the reason there as UTF-8. Either stays there until the next call.
    ///
    /// # Safety
    ///
    /// `samples` is `len` readable `u16`s laid out as the rest of the arguments say, and `out`
    /// three writable words.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn hdr_video_encode(
        surface: u32,
        samples: *const u16,
        len: usize,
        width: u32,
        height: u32,
        luma_stride: u32,
        chroma_stride: u32,
        cb_offset: u32,
        cr_offset: u32,
        threads: u32,
        out: *mut u32,
    ) {
        let planes = Planes {
            samples: unsafe { std::slice::from_raw_parts(samples, len) },
            width,
            height,
            luma_stride,
            chroma_stride,
            cb_offset,
            cr_offset,
        };
        let words = HELD.with_borrow_mut(|(encoders, coded, message)| {
            let encoded = (|| -> Result<(), String> {
                let slot = encoders
                    .get_mut(surface as usize)
                    .ok_or_else(|| format!("there is no surface {surface}"))?;
                let encoder = match slot {
                    Some(open)
                        if (open.width, open.height, open.threads) == (width, height, threads) =>
                    {
                        open
                    }
                    _ => {
                        // The old one first, so its threads are back in the pool before the new
                        // one's start.
                        *slot = None;
                        slot.insert(Encoder::open(width, height, threads)?)
                    }
                };
                encoder.encode(&planes, coded)
            })();
            match encoded {
                Ok(()) => [0, coded.as_ptr() as u32, coded.len() as u32],
                Err(why) => {
                    *message = why;
                    [1, message.as_ptr() as u32, message.len() as u32]
                }
            }
        });
        unsafe { std::ptr::copy_nonoverlapping(words.as_ptr(), out, words.len()) };
    }
}
