// A rendition's YUV samples as the PQ signal they code: BT.2020 video range undone.
//
// The viewer's stage draws a rendition's planes and `planes.slang` turns them into the codes the
// editor opens, and a picture shown in one and printed in the other has to be the same picture.
module video_range;

import light;

/// Ten-bit video range. A twelve-bit frame's are four times these, so its caller divides the sample
/// rather than a second set of constants existing to be kept in step.
static const float LUMA_FLOOR = 64.0;
static const float LUMA_SPAN = 876.0;
static const float CHROMA_MID = 512.0;

/// Ten-bit video range quantises chroma as `896 * C + 512`, and C spans +-0.5 rather than +-1.
///
/// So this is the whole span and not the half one the code range (64..960) suggests: halving it
/// doubles every chroma, which is a picture with the hues and the white intact and twice the
/// saturation. Checked against ffmpeg's decode of a real render, where 896 is exact to 0.0% on all
/// three channels and 448 is out by 15-65%.
static const float CHROMA_SPAN = 896.0;

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
