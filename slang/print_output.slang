// A print file's pixels: the print grade brought inside the target the printer is sent, then
// coded as that target's file holds it - an sRGB or Adobe RGB file by its own transfer, a
// printer's device RGB through the table its profile was baked into.
module print_output;

import prelude;
import primaries;
import gamut_map;
import print_scene;

/// `printer_gamut::device_table`: the printer's device RGB over a grid of linear Rec.2020, each
/// axis coded by `LUT_GAMMA` so the shadows get as many nodes as the lights.
[vk::binding(6, 1)] Texture3D<float4> print_device_lut;
[vk::binding(7, 1)] SamplerState print_device_sampler;

public static const uint LUT_STEPS = 65;
public static const float LUT_GAMMA = 2.4;

/// Adobe RGB (1998)'s transfer, 563/256.
static const float ADOBE_GAMMA = 2.19921875;

/// `signal`, a share of the target's white in Rec.2020, as the codes a print file holds of it,
/// 0 to `top`.
public float3 print_coded(float3 signal, uint intent, bool compensated, float top)
{
    let laid = onto_black(target_mapped(signal, intent), target_black(), compensated);
    var coded = float3(0.0);
    switch (target_kind()) {
    case TARGET_PROFILE: {
        let node = pow(saturate(laid), float3(1.0 / LUT_GAMMA)) * float(LUT_STEPS - 1);
        coded = print_device_lut.SampleLevel(print_device_sampler, (node + 0.5) / float(LUT_STEPS), 0.0).rgb;
        break;
    }
    case TARGET_ADOBE_RGB: {
        coded = pow(saturate(mul(R2020_TO_ADOBE_RGB, laid)), float3(1.0 / ADOBE_GAMMA));
        break;
    }
    default: {
        let linear = saturate(mul(R2020_TO_SRGB, laid));
        coded = float3(srgb_oetf(linear.r), srgb_oetf(linear.g), srgb_oetf(linear.b));
        break;
    }
    }
    return round(saturate(coded) * top);
}
