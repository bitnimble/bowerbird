// BT.2020 video range both ways: a rendition's YUV samples as the PQ signal they code
// (`pq_of_video`), and a PQ signal as those samples (`video_of_pq`).
//
// The viewer's stage draws a rendition's planes and `planes.slang` turns them into the codes the
// editor opens, and a picture shown in one and printed in the other has to be the same picture.
// `pq420.slang` goes the other way, coding the editor's frame as Firefox's video.
module video_range;

import light;
import prelude;

/// Ten-bit video range. A twelve-bit frame's are four times these, so its caller divides the sample
/// rather than a second set of constants existing to be kept in step.
public static const float LUMA_FLOOR = 64.0;
public static const float LUMA_SPAN = 876.0;
public static const float CHROMA_MID = 512.0;

/// Ten-bit video range quantises chroma as `896 * C + 512`, and C spans +-0.5 rather than +-1.
///
/// So this is the whole span and not the half one the code range (64..960) suggests: halving it
/// doubles every chroma, which is a picture with the hues and the white intact and twice the
/// saturation. Checked against ffmpeg's decode of a real render, where 896 is exact to 0.0% on all
/// three channels and 448 is out by 15-65%.
public static const float CHROMA_SPAN = 896.0;

/// BT.2020 non-constant luminance, which is what the encoder wrote.
static const float3x3 YUV_TO_RGB = float3x3(
    1.0,  0.0,          1.4746,
    1.0, -0.16455313,  -0.57135313,
    1.0,  1.8814,       0.0);

/// One pixel's luma and chroma samples, on the ten-bit scale, as its PQ signal.
public Colour<Pq> pq_of_video(float3 yuv)
{
    let level = (yuv.x - LUMA_FLOOR) / LUMA_SPAN;
    let blue = (yuv.y - CHROMA_MID) / CHROMA_SPAN;
    let red = (yuv.z - CHROMA_MID) / CHROMA_SPAN;
    return measured<Pq>(clamp(mul(YUV_TO_RGB, float3(level, blue, red)), float3(0.0), float3(1.0)));
}

/// The way there: a PQ signal as one pixel's luma and chroma on the ten-bit scale, unrounded so a
/// caller can average chroma before it quantises.
public float3 video_of_pq(Colour<Pq> signal)
{
    let rgb = signal.v;
    let level = dot(LUMA, rgb);
    let blue = (rgb.b - level) / (2.0 * (1.0 - LUMA.b));
    let red = (rgb.r - level) / (2.0 * (1.0 - LUMA.r));
    return float3(LUMA_FLOOR + LUMA_SPAN * level, CHROMA_MID + CHROMA_SPAN * blue, CHROMA_MID + CHROMA_SPAN * red);
}
