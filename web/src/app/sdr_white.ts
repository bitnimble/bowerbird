/**
 * Where SDR white sits, in nits (ITU-R BT.2408).
 *
 * PQ is absolute: its codes name luminances rather than a fraction of a display's, so
 * something has to say which luminance the surface's 1.0 means. 203 is not a guess - it is
 * the same constant the renderer writes its own uniform with, measured there against Chrome
 * and Safari showing a real PQ AVIF (`gpu.rs`, `docs/raw-edit-gpu.md` §7.1).
 */
export const SDR_WHITE_NITS = 203;
