// A LibRaw wrapper that exposes what the app actually wants, rather than the
// twenty-odd C calls the app currently makes to assemble it.
//
// Everything the TypeScript decoder does per frame happens here instead: as-shot
// white balance, PPG demosaic, the half-size decision, and the masked-border crop
// during the copy out of LibRaw's buffer. JS gets one call and a pointer.
//
// The reason this exists rather than a one-function shim: `params.half_size` has
// no setter in the C API, and bindgen resolves it from the installed headers, so
// the offset is the compiler's problem instead of something located at runtime.
//
// `bb_` and `Bb` are short for Bowerbird. On the exported functions the prefix is
// not decoration: C has one flat symbol namespace, and this library is dlopen'd
// into a process that already holds LibRaw, libvips, libheif and GLib, so a bare
// `decode` or `fit` would be an invitation. The `#[repr(C)]` types carry it too,
// against the usual rule of naming for behaviour rather than owner, only so that
// each pairs visibly with the symbol it crosses the boundary in - `BbHeader` with
// `bb_read_header`. Types that stay on this side are named normally.

#![allow(non_upper_case_globals, non_camel_case_types, non_snake_case)]
// Unsafe is denied crate-wide and exempted one statement at a time, never one
// module or one function at a time. The three lints are a set and none of them
// does the job alone:
//
//   unsafe_code                   nothing may reach for unsafe unmarked.
//   unfulfilled_lint_expectations paired with `#[expect(unsafe_code)]` rather than
//                                 `#[allow]`, this makes a *stale* exemption an
//                                 error too - so unsafe that gets refactored away
//                                 takes its marker with it in the same commit.
//
// Together they hold one invariant: a marker cannot outlive what it was for, and
// new unsafe cannot appear without one. `grep -rn "expect(unsafe_code)"
// native/rawshim/src` is the audit, and the count only ever goes down.
#![deny(unsafe_code)]
#![deny(unfulfilled_lint_expectations)]
// The third of the set, and not on yet: `unsafe_op_in_unsafe_fn` stops an
// `unsafe fn` body being one implicit blanket, so each operation inside needs its
// own visible block and the surface stays countable. Turning it on today means
// reshaping 162 operations, ~150 of them inside the sixteen boundary functions this
// refactor is collapsing into one - throwaway work on code that is going. It goes
// on in the commit that finishes the boundary, when what is left is small enough
// that the count means something. Until then a marked `unsafe fn` does cover its
// whole body, which is the weaker invariant.
//#![deny(unsafe_op_in_unsafe_fn)]

use rayon::prelude::*;
use std::ffi::CStr;
use std::os::raw::{c_char, c_int};

pub mod avif;
pub mod ffi;
pub mod fit;
pub mod frame;
pub mod hdr;
pub mod hdr_args;
pub mod hdr_fit;
pub mod header;
pub mod image;
pub mod lens;
pub mod lensfun;
pub mod stacks;
pub mod tone;
pub mod vips;

mod raw {
    #![allow(non_upper_case_globals, non_camel_case_types, non_snake_case, dead_code)]
    include!(concat!(env!("OUT_DIR"), "/libraw.rs"));
}

/// Runs `body`, turning a panic into `fallback` rather than letting it out of the
/// library.
///
/// Every `bb_*` entry point is `extern "C"`, and a panic that reaches one of those
/// aborts the process - not this call, the whole of it, which here means the server and
/// every worker in it, with no Rust error string and nothing on stderr but the abort.
/// One frame that trips an index takes down an import of fifty thousand.
///
/// Applied to the entry points that run code rather than to all of them, and the line
/// is meant: the accessors that only report a `size_of`, and the frees that only take a
/// `Box` back, have nothing in them that can panic. Anything that touches a pixel, a
/// path or a parse is wrapped.
///
/// `AssertUnwindSafe` because the alternative is threading `UnwindSafe` through raw
/// pointers that are already the caller's responsibility. What it gives up - seeing a
/// half-updated value after a panic - is not available here anyway: every one of these
/// reports failure and hands back nothing.
pub(crate) fn guard<T>(what: &str, fallback: T, body: impl FnOnce() -> T) -> T {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(body)) {
        Ok(value) => value,
        Err(_) => {
            eprintln!("rawshim: {what} panicked; reporting failure rather than aborting the process");
            fallback
        }
    }
}

/// LibRaw's `user_qual`: PPG, the cheapest of LibRaw's algorithms and not the
/// worst. See DESIGN 10.4 for the measured table across all of them.
const DEMOSAIC_PPG: c_int = 2;

/// Which demosaic to run, overridable with BOWERBIRD_DEMOSAIC.
///
/// A knob because the choice is a speed/quality trade that only measurement
/// settles, and the measurement is worth repeating on a different sensor: see
/// DESIGN 10.4 for the numbers across LibRaw's algorithms. Anything outside the
/// range LibRaw accepts falls back to PPG rather than letting it pick its default.
fn demosaic() -> c_int {
    std::env::var("BOWERBIRD_DEMOSAIC")
        .ok()
        .and_then(|value| value.parse::<c_int>().ok())
        .filter(|value| (0..=12).contains(value))
        .unwrap_or(DEMOSAIC_PPG)
}

const OUTPUT_SRGB: c_int = 1;
const OUTPUT_REC2020: c_int = 8;

/// A decoded image, owned by this library for as long as JS holds the pointer.
///
/// Handed to JS as an opaque handle, not as pixels. Every operation - fit, grade,
/// resize, encode - takes the handle back and works on the buffer where it lies,
/// so a 60MP render never crosses the boundary. It used to: the decode copied
/// into a JS `Buffer` and each call copied it back into a `Vec`, three ~45MB
/// moves of pixels no JavaScript ever looked at.
///
/// Still `#[repr(C)]` with plain fields, because the two paths that genuinely do
/// want the samples in JS - the 16-bit scene-linear decode the HDR encoder pipes
/// to ffmpeg, and the fit that grades it - read them through a DataView.
#[repr(C)]
pub struct BbImage {
    pub width: u32,
    pub height: u32,
    pub depth: u32,
    pub data: *mut u8,
    pub len: usize,
    /// Non-zero when the frame was decoded at half size.
    pub halved: u32,
    /// Non-zero when the frame was read straight out of `imgdata.image` rather than
    /// through `dcraw_make_mem_image`.
    ///
    /// Reported so the pin that holds the two against each other can check it actually
    /// forked. `copy_processed` declines on five conditions, one of them a LibRaw
    /// default it does not set - and a differential test whose two arms quietly become
    /// the same arm passes while proving nothing (`raw_decode.integration.test.ts`).
    /// Sits in padding the struct already had, so the layout is unchanged.
    pub direct: u32,
    /// Kept so `bb_free` can drop the exact allocation it handed out.
    capacity: usize,
}

impl BbImage {
    /// Takes ownership of an 8-bit RGB buffer and hands back a handle to it.
    pub fn own(image: vips::Rgb) -> *mut BbImage {
        let width = image.width as u32;
        let height = image.height as u32;
        let mut data = std::mem::ManuallyDrop::new(image.data);
        Box::into_raw(Box::new(BbImage {
            width,
            height,
            depth: 8,
            data: data.as_mut_ptr(),
            len: data.len(),
            halved: 0,
            direct: 0,
            capacity: data.capacity(),
        }))
    }

    /// The pixels, borrowed. None for a 16-bit decode, which the image operations
    /// have no path for - they are all 8-bit sRGB, and reading a 16-bit buffer as
    /// though it were 8-bit would silently render half the frame.
    ///
    /// The samples of a 16-bit decode, borrowed. None for an 8-bit one.
    ///
    /// Separate from `view` because the two are not interchangeable: the image
    /// operations are all 8-bit sRGB, and the HDR grade is all 16-bit scene-linear.
    /// Reading either buffer as the other silently renders half a frame.
    ///
    /// # Safety
    /// `data` must still point at the allocation this handle was built with.
    #[expect(unsafe_code)]
    pub unsafe fn view_u16(&self) -> Option<&[u16]> {
        if self.depth != 16 || self.data.is_null() {
            return None;
        }
        Some(std::slice::from_raw_parts(self.data as *const u16, self.len / 2))
    }

    /// # Safety
    /// `data` must still point at the allocation this handle was built with.
    #[expect(unsafe_code)]
    pub unsafe fn view(&self) -> Option<vips::RgbRef<'_>> {
        if self.depth != 8 || self.data.is_null() {
            return None;
        }
        Some(vips::RgbRef {
            width: self.width as usize,
            height: self.height as usize,
            data: std::slice::from_raw_parts(self.data, self.len),
        })
    }

    /// Drops the pixels while the handle itself stays alive.
    ///
    /// For the last reader of a decode, which knows the frame is finished with long
    /// before the JavaScript that owns the handle will get round to freeing it. A
    /// 61MP scene-linear decode is 366MB, and holding it through an encode that has
    /// already copied everything it needs out of it is the largest avoidable
    /// allocation left on either path.
    ///
    /// Both views check `data`, so what is left behind reads as a handle with no
    /// pixels rather than as a dangling one. Callers still holding a borrow taken
    /// before this must not use it afterwards - which is why it takes `&mut self`,
    /// so the borrow checker refuses the overlap wherever the reference is a Rust
    /// one rather than a pointer from across the boundary.
    ///
    /// # Safety
    /// `data` must still point at the allocation this handle was built with, and no
    /// borrow of it may outlive the call.
    #[expect(unsafe_code)]
    pub unsafe fn release_pixels(&mut self) {
        if self.data.is_null() {
            return;
        }
        drop(Vec::from_raw_parts(self.data, self.len, self.capacity));
        self.data = std::ptr::null_mut();
        self.len = 0;
        self.capacity = 0;
    }
}

pub struct Insets {
    pub left: usize,
    pub top: usize,
    pub right: usize,
    pub bottom: usize,
}

const UNSET: u16 = 65535;

/// The window LibRaw emits on its own, and the one the camera says is the picture.
/// Both in sensor coordinates.
pub struct Window {
    pub raw_width: u16,
    pub raw_height: u16,
    pub left_margin: u16,
    pub top_margin: u16,
    pub width: u16,
    pub height: u16,
    pub cleft: u16,
    pub ctop: u16,
    pub cwidth: u16,
    pub cheight: u16,
}

/// Rows and columns the camera says are outside the picture, in sensor
/// orientation. Some bodies report masked border columns as visible, and decoding
/// them verbatim bakes black bars into the render.
///
/// Measured against what LibRaw already trims rather than against the whole
/// sensor: the emitted frame starts at `left_margin`/`top_margin` and is
/// `width`x`height`, so only the part of the camera's crop that falls beyond that
/// is still ours to remove. Against the raw frame instead it was applied twice on
/// every body that declares one - an EOS R8 losing 168 columns and 108 rows off an
/// image that no longer had them, which is not a smaller picture but a differently
/// framed one, since the excess comes off two sides rather than four.
pub(crate) fn insets_of(w: &Window) -> Insets {
    let none = Insets { left: 0, top: 0, right: 0, bottom: 0 };
    if w.cleft == UNSET || w.ctop == UNSET || w.cwidth == 0 || w.cheight == 0 {
        return none;
    }
    if w.cleft + w.cwidth > w.raw_width || w.ctop + w.cheight > w.raw_height {
        return none;
    }
    let beyond = |edge: i32| edge.max(0) as usize;
    Insets {
        left: beyond(i32::from(w.cleft) - i32::from(w.left_margin)),
        top: beyond(i32::from(w.ctop) - i32::from(w.top_margin)),
        right: beyond(i32::from(w.left_margin) + i32::from(w.width) - i32::from(w.cleft) - i32::from(w.cwidth)),
        bottom: beyond(i32::from(w.top_margin) + i32::from(w.height) - i32::from(w.ctop) - i32::from(w.cheight)),
    }
}

/// # Safety
/// `r` must be a live `libraw_data_t` with `open_file` already run.
#[expect(unsafe_code)]
pub(crate) unsafe fn read_insets(r: *mut raw::libraw_data_t) -> Insets {
    let s = &(*r).sizes;
    let crop = s.raw_inset_crops[0];
    insets_of(&Window {
        raw_width: s.raw_width,
        raw_height: s.raw_height,
        left_margin: s.left_margin,
        top_margin: s.top_margin,
        width: s.width,
        height: s.height,
        cleft: crop.cleft,
        ctop: crop.ctop,
        cwidth: crop.cwidth,
        cheight: crop.cheight,
    })
}

/// dcraw_process emits an upright frame, so sensor-space margins arrive rotated by
/// the same flip.
///
/// Derived from `flip_index` rather than tabulated beside it. It used to be a match on
/// three flip values with everything else falling through to the identity, which is
/// right for flip 0 and wrong for 1, 2, 4 and 7: a transposed frame subtracted the
/// column insets from the axis that came from the sensor's rows, so the masked border
/// stayed in the picture and the same number of pixels came off two edges that never
/// had one. Nothing caught it because both decode paths share these insets, so the
/// byte-for-byte pin sees the same wrong answer twice.
///
/// The mapping is read off `flip_index` itself, over a 2x2 frame: step one pixel right
/// in the output and see which sensor axis moved, and in which direction. That cannot
/// drift from the walk it has to agree with, because it *is* that walk.
pub(crate) fn rotate_insets(i: Insets, flip: c_int) -> Insets {
    // Sensor-space edges, indexed so that `edge ^ 2` is the opposite one.
    const LEFT: usize = 0;
    const TOP: usize = 1;
    let edges = [i.left, i.top, i.right, i.bottom];

    let corner = |row: usize, col: usize| {
        let at = flip_index(flip, 2, 2, row, col);
        (at / 2, at % 2)
    };
    let (row0, col0) = corner(0, 0);
    let (_, col_right) = corner(0, 1);
    let (_, col_down) = corner(1, 0);

    // Which sensor edge the output's first column reads, and which its first row does.
    // Exactly one of the two sensor axes moves for each step, which is what makes this
    // a question with an answer.
    let reads = |sensor_column_moved: bool| -> usize {
        match (sensor_column_moved, sensor_column_moved && col0 == 0 || !sensor_column_moved && row0 == 0) {
            (true, true) => LEFT,
            (true, false) => LEFT ^ 2,
            (false, true) => TOP,
            (false, false) => TOP ^ 2,
        }
    };
    let left = reads(col_right != col0);
    let top = reads(col_down != col0);

    Insets { left: edges[left], top: edges[top], right: edges[left ^ 2], bottom: edges[top ^ 2] }
}

/// LibRaw's flip code, as it will be by the time the pixels exist.
///
/// `sizes.flip` is only a small integer once LibRaw has been through the frame.
/// `parse_ciff` assigns it straight out of the file, where it is *degrees* - and
/// `raw2image_start`, which runs inside `unpack`, rewrites 270/180/90 to 5/3/6 on the
/// way past. So anything read before `unpack` and anything read after it are two
/// different numbers for the same rotation, and they do not even agree on whether the
/// quarter-turn bit is set: 270 & 4 is 0 where 5 & 4 is 4.
///
/// Only CIFF/CRW and a couple of medium-format formats record degrees, and only a body
/// that also declares a crop can be bitten by the disagreement, which is why this went
/// unnoticed. Normalising at every read is cheaper than remembering which side of
/// `unpack` a given line is on.
pub(crate) fn normalised_flip(flip: c_int) -> c_int {
    match (flip + 3600) % 360 {
        270 => 5,
        180 => 3,
        90 => 6,
        _ => flip,
    }
}

fn halve_insets(i: Insets) -> Insets {
    Insets { left: i.left / 2, top: i.top / 2, right: i.right / 2, bottom: i.bottom / 2 }
}

/// as-shot multipliers normalised to green. None when the file recorded no usable
/// set: writing a zero would zero that channel, which is worse than the wrong
/// white balance this exists to fix. The fourth is excluded from the test because a
/// three-colour camera reports it as 0 legitimately.
fn camera_multipliers(cam_mul: &[f32; 4]) -> Option<[f32; 4]> {
    let (r, g, b, g2) = (cam_mul[0], cam_mul[1], cam_mul[2], cam_mul[3]);
    if !(r > 0.0) || !(g > 0.0) || !(b > 0.0) {
        return None;
    }
    Some([r / g, 1.0, b / g, if g2 > 0.0 { g2 / g } else { 1.0 }])
}

/// Take the `dcraw_make_mem_image` path even where `copy_processed` would serve.
///
/// For the test that holds the two against each other; nothing else sets it.
fn reference_copy() -> bool {
    std::env::var("BOWERBIRD_REFERENCE_COPY").is_ok_and(|value| value == "1")
}

/// `dcraw_make_mem_image` and the copy after it, done in one pass, for the scene-linear
/// decode only.
///
/// `dcraw_process` leaves the frame in `imgdata.image`: four `ushort` planes, in sensor
/// orientation. `dcraw_make_mem_image` allocates a second whole frame to interleave it
/// into, and this used to copy *that* out again to apply the crop - measured at 153ms
/// and ~80ms against a 534ms decode, nearly half of it spent moving bytes already
/// computed. Here the interleave, the orientation and the crop happen once, in parallel.
///
/// **Only for the scene-linear decode**, and the guard below is the reason rather than
/// caution. `copy_mem_image` rebuilds `imgdata.color.curve` before reading it - the
/// table sitting in the struct is not the one LibRaw is about to use - so reproducing
/// it means reproducing dcraw's `gamma_curve(gamm[0], gamm[1], 2, (t_white << 3) /
/// bright)`. On the sRGB path `t_white` comes from a histogram scan against
/// `auto_bright_thr`, which is a heuristic this has no business shadowing. On this path
/// the inputs are pinned instead. `no_auto_bright`, which this sets, short-circuits the
/// histogram scan so `t_white` stays at 0x2000 and `imax` is exactly 65536; `gamm` is
/// {1,1}, also set here; and `bright` is 1, which is LibRaw's *default* rather than
/// anything this asks for - which is why the guard checks it rather than trusting it.
/// With `g[0]` and `g[1]` both 1 and `g[4]` 0, *both* branches of dcraw's piecewise
/// reduce to `r` - the linear arm is `r * g[1]`, the power arm `pow(r, g[0]) * (1 + g[4])
/// - g[4]` - so the table is `curve[i] = i` for all 65536 entries. Confirmed by running
/// dcraw's `gamma_curve(1.0, 1.0, 2, 65536)` and diffing against the identity: zero
/// differing entries, `curve[65535] == 65535`. The knee the bisection lands on does not
/// enter into it - it converges to 1 - 2^-48 rather than to 1, and it does not matter.
///
/// Hence no lookup here at all - the identity is not an assumption about LibRaw, it is
/// what those constants make the curve.
///
/// A pin holds the output byte-for-byte against `dcraw_make_mem_image`
/// (`raw_decode.integration.test.ts`), because that reasoning is exactly the kind that
/// looks right and renders half a frame wrong.
///
/// **Fits to `long_edge` on the way out**, which is where the memory goes rather than
/// the time. A 3840px rendition off a 24MP frame wants 59MB, and building the whole
/// 145MB decode to box-average it down afterwards meant that buffer coexisting with
/// LibRaw's own 194MB working set. Averaging straight out of `imgdata.image` is the
/// same box filter over the same source pixels in the same order - `box_resize_u16`
/// then declines, finding the frame already at size - so it costs nothing and the
/// intermediate never exists. 0 leaves the frame at the size it decoded to.
///
/// None when the frame is not what is expected, which leaves the caller on the LibRaw
/// path rather than guessing.
#[expect(unsafe_code)]
unsafe fn copy_processed(
    r: *mut raw::libraw_data_t,
    depth: u32,
    i: &Insets,
    long_edge: u32,
) -> Option<(usize, usize, Vec<u8>)> {
    let p = &(*r).params;
    let identity_curve =
        p.no_auto_bright == 1 && p.gamm[0] == 1.0 && p.gamm[1] == 1.0 && p.bright == 1.0;
    if depth != 16 || !identity_curve || (*r).image.is_null() || (*r).idata.colors != 3 {
        return None;
    }

    let s = &(*r).sizes;
    let flip = s.flip;
    // `copy_mem_image` overwrites `S.iwidth`/`S.iheight` with `S.width`/`S.height`
    // before indexing, so the stride `flip_index` walks is the processed width.
    let (iwidth, iheight) = (s.width as usize, s.height as usize);
    // The quarter-turn swap applies to the output loop bounds only, after that.
    let (width, height) = if flip & 4 == 0 { (iwidth, iheight) } else { (iheight, iwidth) };
    let out_width = width.saturating_sub(i.left + i.right);
    let out_height = height.saturating_sub(i.top + i.bottom);
    if out_width == 0 || out_height == 0 {
        return None;
    }

    let flip_index = |row: usize, col: usize| flip_index(flip, iwidth, iheight, row, col);

    let (tw, th) = decode_target(out_width, out_height, long_edge);

    let planes = std::slice::from_raw_parts((*r).image, iwidth * iheight);
    // Written as bytes rather than as `u16`s that are then reinterpreted. Rebuilding a
    // `Vec<u8>` over a `Vec<u16>`'s allocation is undefined: `dealloc` has to be handed
    // the same layout `alloc` got, and the alignment differs (2 against 1). The System
    // allocator does not care, which is exactly what makes it the kind of thing that
    // survives every test and then does not survive a different allocator.
    //
    // Native byte order, which is what every reader on this side assumes.
    //
    // `box_resize_u16` declines an enlargement or an identity, and so does this: the
    // two have to agree about when a fit happens or the grade would resize a frame this
    // already did.
    if tw >= out_width || th >= out_height {
        let stride = out_width * 6;
        let mut out = vec![0u8; stride * out_height];
        out.par_chunks_mut(stride).enumerate().for_each(|(y, row)| {
            for x in 0..out_width {
                let px = planes[flip_index(y + i.top, x + i.left)];
                for c in 0..3 {
                    let at = x * 6 + c * 2;
                    row[at..at + 2].copy_from_slice(&px[c].to_ne_bytes());
                }
            }
        });
        return Some((out_width, out_height, out));
    }

    // `box_resize_u16`, reading through the flip and the crop instead of through a copy
    // that applied them. Accumulation order is row-then-column with the channel
    // innermost, matching it exactly, so the result is the same to the bit.
    let xs = out_width as f64 / tw as f64;
    let ys = out_height as f64 / th as f64;
    let stride = tw * 6;
    let mut out = vec![0u8; stride * th];
    out.par_chunks_mut(stride).enumerate().for_each(|(dy, row)| {
        let y0 = (dy as f64 * ys).floor() as usize;
        let y1 = (((dy + 1) as f64 * ys).floor() as usize).max(y0 + 1);
        for dx in 0..tw {
            let x0 = (dx as f64 * xs).floor() as usize;
            let x1 = (((dx + 1) as f64 * xs).floor() as usize).max(x0 + 1);
            let mut acc = [0.0f64; 3];
            for y in y0..y1 {
                for x in x0..x1 {
                    let px = planes[flip_index(y + i.top, x + i.left)];
                    for c in 0..3 {
                        acc[c] += f64::from(px[c]);
                    }
                }
            }
            let n = ((y1 - y0) * (x1 - x0)) as f64;
            for c in 0..3 {
                let value = (acc[c] / n).round() as u16;
                let at = dx * 6 + c * 2;
                row[at..at + 2].copy_from_slice(&value.to_ne_bytes());
            }
        }
    });
    Some((tw, th, out))
}

/// The size a decode is fitted to on its way out, which is the same arithmetic the
/// grade would otherwise have applied afterwards - so that it finds nothing left to do.
///
/// One definition, called by both decode paths: the direct read fuses the fit into its
/// copy out of `imgdata.image`, and the `dcraw_make_mem_image` reference applies it as
/// a separate pass, and the differential test between them is only meaningful if they
/// agree on the target. An edge of 0 means native resolution and no fit.
fn decode_target(width: usize, height: usize, long_edge: u32) -> (usize, usize) {
    let size = match long_edge {
        0 => hdr_args::Size { width: width as u32, height: height as u32 },
        edge => hdr_args::fitted(width as u32, height as u32, f64::from(edge)),
    };
    (size.width as usize, size.height as usize)
}

/// dcraw's `flip_index`, which is what makes the orientation match LibRaw's to the pixel.
///
/// `iwidth`/`iheight` are the *processed* dimensions - `copy_mem_image` assigns
/// `S.iwidth = S.width` and `S.iheight = S.height` before it indexes anything, and the
/// struct's own `iwidth`/`iheight` are not those: `raw2image_start` leaves them shrunk
/// by `IO.shrink`, so under `half_size` reading them would walk the wrong stride.
fn flip_index(flip: c_int, iwidth: usize, iheight: usize, row: usize, col: usize) -> usize {
    let (mut row, mut col) = if flip & 4 != 0 { (col, row) } else { (row, col) };
    if flip & 2 != 0 {
        row = iheight - 1 - row;
    }
    if flip & 1 != 0 {
        col = iwidth - 1 - col;
    }
    row * iwidth + col
}

/// Copies the frame out of LibRaw's buffer with the crop applied on the way.
///
/// The `dcraw_make_mem_image` path: what the sRGB decode uses, and the reference
/// `copy_processed` is pinned against.
#[expect(unsafe_code)]
unsafe fn copy_cropped(src: *const u8, w: usize, h: usize, bytes_per_px: usize, i: &Insets) -> Vec<u8> {
    let width = w.saturating_sub(i.left + i.right);
    let height = h.saturating_sub(i.top + i.bottom);
    if width == 0 || height == 0 || (i.left | i.top | i.right | i.bottom) == 0 {
        return std::slice::from_raw_parts(src, w * h * bytes_per_px).to_vec();
    }
    let stride = w * bytes_per_px;
    let row_bytes = width * bytes_per_px;
    let mut out = Vec::with_capacity(width * height * bytes_per_px);
    for row in 0..height {
        let from = (row + i.top) * stride + i.left * bytes_per_px;
        out.extend_from_slice(std::slice::from_raw_parts(src.add(from), row_bytes));
    }
    out
}

/// Decodes a RAW to an upright RGB bitmap.
///
/// `at_least_long_edge` is the longest edge the caller needs; when halving still
/// clears it the decode runs at half size. 0 means the whole frame.
///
/// Returns null on any failure. The result must be released with `bb_free`.
///
/// # Safety
/// `path` must be a NUL-terminated C string.
#[expect(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn bb_decode(
    path: *const c_char,
    depth: u32,
    rec2020_linear: c_int,
    at_least_long_edge: u32,
) -> *mut BbImage {
    if path.is_null() || (depth != 8 && depth != 16) {
        return std::ptr::null_mut();
    }
    let r = raw::libraw_init(0);
    if r.is_null() {
        return std::ptr::null_mut();
    }

    // Guarded around the closure rather than outside `libraw_init`, so a panic still
    // reaches the `recycle`/`close` below instead of leaking the processor with it.
    let result = guard("bb_decode", None, || (|| -> Option<Box<BbImage>> {
        if raw::libraw_open_file(r, CStr::from_ptr(path).as_ptr()) != 0 {
            return None;
        }

        // Read before unpack/process, which overwrite the size fields - and normalised,
        // because `unpack` also rewrites a degree-valued flip into a code, and
        // `copy_processed` reads it on the far side of that.
        let flip = normalised_flip((*r).sizes.flip);
        let mut insets = rotate_insets(read_insets(r), flip);
        let full_long_edge = (*r).sizes.width.max((*r).sizes.height) as u32;

        // The typed field the whole wrapper exists for.
        let halved = at_least_long_edge > 0 && full_long_edge / 2 >= at_least_long_edge;
        if halved {
            (*r).params.half_size = 1;
            insets = halve_insets(insets);
        }

        if let Some(mul) = camera_multipliers(&(*r).color.cam_mul) {
            (*r).params.user_mul = mul;
        }
        (*r).params.user_qual = demosaic();
        (*r).params.output_bps = depth as c_int;
        if rec2020_linear != 0 {
            (*r).params.output_color = OUTPUT_REC2020;
            // Identity curve, so samples stay proportional to the light that made
            // them, and no auto-brightening to normalise away HDR headroom.
            (*r).params.gamm[0] = 1.0;
            (*r).params.gamm[1] = 1.0;
            (*r).params.no_auto_bright = 1;
        } else {
            (*r).params.output_color = OUTPUT_SRGB;
        }

        if raw::libraw_unpack(r) != 0 || raw::libraw_dcraw_process(r) != 0 {
            return None;
        }

        // Straight out of `imgdata.image` where the curve is ours to know, which skips
        // the second whole-frame buffer `dcraw_make_mem_image` would allocate and the
        // copy back out of it.
        let taken =
            if reference_copy() { None } else { copy_processed(r, depth, &insets, at_least_long_edge) };
        let direct = taken.is_some();
        let (width, height, data) = match taken {
            Some(done) => done,
            None => {
                let mut err: c_int = 0;
                let image = raw::libraw_dcraw_make_mem_image(r, &mut err);
                if image.is_null() || err != 0 {
                    return None;
                }
                let w = (*image).width as usize;
                let h = (*image).height as usize;
                let colors = (*image).colors;
                let bits = (*image).bits as u32;
                let data =
                    copy_cropped((*image).data.as_ptr(), w, h, 3 * (depth as usize / 8), &insets);
                raw::libraw_dcraw_clear_mem(image);
                if colors != 3 || bits != depth {
                    return None;
                }
                let (cw, ch) = (w - insets.left - insets.right, h - insets.top - insets.bottom);
                // The fit the direct path fuses into its copy, applied here as the
                // separate pass it used to be. That is what keeps the two comparable:
                // `raw_decode.integration.test.ts` holds them against each other, and
                // it is now pinning the fusion as well as the interleave.
                //
                // Round-tripping through `Vec<u16>` rather than viewing the bytes as
                // one, because a `Vec<u8>` is only guaranteed to be byte-aligned. This
                // is the reference path, taken by that test alone, so the extra copy
                // costs nothing anybody waits for.
                let (tw, th) = decode_target(cw, ch, at_least_long_edge);
                if depth != 16 || (tw, th) == (cw, ch) {
                    (cw, ch, data)
                } else {
                    let samples: Vec<u16> =
                        data.chunks_exact(2).map(|b| u16::from_ne_bytes([b[0], b[1]])).collect();
                    let resized = image::box_resize_u16(&samples, cw, ch, tw, th)?;
                    let mut bytes = Vec::with_capacity(resized.len() * 2);
                    for sample in resized {
                        bytes.extend_from_slice(&sample.to_ne_bytes());
                    }
                    (tw, th, bytes)
                }
            }
        };

        let width = width as u32;
        let height = height as u32;
        let mut data = std::mem::ManuallyDrop::new(data);
        Some(Box::new(BbImage {
            width,
            height,
            depth,
            data: data.as_mut_ptr(),
            len: data.len(),
            halved: u32::from(halved),
            direct: u32::from(direct),
            capacity: data.capacity(),
        }))
    })());

    raw::libraw_recycle(r);
    raw::libraw_close(r);
    match result {
        Some(image) => Box::into_raw(image),
        None => std::ptr::null_mut(),
    }
}

/// `libraw_image_formats_t`: a preview is either a JPEG or a bare bitmap.
const LIBRAW_IMAGE_JPEG: raw::LibRaw_image_formats = 1;

/// Runs `use_bytes` over the camera's embedded JPEG preview, in place.
///
/// The bytes stay in LibRaw's own buffer for the duration - they are 5-14MB on a
/// 61MP body, which embeds a full-resolution preview - and are released before
/// this returns. Nothing copies them, and in particular nothing hands them to
/// JavaScript, which is the whole reason this exists rather than an "extract the
/// preview" call.
///
/// None when the file has no JPEG preview: some bodies embed a bitmap and some
/// embed nothing, which is a property of the file rather than an error, and the
/// caller falls back to a render.
///
/// # Safety
/// `path` must be a NUL-terminated C string.
#[expect(unsafe_code)]
unsafe fn with_embedded_jpeg<T>(path: *const c_char, use_bytes: impl FnOnce(&[u8]) -> T) -> Option<T> {
    let r = raw::libraw_init(0);
    if r.is_null() {
        return None;
    }

    let result = (|| -> Option<T> {
        if raw::libraw_open_file(r, path) != 0 || raw::libraw_unpack_thumb(r) != 0 {
            return None;
        }
        let mut err: c_int = 0;
        let thumb = raw::libraw_dcraw_make_mem_thumb(r, &mut err);
        if thumb.is_null() || err != 0 {
            return None;
        }
        // Freed on every path below, including the one where the format is wrong.
        let out = (|| {
            let size = (*thumb).data_size as usize;
            if (*thumb).type_ != LIBRAW_IMAGE_JPEG || size == 0 {
                return None;
            }
            Some(use_bytes(std::slice::from_raw_parts((*thumb).data.as_ptr(), size)))
        })();
        raw::libraw_dcraw_clear_mem(thumb);
        out
    })();

    raw::libraw_recycle(r);
    raw::libraw_close(r);
    result
}

/// The camera's embedded preview as RGB, bounded by `long_edge`, for callers on this
/// side of the boundary. None when the file embeds no JPEG preview.
pub fn decode_embedded_rgb(path: &str, long_edge: usize) -> Option<vips::Rgb> {
    vips::init();
    let c_path = std::ffi::CString::new(path).ok()?;
    // SAFETY: the CString outlives the call.
    #[expect(unsafe_code)]
    let decoded = unsafe {
        with_embedded_jpeg(c_path.as_ptr(), |bytes| {
            vips::Pipeline::thumbnail(bytes, long_edge).and_then(vips::Pipeline::finish)
        })
    };
    match decoded {
        Some(Ok(image)) => Some(image),
        Some(Err(detail)) => {
            eprintln!("decode_embedded_rgb: {detail}");
            None
        }
        None => None,
    }
}

/// Decodes the camera's embedded preview to an upright RGB bitmap, fitted to
/// `long_edge`. 0 leaves it at the size the body embedded.
///
/// This is the whole of an import's thumbnail stage: extract, decode, shrink. It
/// used to be three steps with the JPEG copied into a JavaScript `Buffer` in the
/// middle, which was both the largest thing crossing the boundary and the reason
/// libvips' operation cache had to go - a cached graph held a pointer into bytes
/// that JavaScript was free to collect (`vips.rs`).
///
/// Returns null when the file has no JPEG preview, which is not an error.
///
/// # Safety
/// `path` must be a NUL-terminated C string. Release with `bb_free`.
#[expect(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn bb_decode_embedded(path: *const c_char, long_edge: u32) -> *mut BbImage {
    vips::init();
    if path.is_null() {
        return std::ptr::null_mut();
    }

    // The grid tile of every photo in an import comes through here, off a JPEG the
    // camera wrote and nothing has validated.
    let decoded = guard("bb_decode_embedded", None, || {
        with_embedded_jpeg(path, |bytes| match long_edge {
            0 => vips::Pipeline::decode_upright(bytes).and_then(vips::Pipeline::finish),
            edge => vips::Pipeline::thumbnail(bytes, edge as usize).and_then(vips::Pipeline::finish),
        })
    });

    match decoded {
        Some(Ok(image)) => BbImage::own(image),
        Some(Err(detail)) => {
            eprintln!("bb_decode_embedded: {detail}");
            std::ptr::null_mut()
        }
        None => std::ptr::null_mut(),
    }
}

/// Reads what the catalogue needs from a RAW without decoding a pixel.
///
/// Returns 0 on success, -1 if the file could not be opened. See `header.rs` for
/// why this is not a set of byte offsets in TypeScript any more.
///
/// # Safety
/// `path` must be a NUL-terminated C string and `out` a writable `BbHeader`.
#[expect(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn bb_read_header(path: *const c_char, out: *mut header::BbHeader) -> c_int {
    if path.is_null() || out.is_null() {
        return -1;
    }
    let Ok(path) = CStr::from_ptr(path).to_str() else { return -1 };
    // Runs on every file of a scan, and parses maker notes off untrusted bytes.
    match guard("bb_read_header", None, || header::read_path(path)) {
        Some(header) => {
            *out = header;
            0
        }
        None => -1,
    }
}

/// Size of `BbHeader`, which the caller checks against the layout it reads.
#[expect(unsafe_code)]
#[no_mangle]
pub extern "C" fn bb_header_size() -> usize {
    std::mem::size_of::<header::BbHeader>()
}

/// Releases an image from `bb_decode`. Safe to call with null.
///
/// # Safety
/// `image` must have come from `bb_decode` and not been freed already.
#[expect(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn bb_free(image: *mut BbImage) {
    if image.is_null() {
        return;
    }
    let mut image = Box::from_raw(image);
    // Null when the last reader already released the pixels, and `from_raw_parts`
    // takes no null pointer even at length zero.
    image.release_pixels();
}

/// How many bytes `bb_descriptor` writes, so the caller can size its buffer and
/// the database column without either guessing.
#[expect(unsafe_code)]
#[no_mangle]
pub extern "C" fn bb_descriptor_size() -> usize {
    stacks::DESCRIPTOR_BYTES
}

/// Writes the stacking descriptor for an 8-bit image into `out`.
///
/// Returns 0 on success, -1 when the handle holds no 8-bit samples.
///
/// # Safety
/// `image` must be a live handle and `out` must have room for
/// `bb_descriptor_size()` bytes.
#[expect(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn bb_descriptor(image: *const BbImage, out: *mut u8) -> c_int {
    if image.is_null() || out.is_null() {
        return -1;
    }
    let Some(view) = (*image).view() else {
        return -1;
    };
    let descriptor = stacks::describe(view);
    std::ptr::copy_nonoverlapping(descriptor.as_ptr(), out, descriptor.len());
    0
}

/// Groups frames into stacks, writing one group index per frame into `out`, or
/// -1 for a frame that ended up alone.
///
/// The frames must arrive in ascending time order, which the query that selects
/// them already guarantees.
///
/// Returns 0 on success, -1 on a null argument.
///
/// # Safety
/// `descriptors` must hold `count * bb_descriptor_size()` bytes, and
/// `timestamps` and `out` must each hold `count` elements.
#[expect(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn bb_stack_groups(
    descriptors: *const u8,
    timestamps: *const i64,
    count: usize,
    threshold: f32,
    window_seconds: i64,
    out: *mut i32,
) -> c_int {
    if descriptors.is_null() || timestamps.is_null() || out.is_null() {
        return -1;
    }
    let descriptors = std::slice::from_raw_parts(descriptors, count * stacks::DESCRIPTOR_BYTES);
    let timestamps = std::slice::from_raw_parts(timestamps, count);
    let groups = stacks::group(descriptors, timestamps, threshold, window_seconds);
    std::ptr::copy_nonoverlapping(groups.as_ptr(), out, count);
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_released_handle_reads_as_empty_rather_than_dangling() {
        // The whole safety argument for releasing early is that what is left behind
        // answers "no pixels" instead of handing out a freed buffer - so a caller that
        // releases too soon gets a refused encode rather than a wrong one.
        let image = BbImage::own(vips::Rgb { width: 2, height: 2, data: vec![7u8; 12] });
        #[expect(unsafe_code)]
        unsafe {
            assert!((*image).view().is_some(), "the handle starts with pixels");
            (*image).release_pixels();
            assert!((*image).view().is_none(), "a released handle must not hand out pixels");
            // Idempotent, which is what lets `bb_free` run the same path unconditionally
            // rather than branching on whether someone got there first.
            (*image).release_pixels();
            bb_free(image);
        }
    }

    // Every orientation LibRaw can hand over, which the fixtures cannot give.
    //
    // Both test RAWs carry EXIF orientation 8, which dcraw maps to flip 5 - so the
    // byte-for-byte pin against `dcraw_make_mem_image` covers one value out of eight,
    // and *not* flip 0, an ordinary landscape photograph. The commit that added it
    // claimed two. This is the coverage that claim wanted.
    //
    // Bijection is the property worth asserting rather than a table of expected
    // indices: it says every output pixel reads exactly one source pixel and every
    // source pixel is read exactly once, which is simultaneously "no index escapes the
    // buffer", "no pixel is duplicated" and "none is dropped". A transposed axis or an
    // inverted mirror breaks it immediately.
    #[test]
    fn every_orientation_maps_the_frame_onto_itself_exactly_once() {
        for flip in 0..8 {
            for (iwidth, iheight) in [(7usize, 5usize), (5, 7), (4, 4), (1, 6)] {
                // What `copy_processed` derives: the quarter-turn swaps the output
                // bounds, and only the output bounds.
                let (width, height) =
                    if flip & 4 == 0 { (iwidth, iheight) } else { (iheight, iwidth) };

                let mut seen = vec![0u32; iwidth * iheight];
                for row in 0..height {
                    for col in 0..width {
                        let at = flip_index(flip, iwidth, iheight, row, col);
                        assert!(at < seen.len(), "flip {flip} {iwidth}x{iheight} escaped at {row},{col}");
                        seen[at] += 1;
                    }
                }
                assert!(
                    seen.iter().all(|count| *count == 1),
                    "flip {flip} on {iwidth}x{iheight} is not a bijection: {seen:?}",
                );
            }
        }
    }

    // The crop has to remove the same sensor pixels whichever space it is expressed in.
    //
    // That is the whole contract of `rotate_insets`, and it is checkable directly: walk
    // the output's surviving rectangle through `flip_index` and the set of sensor
    // pixels it reaches must be exactly the set the sensor-space rectangle describes.
    // Flips 1, 2, 4 and 7 failed this - the old table fell through to the identity for
    // all four - and the byte-exact decode pin could never have caught it, because both
    // decode paths take their insets from the same place and so agree on the wrong ones.
    #[test]
    fn the_crop_removes_the_same_sensor_pixels_whichever_way_the_frame_turns() {
        // Deliberately asymmetric on all four edges: a symmetric set passes under any
        // permutation and would prove nothing.
        let sensor = Insets { left: 1, top: 2, right: 3, bottom: 4 };
        let (iwidth, iheight) = (11usize, 13usize);

        let wanted: std::collections::BTreeSet<usize> = (sensor.top..iheight - sensor.bottom)
            .flat_map(|row| {
                (sensor.left..iwidth - sensor.right).map(move |col| row * iwidth + col)
            })
            .collect();

        for flip in 0..8 {
            let out = rotate_insets(
                Insets { left: sensor.left, top: sensor.top, right: sensor.right, bottom: sensor.bottom },
                flip,
            );
            let (width, height) =
                if flip & 4 == 0 { (iwidth, iheight) } else { (iheight, iwidth) };

            let reached: std::collections::BTreeSet<usize> = (out.top..height - out.bottom)
                .flat_map(|row| {
                    (out.left..width - out.right)
                        .map(move |col| flip_index(flip, iwidth, iheight, row, col))
                })
                .collect();

            assert_eq!(reached, wanted, "flip {flip} crops the wrong pixels");
        }
    }

    #[test]
    fn a_panic_becomes_a_failed_call_rather_than_a_dead_process() {
        // The thing being prevented does not fail a test, it ends the test binary - a
        // panic crossing an `extern "C"` boundary aborts. So this checks the guard
        // itself: the value comes back, the process is still here to assert on it, and
        // a normal return still passes through untouched.
        //
        // Quietened first, or the panic's own backtrace goes to stderr and reads like
        // a failure in a suite that is passing.
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let out = guard("a test", -1, || -> i32 { panic!("as if an index escaped a frame") });
        std::panic::set_hook(previous);

        assert_eq!(out, -1, "a panic must come back as the fallback");
        assert_eq!(guard("a test", -1, || 7), 7, "and an ordinary return untouched");
    }

    #[test]
    fn a_degree_valued_flip_becomes_the_code_unpack_would_have_made_of_it() {
        // What `raw2image_start` does inside `unpack`, done at every read instead so
        // the two sides of that call cannot disagree. A CIFF/CRW records degrees.
        assert_eq!(normalised_flip(270), 5);
        assert_eq!(normalised_flip(180), 3);
        assert_eq!(normalised_flip(90), 6);
        // Negative degrees are the same rotation; LibRaw's own `+ 3600` handles them.
        assert_eq!(normalised_flip(-90), 5);
        // Codes pass through untouched, including 0 and the ones that collide with no
        // degree value.
        for code in [0, 1, 2, 3, 4, 5, 6, 7] {
            assert_eq!(normalised_flip(code), code);
        }
        // 360 is no rotation and must not be read as the code 0's neighbour.
        assert_eq!(normalised_flip(360), 360);
    }

    #[test]
    fn the_identity_orientation_is_row_major_order() {
        // Flip 0 is the common case and the one the pin never sees, so it gets its
        // exact indices rather than only the bijection property.
        for (row, col, want) in [(0, 0, 0), (0, 3, 3), (1, 0, 7), (4, 6, 34)] {
            assert_eq!(flip_index(0, 7, 5, row, col), want, "{row},{col}");
        }
        // Flip 5 is what both fixtures are: transpose, then mirror the column.
        assert_eq!(flip_index(5, 7, 5, 0, 0), 6);
        // Flip 3 is a half turn: last pixel first.
        assert_eq!(flip_index(3, 7, 5, 0, 0), 34);
    }

    #[test]
    fn normalises_the_as_shot_multipliers_to_green() {
        // A real ILCE-7CR set, as LibRaw reports it.
        let out = camera_multipliers(&[2770.0, 1024.0, 1669.0, 1024.0]).unwrap();
        assert_eq!(out, [2770.0 / 1024.0, 1.0, 1669.0 / 1024.0, 1.0]);
    }

    #[test]
    fn substitutes_green_for_a_three_colour_camera() {
        // Reporting 0 in the fourth slot is legitimate, not corruption, so it must
        // not veto the set - that would skip white balance on exactly those bodies.
        let out = camera_multipliers(&[2060.0, 1024.0, 2904.0, 0.0]).unwrap();
        assert_eq!(out, [2060.0 / 1024.0, 1.0, 2904.0 / 1024.0, 1.0]);
    }

    #[test]
    fn refuses_a_set_missing_any_of_r_g_b() {
        // These go straight into user_mul, so one zero would zero that channel and
        // one negative would invert it. Falling back to LibRaw's default is better.
        assert!(camera_multipliers(&[0.0, 1024.0, 1669.0, 1024.0]).is_none());
        assert!(camera_multipliers(&[2770.0, 0.0, 1669.0, 1024.0]).is_none());
        assert!(camera_multipliers(&[2770.0, 1024.0, 0.0, 1024.0]).is_none());
        assert!(camera_multipliers(&[2770.0, 1024.0, -1669.0, 1024.0]).is_none());
    }

    #[test]
    fn never_returns_a_non_positive_multiplier() {
        for set in [[2770.0, 1024.0, 1669.0, 1024.0], [2060.0, 1024.0, 2904.0, 0.0], [1.0, 1.0, 1.0, -5.0]] {
            if let Some(out) = camera_multipliers(&set) {
                assert!(out.iter().all(|v| *v > 0.0), "{set:?} produced {out:?}");
            }
        }
    }

    /// Every geometry below was read off real files with LibRaw.
    fn insets(w: &Window) -> (usize, usize, usize, usize) {
        let i = insets_of(w);
        (i.left, i.top, i.right, i.bottom)
    }

    #[test]
    fn takes_nothing_more_off_a_frame_libraw_already_cropped() {
        // EOS R8. LibRaw starts at the camera's own crop origin and emits exactly
        // it, so every edge is already where it belongs. Measuring against the raw
        // frame took another 168 columns and 108 rows off two sides of that.
        let r8 = Window {
            raw_width: 6188,
            raw_height: 4120,
            left_margin: 168,
            top_margin: 108,
            width: 5999,
            height: 3999,
            cleft: 168,
            ctop: 108,
            cwidth: 6000,
            cheight: 4000,
        };
        assert_eq!(insets(&r8), (0, 0, 0, 0));
    }

    #[test]
    fn still_trims_the_masked_border_a_body_reports_as_visible() {
        // ILCE-7CR: LibRaw trims nothing, so the whole declared crop is ours.
        let a7cr = Window {
            raw_width: 9728,
            raw_height: 6656,
            left_margin: 0,
            top_margin: 0,
            width: 9728,
            height: 6656,
            cleft: 32,
            ctop: 20,
            cwidth: 9504,
            cheight: 6336,
        };
        assert_eq!(insets(&a7cr), (32, 20, 192, 300));
    }

    #[test]
    fn trims_only_the_columns_libraw_left_behind() {
        // RX100M3: eight columns short of the raw width, so the trailing inset is
        // eight narrower than the raw frame suggests.
        let rx100 = Window {
            raw_width: 5504,
            raw_height: 3672,
            left_margin: 0,
            top_margin: 0,
            width: 5496,
            height: 3672,
            cleft: 12,
            ctop: 12,
            cwidth: 5472,
            cheight: 3648,
        };
        assert_eq!(insets(&rx100), (12, 12, 12, 12));
    }

    #[test]
    fn takes_nothing_from_a_body_that_declares_no_crop() {
        let unset = Window {
            raw_width: 6048,
            raw_height: 4024,
            left_margin: 0,
            top_margin: 0,
            width: 6024,
            height: 4024,
            cleft: UNSET,
            ctop: UNSET,
            cwidth: 6000,
            cheight: 4000,
        };
        assert_eq!(insets(&unset), (0, 0, 0, 0));
    }

    #[test]
    fn halves_insets_without_going_negative() {
        let halved = halve_insets(Insets { left: 7, top: 3, right: 9, bottom: 1 });
        assert_eq!((halved.left, halved.top, halved.right, halved.bottom), (3, 1, 4, 0));
    }
}
