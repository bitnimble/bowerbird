// A drawn frame carried from the GPU thread to a canvas the page owns, for WebKit (`stage_readback.ts`).
//
// WebKit caps what a transferred canvas may show at the headroom of its default HDR image content,
// 1000 nits over 203, whatever the display reaches; a canvas the page draws itself is not capped.
// So past that the worker draws into a texture, `pack`s it to RGB9E5 - four bytes a pixel, half of
// what `rgba16float` would cross the thread boundary as - and the page uploads the words into an
// `rgb9e5ufloat` texture and `blit`s it onto its own canvas.
//
// RGB9E5 holds no alpha and no sign, so only an opaque frame crosses this way, and a component the
// canvas's primaries put below zero arrives at zero: the display clips it there anyway.
import stage_shared;

struct Size {
    uint width;
    uint height;
};

[vk::binding(0, 0)] Texture2D<float4> drawn;
[vk::binding(1, 0)] RWStructuredBuffer<uint> packed;
[vk::binding(2, 0)] ConstantBuffer<Size> size;
[vk::binding(3, 0)] Texture2D<float4> picture;

/// The largest value RGB9E5 holds: nine bits of mantissa at the top exponent.
static const float RGB9E5_MAX = 65408.0;

uint rgb9e5_of(float3 colour)
{
    let held = clamp(colour, float3(0.0), float3(RGB9E5_MAX));
    let largest = max(held.r, max(held.g, held.b));
    var exponent = max(-16, int(floor(log2(max(largest, 1e-30))))) + 16;
    var step = exp2(float(exponent - 24));
    // Rounding the largest up past nine bits is what the next exponent is for.
    if (floor(largest / step + 0.5) >= 512.0) {
        exponent = exponent + 1;
        step = step * 2.0;
    }
    let mantissa = uint3(floor(held / step + 0.5));
    return mantissa.r | (mantissa.g << 9) | (mantissa.b << 18) | (uint(exponent) << 27);
}

[shader("compute")]
[numthreads(16, 16, 1)]
void pack(uint3 id : SV_DispatchThreadID)
{
    if (id.x >= size.width || id.y >= size.height) { return; }
    packed[id.y * size.width + id.x] = rgb9e5_of(drawn.Load(int3(int2(id.xy), 0)).rgb);
}

[shader("vertex")]
Drawn vertex(uint at : SV_VertexID)
{
    return drawn_at(at);
}

/// The texture onto a canvas of its own size, a pixel to a pixel.
[shader("fragment")]
float4 blit(Drawn drawn) : SV_Target
{
    return float4(picture.Load(int3(int2(drawn.position.xy), 0)).rgb, 1.0);
}
