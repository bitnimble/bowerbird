// Phase 6: the sixteen transform phases averaged back into one picture.
//
// Stride-1 blocks mean every pixel is covered by four of them; averaging those is what makes
// the shrinkage look like a filter rather than a tiling. The half-res copy taken here is the
// guide the chroma upsample reads.
//
// **Weighted by phase rather than averaged plainly, deliberately.** The
// inverse pairs this plane with chroma that exists only at site phase, so whatever the
// average mixes across a luma step the chroma cannot cancel: a hard edge comes back with
// ±¼ of its GAT-domain step printed on the two adjacent rows, alternating with CFA row
// parity - a one-pixel interlaced stripe along every silhouette. Anchoring the average on
// the phase the site's chroma belongs to keeps the noise-pooling in the flat (the space is
// normalised to σ = 1, and phases there sit within a σ or two of each other) and collapses
// to the exact inverse at an edge, where averaging was only ever mixing.

[vk::binding(0, 0)] StructuredBuffer<float> l_cs_den;
[vk::binding(1, 0)] RWStructuredBuffer<float> l_pixel;
[vk::binding(2, 0)] RWStructuredBuffer<float> l_h_den;

struct Push {
    int width;
    int height;
    int halfwidth;
    /// Whether Phase 3 blocked the frame at all. Off a 2x2 transform there are four estimates of
    /// every pixel to pool; off the subtraction the other patterns take there is one, and the
    /// average below would be a box blur with nothing to undo it.
    int blocked;
};
[vk::binding(20, 0)] ConstantBuffer<Push> pc;

// In σ units. Noise keeps phases within ~2, so they still pool; a step worth shrinking a
// stripe over is tens to hundreds.
static const float PHASE_BW = 4.0;

/// Whether the phases pool at all. Off takes the site's own block alone, which is the exact
/// inverse of Phase 3 at every pixel.
[vk::constant_id(0)]
const int PHASE_POOL = 1;

[shader("compute")]
[numthreads(16, 16, 1)]
void lpixel_lh_den_fused(uint3 id : SV_DispatchThreadID)
{
    let fx = int(id.x);
    let fy = int(id.y);
    if (fx >= pc.width || fy >= pc.height) { return; }

    let own = l_cs_den[fy * pc.width + fx];
    if (pc.blocked == 0) {
        l_pixel[fy * pc.width + fx] = own;
        if ((fy & 1) == 0 && (fx & 1) == 0) {
            l_h_den[(fy >> 1) * pc.halfwidth + (fx >> 1)] = own;
        }
        return;
    }
    // The site's own phase: the block whose chroma the inverse will add back at this pixel.
    let sx = fx - (fx & 1);
    let sy = fy - (fy & 1);
    let anchor = l_cs_den[sy * pc.width + sx];
    let inv_2bw_sq = 1.0 / (2.0 * PHASE_BW * PHASE_BW);

    // **One answer per site, over blocks symmetric about it.** Pooling each pixel over the four
    // blocks that cover it gives the four pixels of a site four different neighbourhoods, so
    // wherever texture weighs them unevenly the pooling itself varies at the pixel's pitch - a
    // crosshatch over skin. The blocks at site offsets -1, 0 and +1 are centred a pixel either side
    // of the site's own centre, so this has no phase to vary with.
    var sum = 0.0;
    var wsum = 0.0;
    for (int dy = -1; dy <= 1; dy++) {
        let y = sy + dy;
        if (y < 0 || y >= pc.height) { continue; }
        for (int dx = -1; dx <= 1; dx++) {
            let x = sx + dx;
            if (x < 0 || x >= pc.width) { continue; }
            let v = l_cs_den[y * pc.width + x];
            let d = v - anchor;
            let w = float((2 - abs(dy)) * (2 - abs(dx))) * exp(-d * d * inv_2bw_sq);
            sum += w * v;
            wsum += w;
        }
    }
    // The anchor is always one of the candidates at weight four, so `wsum >= 4`.
    l_pixel[fy * pc.width + fx] = PHASE_POOL != 0 ? sum / wsum : anchor;

    if ((fy & 1) == 0 && (fx & 1) == 0) {
        l_h_den[(fy >> 1) * pc.halfwidth + (fx >> 1)] = own;
    }
}
