// The grids a photograph's stacking descriptor is ranked from, accumulated in one pass over the
// frame's own bytes.
//
// **The sums are integers, and that is what makes a stored descriptor comparable.** A descriptor is
// written to the catalogue and matched against ones written months earlier, so two describes of one
// frame have to agree to the bit. A sample is a byte, so a cell's channel sum is a sum of bytes:
// exact, and the same number whichever order it was added up in. An f32 accumulation is neither,
// and `rank_normalize` downstream spreads whatever ordering it is handed across the whole byte
// range, so a last-bit disagreement is a full-scale one by the time it is stored.
//
// **One grid a view.** The coarse grid the alignment search runs on is that grid folded two by two
// on the host: `(x * COARSE) / w` is `(x * GRID) / w` halved for every x while GRID is twice
// COARSE, so the frame is read once rather than at two resolutions. Luma is weighed out of the same
// sums, so the whole descriptor comes off one dispatch.
//
// **A workgroup a cell, reduced in shared memory.** Never an atomic add per pixel into `sums`:
// neighbouring invocations share a cell, and Adreno serialises same-address atomics.
import px;
import times;

struct Params {
    /// The frame as stored, which `orientation` turns upright.
    int width;
    int pixels;
    /// Cells along one edge, which is `stacks::GRID`.
    int cells;
    /// EXIF's 1 to 8.
    int orientation;
    /// The upright frame's rectangle: left, top, width, height.
    int x0;
    int y0;
    int w;
    int h;
    /// The rectangle the second view keeps, in the same four.
    int crop_x0;
    int crop_y0;
    int crop_w;
    int crop_h;
};
[vk::binding(20, 0)] ConstantBuffer<Params> pc;

/// Interleaved 8-bit RGB, four samples to a word.
[vk::binding(0, 0)] StructuredBuffer<uint> frame;
/// `cells * cells * 3` sums a view, red green and blue interleaved, the crop's grid after the
/// whole frame's.
[vk::binding(1, 0)] RWStructuredBuffer<uint> sums;

static const uint LANES = 64;

groupshared uint3 partial[LANES];

uint sample_at(int index)
{
    return (frame[index >> 2] >> uint(8 * (index & 3))) & 0xffu;
}

/// Where the upright frame's `(u, v)` is stored.
int2 stored_at(int u, int v)
{
    let w = pc.width;
    let h = pc.pixels / pc.width;
    switch (pc.orientation) {
    case 2: return int2(w - 1 - u, v);
    case 3: return int2(w - 1 - u, h - 1 - v);
    case 4: return int2(u, h - 1 - v);
    case 5: return int2(v, u);
    case 6: return int2(v, h - 1 - u);
    case 7: return int2(w - 1 - v, h - 1 - u);
    case 8: return int2(w - 1 - v, u);
    default: return int2(u, v);
    }
}

/// The first of `extent` places whose cell, `(place * cells) / extent`, is `cell` or later.
int cell_start(int cell, int extent)
{
    return (cell * extent + pc.cells - 1) / pc.cells;
}

[shader("compute")]
[numthreads(64, 1, 1)]
void stacks_cells(uint3 group : SV_GroupID, uint lane : SV_GroupIndex)
{
    let cropped = group.z == 1;
    let left = cropped ? pc.crop_x0 : pc.x0;
    let top = cropped ? pc.crop_y0 : pc.y0;
    let w = cropped ? pc.crop_w : pc.w;
    let h = cropped ? pc.crop_h : pc.h;

    let x0 = left + cell_start(int(group.x), w);
    let y0 = top + cell_start(int(group.y), h);
    let across = left + cell_start(int(group.x) + 1, w) - x0;
    let count = across * (top + cell_start(int(group.y) + 1, h) - y0);

    var sum = uint3(0);
    for (var k = int(lane); k < count; k += int(LANES)) {
        let at = stored_at(x0 + k % across, y0 + k / across);
        let i = int(wide_at<Output>(uint(at.x), uint(at.y), measured<Output>(uint(pc.width))) * 3);
        sum += uint3(sample_at(i), sample_at(i + 1), sample_at(i + 2));
    }
    partial[lane] = sum;
    GroupMemoryBarrierWithGroupSync();
    for (uint stride = LANES / 2; stride > 0; stride = stride / 2) {
        if (lane < stride) { partial[lane] = partial[lane] + partial[lane + stride]; }
        GroupMemoryBarrierWithGroupSync();
    }
    if (lane == 0) {
        let cell = times(group.z * uint(pc.cells * pc.cells) + group.y * uint(pc.cells) + group.x, 3);
        sums[cell] = partial[0].x;
        sums[cell + 1] = partial[0].y;
        sums[cell + 2] = partial[0].z;
    }
}
