//! The viewer's stage in a TV's window (`gpu::surface_stage`), for the Android shell, which owns
//! the window and calls these from the thread it draws on.

#![expect(unsafe_code)]

use crate::gpu::surface_stage::{Display, Picture, SurfaceStage, measured};
use crate::light::Gain;
use crate::px::Size;
use std::ffi::{c_int, c_void};
use std::ptr::NonNull;

/// A rendition's planes on the device, with its shown size in `width` and `height`; null where
/// the stage does not draw this file, which leaves the page drawing it.
///
/// # Safety
/// `bytes` is `len` readable bytes; `width` and `height` are writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bb_stage_picture(
    bytes: *const u8,
    len: usize,
    width: *mut u32,
    height: *mut u32,
) -> *mut Picture {
    if bytes.is_null() || width.is_null() || height.is_null() {
        return std::ptr::null_mut();
    }
    let bytes = unsafe { std::slice::from_raw_parts(bytes, len) };
    let picture = crate::guard("bb_stage_picture", None, || {
        let gpu = crate::gpu::device()?;
        crate::avif::with_coded(bytes, |coded| Picture::upload(gpu, coded))
            .inspect_err(|refused| crate::warn(&format!("rawshim stage: {refused}")))
            .ok()??
    });
    unsafe { handed(picture, width, height) }
}

/// # Safety
/// `width` and `height` are writable.
unsafe fn handed(picture: Option<Picture>, width: *mut u32, height: *mut u32) -> *mut Picture {
    let Some(picture) = picture else {
        return std::ptr::null_mut();
    };
    let (shown_width, shown_height) = picture.size.raw();
    unsafe {
        *width = shown_width as u32;
        *height = shown_height as u32;
    }
    Box::into_raw(Box::new(picture))
}

/// Opens the device and builds the stage's pipeline for SDR white at scRGB `white`, so the first
/// photo is not drawn behind a compile. 0 when built.
#[unsafe(no_mangle)]
pub extern "C" fn bb_stage_warm(white: f32) -> c_int {
    if !(white > 0.0) {
        return -1;
    }
    crate::guard("bb_stage_warm", -1, || {
        let Some(gpu) = crate::gpu::device() else {
            return -1;
        };
        crate::gpu::surface_stage::pipeline(gpu, Gain::of_ratio(f64::from(white)));
        0
    })
}

/// A picture of `nits` everywhere, as [`bb_stage_picture`] hands one over.
///
/// # Safety
/// `width` and `height` are writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bb_stage_flat(
    nits: f32,
    width: *mut u32,
    height: *mut u32,
) -> *mut Picture {
    if !(nits > 0.0) || width.is_null() || height.is_null() {
        return std::ptr::null_mut();
    }
    let picture = crate::guard("bb_stage_flat", None, || {
        Picture::flat(crate::gpu::device()?, f64::from(nits))
    });
    unsafe { handed(picture, width, height) }
}

/// # Safety
/// `picture` came from [`bb_stage_picture`] and is not used again.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bb_stage_picture_free(picture: *mut Picture) {
    if !picture.is_null() {
        drop(unsafe { Box::from_raw(picture) });
    }
}

/// The window, configured for scRGB; null where it takes none, which leaves the page drawing.
///
/// # Safety
/// `window` is an `ANativeWindow` the caller holds a reference on until [`bb_stage_detach`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bb_stage_attach(
    window: *mut c_void,
    width: u32,
    height: u32,
) -> *mut SurfaceStage {
    let Some(window) = NonNull::new(window) else {
        return std::ptr::null_mut();
    };
    let stage = crate::guard("bb_stage_attach", None, || {
        let gpu = crate::gpu::device()?;
        // SAFETY: the caller's.
        let size = Size::measured(width as usize, height as usize);
        unsafe { SurfaceStage::attach(gpu, window, size) }
            .inspect_err(|refused| crate::warn(&format!("rawshim stage: {refused}")))
            .ok()
    });
    stage.map_or(std::ptr::null_mut(), |stage| Box::into_raw(Box::new(stage)))
}

/// Draws `picture` into the `fit_*` rectangle of the window, resized to `width` by `height` first,
/// rolled onto `headroom` times SDR white with SDR white at scRGB `white`. 0 when shown.
///
/// # Safety
/// `stage` came from [`bb_stage_attach`] and `picture` from [`bb_stage_picture`], both live.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn bb_stage_present(
    stage: *mut SurfaceStage,
    picture: *const Picture,
    width: u32,
    height: u32,
    fit_left: u32,
    fit_top: u32,
    fit_width: u32,
    fit_height: u32,
    headroom: f32,
    white: f32,
) -> c_int {
    // Zero white is the browser's encoding, which a scRGB window would show wrong.
    if stage.is_null() || picture.is_null() || !(white > 0.0) || !(headroom >= 1.0) {
        return -1;
    }
    let display = Display {
        headroom: Gain::of_ratio(f64::from(headroom)),
        white: Gain::of_ratio(f64::from(white)),
    };
    let (stage, picture) = unsafe { (&mut *stage, &*picture) };
    crate::guard("bb_stage_present", -1, || {
        let Some(gpu) = crate::gpu::device() else {
            return -1;
        };
        stage.resize(gpu, Size::measured(width as usize, height as usize));
        let fit = measured(
            fit_left as usize,
            fit_top as usize,
            fit_width as usize,
            fit_height as usize,
        );
        match stage.present(gpu, picture, fit, display) {
            Ok(()) => 0,
            Err(refused) => {
                crate::warn(&format!("rawshim stage: {refused}"));
                -1
            }
        }
    })
}

/// # Safety
/// `stage` came from [`bb_stage_attach`] and is not used again.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bb_stage_detach(stage: *mut SurfaceStage) {
    if !stage.is_null() {
        drop(unsafe { Box::from_raw(stage) });
    }
}
