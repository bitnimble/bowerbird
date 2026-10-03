// A print file's pixels: the print grade brought inside the target the printer is sent, then
// coded as that target's file holds it - an sRGB or Adobe RGB file by its own transfer, a
// printer's device RGB through the table its profile was baked into.
module print_output;

import prelude;
import primaries;
import gamut_map;
import print_scene;

/// `printer_gamut::device_table`: the printer's device RGB over a grid of linear Rec.2020, each
/// axis coded by `LUT_GAMMA` so the shadows get as many nodes as the lights. `rgba32float`,
/// loaded a node at a time: a sixteen-bit file would show the half float's steps near white.
[vk::binding(6, 1)] Texture3D<float4> print_device_lut;

public static const uint LUT_STEPS = 65;
public static const float LUT_GAMMA = 2.4;

/// Adobe RGB (1998)'s transfer, 563/256.
static const float ADOBE_GAMMA = 2.19921875;

float3 device_node(int3 at)
{
    return print_device_lut.Load(int4(at, 0)).rgb;
}

/// `laid`, linear Rec.2020 inside the printer's gamut, as the device RGB its table interpolates.
float3 device_coded(float3 laid)
{
    let node = pow(saturate(laid), float3(1.0 / LUT_GAMMA)) * float(LUT_STEPS - 1);
    let low = min(int3(floor(node)), int3(int(LUT_STEPS) - 2));
    let t = node - float3(low);
    let x00 = lerp(device_node(low), device_node(low + int3(1, 0, 0)), t.x);
    let x10 = lerp(device_node(low + int3(0, 1, 0)), device_node(low + int3(1, 1, 0)), t.x);
    let x01 = lerp(device_node(low + int3(0, 0, 1)), device_node(low + int3(1, 0, 1)), t.x);
    let x11 = lerp(device_node(low + int3(0, 1, 1)), device_node(low + int3(1, 1, 1)), t.x);
    return lerp(lerp(x00, x10, t.y), lerp(x01, x11, t.y), t.z);
}

/// `signal`, a share of the target's white in Rec.2020, as the codes a print file holds of it,
/// 0 to `top`.
public float3 print_coded(float3 signal, uint intent, bool compensated, float top)
{
    let laid = onto_black(target_mapped(signal, intent), target_black(), compensated);
    var coded = float3(0.0);
    switch (target_kind()) {
    case TARGET_PROFILE: {
        coded = device_coded(laid);
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
