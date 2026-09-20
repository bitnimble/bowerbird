// The frame's nits, box-averaged to the camera match's own supervision footprint.
//
// The colour fit teaches the chroma lattice on block means - one pair per pixel of a
// 1280-wide grid over the photograph - and at those means it is measured correct. Read per
// render pixel instead, the lattice meets colours the fit never saw: texture spreads a
// block's pixels across cells whose operators differ, and the mean of the corrected
// pixels is not the correction of the mean. On a lit skin transition that gap is a mauve
// patch the camera's own rendering does not have. `matched_nits` therefore reads the
// lattice *at* this average and applies the operator to the pixel itself, which makes the
// block means of the two renderings agree by construction.
//
// Through `nits_of_code`, not a host-side decode: the grade has one implementation (21.1),
// and this average has to sit exactly where the grade's own reads sit.
import packed;

struct Push {
    uint width;
    uint height;
    /// The supervision footprint in this frame's pixels: the photograph's long edge over
    /// the fit grid's, scaled to however much of the photograph this frame holds.
    uint block;
    /// Where the frame starts inside its photograph-anchored block, per axis: the blocks
    /// partition the *photograph*, so a window whose origin is not a block multiple opens
    /// with a partial cell. Anchored there so a tile and the whole render average the same
    /// pixels into every cell they share.
    uint phase_x;
    uint phase_y;
};

[vk::binding(20, 0)] ConstantBuffer<Push> pc;
[vk::binding(1, 0)] StructuredBuffer<uint> frame;
[vk::binding(12, 0)] StructuredBuffer<float> nits_of_code;
[vk::image_format("rgba16f")]
[vk::binding(19, 0)] WTexture2D<float4> mean_frame;

[shader("compute")]
[numthreads(8, 8, 1)]
void mean(uint3 id : SV_DispatchThreadID)
{
    let cells = uint2(
        (pc.width + pc.phase_x + pc.block - 1) / pc.block,
        (pc.height + pc.phase_y + pc.block - 1) / pc.block);
    if (id.x >= cells.x || id.y >= cells.y) { return; }
    let y0 = max(id.y * pc.block, pc.phase_y) - pc.phase_y;
    let y1 = min((id.y + 1) * pc.block - pc.phase_y, pc.height);
    let x0 = max(id.x * pc.block, pc.phase_x) - pc.phase_x;
    let x1 = min((id.x + 1) * pc.block - pc.phase_x, pc.width);
    var sum = float3(0.0);
    var count = 0.0;
    for (uint y = y0; y < y1; y++) {
        for (uint x = x0; x < x1; x++) {
            let base = (y * pc.width + x) * 3;
            sum += float3(
                nits_of_code[half_of(frame[base / 2], base)],
                nits_of_code[half_of(frame[(base + 1) / 2], base + 1)],
                nits_of_code[half_of(frame[(base + 2) / 2], base + 2)]);
            count += 1.0;
        }
    }
    mean_frame.Store(id.xy, float4(sum / max(count, 1.0), 1.0));
}
