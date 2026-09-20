// Dividing a sensor particle's shadow back out of the mosaic.
//
// **Multiplicative, so the scene under the shadow survives.** A particle a millimetre off the
// photosites is an out-of-focus attenuator rather than an occluder: what reaches a covered
// photosite is the real radiance times some beta below one, and `sample / beta` recovers it.
// Inpainting the disc would throw that detail away and draw a plausible replacement.
//
// **On the mosaic, above the demosaic and the sharpen**, which is what makes the correction whole:
// the attenuation is achromatic and pre-interpolation, so a spot here is one number per photosite,
// where the same spot after RCD is three that disagree and after the sharpen wears a ring.
//
// One workgroup per spot rather than a pass over the frame. A dispatch over 24M photosites that
// tested every one against two hundred particles is 4.8 billion rejections to correct about two
// percent of the picture, and on a software adapter that is seconds. `dust::detect` drops a spot
// whose footprint overlaps a deeper one's, so no two workgroups can reach the same photosite and
// the read-modify-write below needs no atomic.

import px;

/// Profile samples per spot, spanning `SPAN` elliptical radii. `dust::BINS`.
static const uint BINS = 14;
/// How far out the stored profile reaches, in blob radii. `dust::SPAN`.
static const Extent<BlobRadius> SPAN = { 2.5 };
/// Floats per spot: the ellipse, the gate's numbers, then the profile. `dust::SPOT_WORDS`.
///
/// Derived rather than written out, because a literal here goes stale silently: the search writes
/// `8 + BINS` words a spot, so a wider profile would leave this indexing short and every correction
/// would read its bins out of the next spot's header.
static const uint SPOT_WORDS = 8 + BINS;

struct Params {
    /// The window being corrected, in photosites.
    uint width;
    uint height;
    /// Where that window sits on the sensor, which is the space the spots are in.
    uint left;
    uint top;
    uint spots;
    /// Spots below this are left alone, which is the whole of what the sensitivity slider moves.
    /// Read here rather than filtered into the buffer so moving it costs no upload.
    float min_snr;
    /// Scales the log dip: 1 divides the whole measured shadow out, 0 leaves the picture alone.
    float intensity;
    uint pad0;
};

// **Every binding is spelled out.** Slang assigns them in an order that is not declaration order
// when it is left to, and the host's bind group layout is written by hand against these numbers.
[vk::binding(0, 0)] ConstantBuffer<Params> params;
[vk::binding(1, 0)] StructuredBuffer<float> spots;
[vk::binding(2, 0)] RWStructuredBuffer<float> mosaic;

[shader("compute")]
[numthreads(64, 1, 1)]
void dust(uint3 group : SV_GroupID, uint lane : SV_GroupIndex)
{
    let spot = group.x;
    if (spot >= params.spots) { return; }

    let base = spot * SPOT_WORDS;
    let snr = spots[base + 7];
    if (snr < params.min_snr || params.intensity <= 0.0) { return; }

    // Everything about a spot is in half-resolution quad coordinates, which is where the mosaic was
    // read to find it: one 2x2 CFA site is one sample of the picture the particle is a shadow on.
    let centre = float2(spots[base + 0], spots[base + 1]);
    let scale = spots[base + 2];
    let axes = float2(spots[base + 3], spots[base + 4]);
    let turn = float2(spots[base + 5], spots[base + 6]);

    // The major axis, since the box has to hold the ellipse at whatever angle it sits.
    // Blob radii into pixels, which is the multiplication this unit exists to mark: `axes` is
    // the particle's own, so the same 2.5 is a different reach for every blob on the sensor.
    let reach = SPAN.d * scale * max(axes.x, axes.y);
    let side = uint(ceil(reach)) * 2;
    // One sample of slack each way: the walk is anchored on the centre *truncated* to a photosite, so
    // the far edge of the footprint sits up to a whole sample past `side` from it. Only the outermost
    // bin is at stake, where the profile has fallen to nothing, but a footprint that is asymmetric
    // about its own spot is a needless thing to have to reason about later.
    let box = side * 2 + 3;

    // The footprint's top-left in this window's photosites, which is where the spot's own sensor
    // coordinates become a place in the buffer that was handed over.
    let origin = int2(
        int(centre.x * 2.0) - int(side) - 1 - int(params.left),
        int(centre.y * 2.0) - int(side) - 1 - int(params.top));

    for (uint step = lane; step < box * box; step += 64) {
        let row = int(step / box);
        let col = int(step - uint(row) * box);
        let x = origin.x + col;
        let y = origin.y + row;
        // A spot near an edge has part of its footprint outside the rectangle this call was handed,
        // and a band cut from the middle of a frame has one on both sides.
        if (x < 0 || y < 0 || x >= int(params.width) || y >= int(params.height)) { continue; }

        let quad = float2(
            float(x + int(params.left)) * 0.5 - centre.x,
            float(y + int(params.top)) * 0.5 - centre.y);
        // Into the ellipse's own frame, then to a radius in blob radii. The axes carry unit product,
        // so a round spot collapses to plain distance exactly.
        let turned = float2(
            quad.x * turn.x + quad.y * turn.y,
            -quad.x * turn.y + quad.y * turn.x);
        let radius = length(turned / axes) / scale;
        if (radius >= SPAN.d) { continue; }

        // Between bins rather than at one: a spot spans a few dozen photosites and fourteen steps
        // across it would read as terracing in a smooth sky, which is where these live.
        let along = radius / SPAN.d * float(BINS) - 0.5;
        let bin = clamp(along, 0.0, float(BINS - 1));
        let low = uint(floor(bin));
        let high = min(low + 1, BINS - 1);
        let dip = lerp(spots[base + 8 + low], spots[base + 8 + high], bin - floor(bin));

        let at = uint(y) * params.width + uint(x);
        mosaic[at] *= exp(dip * params.intensity);
    }
}
