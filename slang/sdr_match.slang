// How a platform shows a PQ video's SDR range, which the copies and video frames made for it
// match (`sdr_match::SdrMatch`): SDR white at `white` nits and, where `reads_sdr_as_power`, the
// picture under it as Firefox on macOS shows the SDR beside a video, through a 2.2 power where the
// sRGB curve made it.
module sdr_match;
import light;
import prelude;

static const float SDR_READ_POWER = 2.2;

/// `whites`, Rec.2020 light in SDR whites, as the nits a video for the platform codes it at.
public Colour<DisplayNits> matched(float3 whites, Light<DisplayNits> white, uint reads_sdr_as_power)
{
    return measured<DisplayNits>(float3(
        matched_channel(whites.r, white, reads_sdr_as_power).v,
        matched_channel(whites.g, white, reads_sdr_as_power).v,
        matched_channel(whites.b, white, reads_sdr_as_power).v));
}

public Light<DisplayNits> matched_channel(float whites, Light<DisplayNits> white, uint reads_sdr_as_power)
{
    if (reads_sdr_as_power == 0u || whites >= 1.0) { return measured<DisplayNits>(whites * white.v); }
    return measured<DisplayNits>(pow(srgb_oetf(max(whites, 0.0)), SDR_READ_POWER) * white.v);
}
