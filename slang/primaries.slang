// Every change of primaries the pipeline makes, as the 3x3 it is in linear light.
//
// A conversion is a property of the two colour spaces and of nothing that dispatches it, so it is
// stated once here and imported - where a copy in each shader that needs one is free to be rounded
// to a different number of places, and the editor's picture and the viewer's then differ by it.
//
// Row-major, as `float3x3` takes it and as the Rust side holds it. The host derives each of these
// from chromaticities or from its own XYZ tables, and every literal below is held against what it
// derives: `the_primaries_match_the_host` for the gamut rotations,
// `the_cone_matrices_are_what_they_are_derived_from` for the Bradford three.
module primaries;

/// Rec.2020 to Display P3, both D65, applied in linear light. Rows sum to 1.
public static const float3x3 R2020_TO_P3 = float3x3(
     1.343578,  -0.282180,  -0.061399,
    -0.065297,   1.075788,  -0.010490,
     0.002822,  -0.019598,   1.016777);

/// Rec.2020 to sRGB.
///
/// A draw targets P3 because that is what a display is; a file targets sRGB because that is what
/// everything reads it as. sRGB and BT.709 share primaries and differ only in transfer, so this is
/// the SDR rendition's rotation as well as the soft proof's.
public static const float3x3 R2020_TO_SRGB = float3x3(
     1.663467,  -0.587548,  -0.072838,
    -0.125523,   1.132926,  -0.008350,
    -0.018099,  -0.100603,   1.118998);

/// The way back, which is how a colour clipped to what sRGB holds reaches a Display P3 canvas:
/// through `R2020_TO_P3`, there being no route straight across.
public static const float3x3 SRGB_TO_R2020 = float3x3(
     0.627504,   0.329275,   0.043303,
     0.069108,   0.919519,   0.011360,
     0.016394,   0.088011,   0.895380);

/// XYZ to the Bradford cone responses, and Rec.2020 linear to the same, and back.
///
/// The space an illuminant change is a *diagonal* in - three gains rather than nine terms - and
/// sharpened cones rather than plain XYZ because that is what makes the diagonal a good
/// approximation: von Kries in XYZ moves saturated colours visibly.
public static const float3x3 XYZ_TO_CONE = float3x3(
     0.895100,   0.266400,  -0.161400,
    -0.750200,   1.713500,   0.036700,
     0.038900,  -0.068500,   1.029600);

public static const float3x3 R2020_TO_CONE = float3x3(
     0.641020,   0.305534,  -0.004280,
    -0.028459,   1.054288,   0.013857,
     0.006822,  -0.011914,   1.094898);

public static const float3x3 CONE_TO_R2020 = float3x3(
     1.540081,  -0.446186,   0.011667,
     0.041693,   0.936292,  -0.011687,
    -0.009142,   0.012968,   0.913128);
