// The grids a photograph's stacking descriptor is ranked from, accumulated in one pass over the
// frame's own bytes.
//
// **The sums are integers, and that is what makes a stored descriptor comparable.** A descriptor is
// written to the catalogue and matched against ones written months earlier, so two describes of one
// frame have to agree to the bit. A sample is a byte, so a cell's channel sum is a sum of bytes:
// exact, and the same number whichever order the invocations happened to reach the cell in. An f32
// accumulation is neither, and `rank_normalize` downstream spreads whatever ordering it is handed
// across the whole byte range, so a last-bit disagreement is a full-scale one by the time it is
// stored.
//
// **One grid a view.** The coarse grid the alignment search runs on is that grid folded two by two
// on the host: `(x * COARSE) / w` is `(x * GRID) / w` halved for every x while GRID is twice
// COARSE, so the frame is read once rather than at two resolutions. Luma is weighed out of the same
// sums, so the whole descriptor comes off one dispatch.
import lanes;

struct Params {
    int width;
    int pixels;
    /// Cells along one edge, which is `stacks::GRID`.
    int cells;
    int pad0;
    /// The whole frame's rectangle: left, top, width, height.
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
[vk::binding(1, 0)] RWStructuredBuffer<Atomic<uint> > sums;

uint sample_at(int index)
{
    return (frame[index >> 2] >> uint(8 * (index & 3))) & 0xffu;
}

void gather(int base, int x, int y, int left, int top, int w, int h, uint3 rgb)
{
    if (x < left || y < top || x >= left + w || y >= top + h) { return; }
    let gx = ((x - left) * pc.cells) / w;
    let gy = ((y - top) * pc.cells) / h;
    let cell = base + (gy * pc.cells + gx) * 3;
    sums[cell].add(rgb.x);
    sums[cell + 1].add(rgb.y);
    sums[cell + 2].add(rgb.z);
}

[shader("compute")]
[numthreads(64, 1, 1)]
void stacks_cells(uint3 id: SV_DispatchThreadID)
{
    let at = linear(id);
    if (at >= uint(pc.pixels)) { return; }

    let pixel = int(at);
    let i = pixel * 3;
    let rgb = uint3(sample_at(i), sample_at(i + 1), sample_at(i + 2));
    let y = pixel / pc.width;
    let x = pixel - y * pc.width;

    gather(0, x, y, pc.x0, pc.y0, pc.w, pc.h, rgb);
    let crop = pc.cells * pc.cells * 3;
    gather(crop, x, y, pc.crop_x0, pc.crop_y0, pc.crop_w, pc.crop_h, rgb);
}
