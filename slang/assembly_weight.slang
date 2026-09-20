// §5.2's weight: how much of each source a canvas pixel takes.
//
// **Per source, not per tile.** `composite_add` takes one layer and one weight buffer a dispatch,
// so what a source needs is the signed distance to the boundary of the *union* of the tiles that
// picked it - one field a source over the whole window, sign flipped inside. Normalising per tile
// and summing would double-count every seam between two neighbours that picked the same frame; the
// union has no such seam, because the owner does not change across it.
//
// Four entries, driven in order by `assembly_weight.rs`: the owner map, a seed pass a slot, a jump
// flood, and the resolve. The flood is `log2(long edge)` passes of one read per neighbour, which is
// what a distance over a window costs when the seeds are not a shape the host can walk.
//
// The first three run on the window grown by `w_max` on every side and the resolve writes the
// window itself: a seam a pixel outside a window still feathers the pixels inside it, so a grid
// stopping at the window's edge makes a strip that ends on a seam take one frame at full weight
// where the canvas taken whole has half of each.
import lanes;

/// Where no site was found yet. Larger than any distance a window holds.
static const float UNSEEDED = 1e30;

/// `slot` for the pass that measures every owner change at once, which is what `W(x)` is built
/// from: one field, so both sides of a seam read the same width.
static const uint EVERY_SLOT = 0xffffffffu;

/// What `tile_of` reads where no tile of the slot is near enough to name one: the canvas outside
/// every tile, which is the base's own ground and takes no §3.7a correction.
static const uint NO_TILE = 0xffffffffu;

struct Tile {
    /// left, top, right, bottom, in this render's own pixels.
    float4 box;
    uint start;
    uint count;
    /// Which slot of `Assembly::sources_used` this tile's pick is.
    uint slot;
    /// Half this tile's corridor, in this render's pixels, already capped at `W_MAX` and floored
    /// at the high band by the host.
    float width;
};

struct Params {
    /// The grid every pass but the resolve runs on: the window grown by `pad_at` on all four sides.
    uint2 size;
    /// Where that grid starts on the canvas, in this render's own pixels.
    int2 origin;
    uint tiles;
    uint slots;
    /// Which slot this pass is measuring, or `EVERY_SLOT`.
    uint slot;
    /// The jump flood's step, in pixels.
    uint step;
    /// The window itself, which is what the resolve writes and what the gather reads.
    uint2 out_size;
    /// Where the window sits inside the grid.
    uint2 pad_at;
    /// §5.2's ceiling, in this render's pixels: nothing further than this from a seam can move a
    /// weight, so the owner pass stops walking a tile past it.
    float w_max;
    float pad0;
    float pad1;
    float pad2;
};

[vk::binding(0, 0)] ConstantBuffer<Params> params;
[vk::binding(1, 0)] StructuredBuffer<float2> vertices;
[vk::binding(2, 0)] StructuredBuffer<uint> loops;
[vk::binding(3, 0)] StructuredBuffer<Tile> tiles;
/// Which slot owns each pixel, and the width the owning tile asked for.
[vk::binding(4, 0)] RWStructuredBuffer<uint> owner;
[vk::binding(5, 0)] RWStructuredBuffer<float> owner_width;
/// The flood's two halves: `site.xy` in window pixels, `site.z` the width carried from the seed,
/// `site.w` unused. Ping-ponged by the host.
[vk::binding(6, 0)] RWStructuredBuffer<float4> from_;
[vk::binding(7, 0)] RWStructuredBuffer<float4> to_;
/// One f32 a pixel a slot, slot-minor.
[vk::binding(8, 0)] RWStructuredBuffer<float> signed_;
/// One f32 a pixel: §5.2's `W(x)`.
[vk::binding(9, 0)] RWStructuredBuffer<float> width;
/// Which tile holds each pixel of the grid, or `NO_TILE`.
[vk::binding(10, 0)] RWStructuredBuffer<uint> owner_tile;
/// **Which tile of each slot the gather reads that slot through**: one uint an output pixel a slot,
/// slot-minor, beside `signed_`. Inside the slot's union it is the tile the pixel is in; in the
/// corridor outside it, the tile on the far side of the nearest seam, which is the tile this slot is
/// being blended in *from*. `NO_TILE` where the slot has no tile within reach, which is the base
/// over its own ground.
[vk::binding(11, 0)] RWStructuredBuffer<uint> tile_of;

float2 at_of(uint pixel)
{
    return float2(
        float(params.origin.x) + float(pixel % params.size.x) + 0.5,
        float(params.origin.y) + float(pixel / params.size.x) + 0.5);
}

/// Which slot holds this pixel, and the width the tile that holds it asked for.
///
/// **The last tile wins, not the first.** A later tile is on top of whatever it overlaps, so the
/// walk does not break out at the first hit.
[shader("compute")]
[numthreads(64, 1, 1)]
void assembly_owner(uint3 id : SV_DispatchThreadID)
{
    let pixel = linear(id);
    if (pixel >= params.size.x * params.size.y) { return; }
    let p = at_of(pixel);

    // Slot 0 is the base: `Assembly::sources_used` puts it first, and it owns whatever no tile does.
    var held = 0u;
    var held_tile = NO_TILE;
    var held_width = params.w_max;
    for (uint t = 0; t < params.tiles; t = t + 1) {
        let tile = tiles[t];
        if (tile.count < 3) { continue; }
        if (p.x < tile.box.x || p.x > tile.box.z || p.y < tile.box.y || p.y > tile.box.w) {
            continue;
        }
        var within = false;
        for (uint k = 0; k < tile.count; k = k + 1) {
            let a = vertices[loops[tile.start + k]];
            let b = vertices[loops[tile.start + (k + 1) % tile.count]];
            if ((a.y > p.y) != (b.y > p.y)
                && p.x < a.x + (p.y - a.y) / (b.y - a.y) * (b.x - a.x)) {
                within = !within;
            }
        }
        if (within) { held = tile.slot; held_tile = t; held_width = tile.width; }
    }
    owner[pixel] = held;
    owner_tile[pixel] = held_tile;
    owner_width[pixel] = held_width;
}

bool mine(uint pixel)
{
    if (params.slot == EVERY_SLOT) { return false; }
    return owner[pixel] == params.slot;
}

/// A seed at every crossing of the boundary this pass is measuring.
///
/// The site is the **midpoint** of the pixel pair rather than either pixel, which is what makes two
/// unions' distances exact negatives: both sides of a seam seed the same points, so both measure to
/// the same set. A pixel pair is a crossing when the two pixels are on different sides - of this
/// slot's union, or of *any* owner change for the width field.
[shader("compute")]
[numthreads(64, 1, 1)]
void assembly_seed(uint3 id : SV_DispatchThreadID)
{
    let pixel = linear(id);
    if (pixel >= params.size.x * params.size.y) { return; }
    from_[pixel] = float4(0.0, 0.0, 0.0, UNSEEDED);

    let x = pixel % params.size.x;
    let y = pixel / params.size.x;
    let here = mine(pixel);
    for (uint d = 0; d < 2; d = d + 1) {
        let nx = d == 0 ? x + 1 : x;
        let ny = d == 0 ? y : y + 1;
        if (nx >= params.size.x || ny >= params.size.y) { continue; }
        let q = ny * params.size.x + nx;
        let crossing = params.slot == EVERY_SLOT
            ? (owner[q] != owner[pixel])
            : (mine(q) != here);
        if (!crossing) { continue; }
        // The narrower of the two sides, so a seam is feathered by whichever tile had less room.
        let w = min(owner_width[pixel], owner_width[q]);
        from_[pixel] = float4(
            (float(x) + float(nx)) * 0.5,
            (float(y) + float(ny)) * 0.5,
            w,
            0.0);
        return;
    }
}

/// One jump flood step: the nearest site of this pixel and of the eight neighbours `step` away.
[shader("compute")]
[numthreads(64, 1, 1)]
void assembly_flood(uint3 id : SV_DispatchThreadID)
{
    let pixel = linear(id);
    if (pixel >= params.size.x * params.size.y) { return; }
    let x = int(pixel % params.size.x);
    let y = int(pixel / params.size.x);
    let p = float2(float(x), float(y));

    var best = from_[pixel];
    for (int dy = -1; dy <= 1; dy = dy + 1) {
        for (int dx = -1; dx <= 1; dx = dx + 1) {
            let nx = x + dx * int(params.step);
            let ny = y + dy * int(params.step);
            if (nx < 0 || ny < 0 || nx >= int(params.size.x) || ny >= int(params.size.y)) {
                continue;
            }
            let there = from_[uint(ny) * params.size.x + uint(nx)];
            if (there.w >= UNSEEDED) { continue; }
            let d = length(p - there.xy);
            if (best.w >= UNSEEDED || d < best.w) {
                best = float4(there.x, there.y, there.z, d);
            }
        }
    }
    // The distance is recomputed rather than carried, because `best.w` above is this pixel's and
    // the neighbour's is the neighbour's.
    to_[pixel] = best.w >= UNSEEDED ? float4(0.0, 0.0, 0.0, UNSEEDED) : best;
}

/// Which tile of this slot a pixel is read through: its own where it has one, otherwise the tile
/// across the nearest seam.
///
/// **A seed sits between two pixels, and only one of them is this slot's.** The site is the midpoint
/// of the pair the crossing was found on, so the four whole positions around it hold the pair; the
/// one whose owner is this slot names the tile the flood walked back from.
uint named(uint pixel, float4 site)
{
    if (mine(pixel)) { return owner_tile[pixel]; }
    if (site.w >= UNSEEDED) { return NO_TILE; }
    for (uint corner = 0; corner < 4; corner = corner + 1) {
        let x = uint(corner % 2 == 0 ? floor(site.x) : ceil(site.x));
        let y = uint(corner < 2 ? floor(site.y) : ceil(site.y));
        if (x >= params.size.x || y >= params.size.y) { continue; }
        let q = y * params.size.x + x;
        if (owner[q] == params.slot) { return owner_tile[q]; }
    }
    return NO_TILE;
}

/// The flood's answer, as the field the gather and the blend read.
///
/// **Dispatched over the window, read off the grid.** The grid is the window grown by `w_max`, so a
/// seam just outside the window - which the window's own pixels are still feathered by - was seeded
/// and flooded like any other; what comes out is the window alone, one entry an output pixel.
[shader("compute")]
[numthreads(64, 1, 1)]
void assembly_settle(uint3 id : SV_DispatchThreadID)
{
    let out = linear(id);
    if (out >= params.out_size.x * params.out_size.y) { return; }
    let pixel = (out / params.out_size.x + params.pad_at.y) * params.size.x
        + (out % params.out_size.x + params.pad_at.x);
    let site = from_[pixel];
    if (params.slot == EVERY_SLOT) {
        // No seam within reach: the feather cannot get here, so the value only has to be legal.
        // `w_max` is what a pixel with nothing near it would have been given anyway.
        width[out] = site.w >= UNSEEDED ? params.w_max : site.z;
        return;
    }
    let d = site.w >= UNSEEDED ? 1e20 : site.w;
    signed_[out * params.slots + params.slot] = mine(pixel) ? d : -d;
    tile_of[out * params.slots + params.slot] = named(pixel, site);
}
