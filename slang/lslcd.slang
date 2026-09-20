// Luma-chroma demultiplexing, implemented from `docs/lslcd-xtrans-spec.md`.
//
// Section numbers below refer to the specification. It is the normative document; where a comment
// here disagrees with it, it is this file that is wrong.

// The frame, the pattern, the border fill and the margin, shared with RCD. Group 0 is its.
import mosaic;

// Scalars rather than a `float4` or an array, for the reason `mosaic.slang` gives: in the uniform
// address space both carry alignment rules that silently change the struct's size, and the host
// writes these bytes by hand.
struct Params {
    // The one-dimensional prototype's radius, which is what `Shape::margin` is (§3.1).
    uint radius;
    // `1/K1` and `1/K2` (§2.3), the mean squares each estimate is divided by.
    float k1_inv;
    float k2_inv;
    // `q/2N` and `p/N`, the two weights §2.2's inverse is written with - and, negated for green,
    // the two values `w1` takes.
    float chroma_gain;
    float green_gain;
    uint _pad0;
    uint _pad1;
    uint _pad2;
};

[vk::binding(0, 1)] ConstantBuffer<Params> params;
/// The symmetric prototype's half-kernel, centre first (§3).
[vk::binding(1, 1)] StructuredBuffer<float> taps;
/// Both modulated signals after the horizontal pass, interleaved.
[vk::binding(2, 1)] RWStructuredBuffer<float> mid;
/// Both chroma estimates after the vertical pass, still scaled by their own `K`.
[vk::binding(3, 1)] RWStructuredBuffer<float> chroma;
[vk::binding(4, 1)] RWStructuredBuffer<float> rgb;

/// `w1` and `w2` at a site (§2.3).
///
/// Derived rather than tabulated: `w1` is `q/2N` at red and blue and `-p/N` at green, and those are
/// the same two numbers §2.2's inverse is written with, so a table of them would be the uniform's
/// own contents copied into a buffer and kept in step by hand.
float2 masks(int r, int c)
{
    let colour = colour_at(r, c);
    let w1 = select(colour == 1, -params.green_gain, params.chroma_gain);
    let w2 = select(colour == 0, 0.5, select(colour == 2, -0.5, 0.0));
    return float2(w1, w2);
}

// ---------------------------------------------------------------------------
// Stage 1: modulate and filter across (§4.1)
// ---------------------------------------------------------------------------

/// The mosaic multiplied by each mask and low-passed along the row.
///
/// Multiplying by `w1` demodulates every carrier `C1` rides on down to baseband, which is what the
/// filter then keeps; the three cross terms §2.5 names all land away from baseband and are what it
/// rejects. Both masks in one traversal because they read the same neighbours.
[shader("compute")]
[numthreads(8, 8, 1)]
void modulate_h(uint3 gid : SV_DispatchThreadID)
{
    let c = int(gid.x);
    let r = int(gid.y);
    if (gid.x >= shape.width || gid.y >= shape.height) { return; }

    let reach = int(params.radius);
    float2 total = float2(0.0);
    for (int i = -reach; i <= reach; i++) {
        let tap = taps[uint(abs(i))];
        total += tap * sample(r, c + i) * masks(r, c + i);
    }

    let at = index(r, c) * 2;
    mid[at] = total.x;
    mid[at + 1] = total.y;
}

// ---------------------------------------------------------------------------
// Stage 2: filter down (§4.2)
// ---------------------------------------------------------------------------

/// The same prototype along the column. Separable because every carrier has at least one axis the
/// one-dimensional nulls reach (§2.4), which is the whole reason this is two passes of thirteen taps
/// rather than one of a hundred and sixty-nine.
[shader("compute")]
[numthreads(8, 8, 1)]
void filter_v(uint3 gid : SV_DispatchThreadID)
{
    let c = int(gid.x);
    let r = int(gid.y);
    if (gid.x >= shape.width || gid.y >= shape.height) { return; }

    let reach = int(params.radius);
    float2 total = float2(0.0);
    for (int i = -reach; i <= reach; i++) {
        let tap = taps[uint(abs(i))];
        let from = index(r + i, c) * 2;
        total += tap * float2(mid[from], mid[from + 1]);
    }

    let at = index(r, c) * 2;
    chroma[at] = total.x;
    chroma[at + 1] = total.y;
}

// ---------------------------------------------------------------------------
// Stage 3: luma by subtraction, and the colours (§2.5, §2.2, §5)
// ---------------------------------------------------------------------------

[shader("compute")]
[numthreads(8, 8, 1)]
void assemble(uint3 gid : SV_DispatchThreadID)
{
    let c = int(gid.x);
    let r = int(gid.y);
    if (gid.x >= shape.width || gid.y >= shape.height) { return; }
    let at = index(r, c);

    float3 out;
    if (interior(r, c, int(shape.margin))) {
        let c1 = chroma[at * 2] * params.k1_inv;
        let c2 = chroma[at * 2 + 1] * params.k2_inv;
        let w = masks(r, c);

        // §2.5. Luma by subtraction and not by a low-pass of its own: the sensor spends most of its
        // photosites collecting luminance detail, and an estimate that smoothed it would throw away
        // exactly what they were spent on. What the filter failed to capture stays here as detail
        // rather than leaving as a colour error.
        let luma = sample(r, c) - c1 * w.x - c2 * w.y;

        out = float3(
            luma + params.chroma_gain * c1 + 0.5 * c2,
            luma - params.green_gain * c1,
            luma + params.chroma_gain * c1 - 0.5 * c2);
    } else {
        out = filled_margin(r, c);
    }

    rgb[at * 3] = out.x;
    rgb[at * 3 + 1] = out.y;
    rgb[at * 3 + 2] = out.z;
}
