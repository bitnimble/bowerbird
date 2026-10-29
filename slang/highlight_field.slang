// The colour share of the brightest unclipped light near every place in the mosaic, pushed and
// pulled inward over cells that have none, for `assemble.slang`'s `reconstructed`.
import clipping;
import mosaic;

struct Field {
    /// This level's cells, and where they start in `levels` and `estimates`.
    uint width;
    uint height;
    uint offset;
    /// The level above, which `field_push` writes and `field_pull` reads.
    uint coarse_width;
    uint coarse_height;
    uint coarse_offset;
    /// Photosites a side in a site, the smallest block holding every colour: 2 for Bayer, 3 for
    /// X-Trans.
    uint site;
    /// Sites a side in a level-0 cell.
    uint cell_sites;
    /// Each channel's ceiling in `xyz` (`decode::raw::channel_ceilings`); `w` is unused.
    float4 ceiling;
};

[vk::binding(0, 1)] ConstantBuffer<Field> field;
/// Every level's cells, finest first, two to a cell (`ALL`, `RIM`). Each is red and green shares,
/// weighted, then a weighted third value, and the weight in `a`; blue is the weight less red and
/// green. `ALL` holds every light and its log2 fill; `RIM` only the light touching a blown cell, and
/// its chroma.
[vk::binding(1, 1)] RWStructuredBuffer<float4> levels;
/// `levels` filled: each pair's red and green shares and third value, and how near that light is,
/// one where the cell holds its own, falling by `NEAR_PER_LEVEL` for each level it had to borrow
/// through.
[vk::binding(2, 1)] RWStructuredBuffer<float4> estimates;
/// Each level-0 cell's light as `assemble.slang` reads it: `ALL`'s estimate, or in a blown cell the
/// colour its region's rim lends, as much as that rim agrees on one hue, at full reach.
[vk::binding(3, 1)] RWStructuredBuffer<float4> lent;
/// Whether each level-0 cell is blown.
[vk::binding(4, 1)] RWStructuredBuffer<uint> blown_cells;

static const uint ALL = 0;
static const uint RIM = 1;

/// On a rim's |mean chroma vector| / mean chroma: 1 for one hue, falling as hues cancel.
static const float AGREE_FROM = 0.6;
static const float AGREE_TO = 0.9;

/// The weight at which a cell's own light needs nothing from the level above.
static const float TRUST = 0.25;

static const float NEAR_PER_LEVEL = 0.5;

/// Lent by no light at all: neutral, at the fill nothing trusts. No lower, or a cell blended with
/// it reads as dim light and fades a lit neighbour's colour.
static const float4 UNLIT = float4(1.0 / 3.0, 1.0 / 3.0, LENT_FROM.s, 0.0);

static const float SHOULDER_POWER = 32.0;

/// Where a site's fullest photosite starts to be too near its ceiling to trust its share.
static const float UNCLIPPED_TO = 0.95;

/// The least ratio of a colour's dimmest photosite to its brightest across a site's window, from
/// trusting none of it to trusting all of it.
static const float EDGE_FROM = 0.4;
static const float EDGE_TO = 0.7;

/// One site's colour share and weight, and how blown it is.
///
/// **Over a window centred on the site, not the site's own block**: a block puts red and blue a
/// diagonal apart, which on a steep edge swings the share by the gradient alone. Centred, every
/// colour balances about one point and a straight gradient cancels.
float4 site_light(Pattern cfa, int top, int left, out float blown)
{
    blown = 0.0;
    let reach = int(field.site) - 1;
    let ceiling = max(field.ceiling.rgb, float3(1e-6));
    var sums = float3(0.0);
    var counts = float3(0.0);
    var lows = float3(1e30);
    var highs = float3(0.0);
    for (int dy = -reach; dy <= reach; dy++) {
        for (int dx = -reach; dx <= reach; dx++) {
            let r = top + dy;
            let c = left + dx;
            if (r < 0 || c < 0 || r >= int(shape.height) || c >= int(shape.width)) { continue; }
            let colour = colour_of(cfa, r, c);
            let value = samples[uint(r) * shape.width + uint(c)];
            let k = colour == 0 ? 0 : (colour == 2 ? 2 : 1);
            sums[k] += value;
            counts[k] += 1.0;
            lows[k] = min(lows[k], value);
            highs[k] = max(highs[k], value);
        }
    }
    if (any(counts == float3(0.0))) { return float4(0.0); }
    let fullest = max(highs.r / ceiling.r, max(highs.g / ceiling.g, highs.b / ceiling.b));
    // A window across a hard edge reads each colour off a different side of it, a false hue.
    let spread = lows / max(highs, float3(1e-6));
    let even = smoothstep(EDGE_FROM, EDGE_TO, min(spread.r, min(spread.g, spread.b)));
    let level = max(sums / counts, float3(0.0));
    let fill = level / ceiling;
    let brightest = max(fill.r, max(fill.g, fill.b));
    // Off the fullest photosite rather than the mean: a window whose greens have started clipping
    // still averages under the ceiling, and its share comes out short of green, pink.
    let unclipped = 1.0 - smoothstep(UNCLIPPED_TO, SATURATED_AT, fullest);
    blown = 1.0 - unclipped;
    let total = level.r + level.g + level.b;
    if (total <= 0.0) { return float4(0.0); }
    // Steep, so a blown region's own shoulder just under its ceiling outweighs dimmer light lit
    // beside it by orders of magnitude.
    let weight = pow(brightest, SHOULDER_POWER) * unclipped * even;
    let share = level / total;
    return float4(share.r, share.g, log2(max(brightest, 1e-6)), 1.0) * weight;
}

/// A cell of `levels` as an estimate `near` its light, or unlit with no weight: `UNLIT`, or for
/// `RIM` neutral at no chroma, so blending it in dilutes a rim's mean colour and its chroma alike and
/// leaves their agreement.
float4 estimate_of(float4 level, float near, uint pair)
{
    if (level.a <= 0.0) { return pair == RIM ? float4(1.0 / 3.0, 1.0 / 3.0, 0.0, 0.0) : UNLIT; }
    return float4(level.r / level.a, level.g / level.a, level.b / level.a, near);
}

uint at_of(uint x, uint y, uint pair) { return (field.offset + y * field.width + x) * 2 + pair; }

[shader("compute")]
[numthreads(8, 8, 1)]
void field_seed(uint3 id : SV_DispatchThreadID)
{
    if (id.x >= field.width || id.y >= field.height) { return; }
    Pattern cfa;
    pattern(cfa);
    let side = int(field.site);
    let sites = int(field.cell_sites);
    let cell = sites * side;
    var all = float4(0.0);
    var rim = float4(0.0);
    var blown = 0.0;
    for (int sy = 0; sy < sites; sy++) {
        for (int sx = 0; sx < sites; sx++) {
            float site_blown;
            let light = site_light(cfa, int(id.y) * cell + sy * side, int(id.x) * cell + sx * side, site_blown);
            all += light;
            blown += site_blown;
            if (light.a > 0.0) {
                let share = float3(light.r, light.g, light.a - light.r - light.g) / light.a;
                rim += float4(light.r, light.g, length(share - 1.0 / 3.0) * light.a, light.a);
            }
        }
    }
    levels[at_of(id.x, id.y, ALL)] = all;
    // Each cell one vote, however bright: by its shoulder weight, the few rim cells nearest the
    // clip outvote the rest and a pale rim lends the colour of the lit surface behind it.
    levels[at_of(id.x, id.y, RIM)] = rim.a > 0.0 ? rim / rim.a * min(rim.a / TRUST, 1.0) : float4(0.0);
    // Half a blown site makes the cell blown: a partly blown rim cell left out lends its own light
    // as if read, drawing a white dash along a coloured region's edge.
    blown_cells[id.y * field.width + id.x] = blown >= 0.5 ? 1 : 0;
}

bool blown_at(int x, int y)
{
    if (x < 0 || y < 0 || x >= int(field.width) || y >= int(field.height)) { return false; }
    return blown_cells[uint(y) * field.width + uint(x)] != 0;
}

/// Keeps a level-0 cell's `RIM` light only where it touches a blown cell, itself included.
[shader("compute")]
[numthreads(8, 8, 1)]
void field_rim(uint3 id : SV_DispatchThreadID)
{
    if (id.x >= field.width || id.y >= field.height) { return; }
    for (int dy = -1; dy <= 1; dy++) {
        for (int dx = -1; dx <= 1; dx++) {
            if (blown_at(int(id.x) + dx, int(id.y) + dy)) { return; }
        }
    }
    levels[at_of(id.x, id.y, RIM)] = float4(0.0);
}

[shader("compute")]
[numthreads(8, 8, 1)]
void field_push(uint3 id : SV_DispatchThreadID)
{
    if (id.x >= field.coarse_width || id.y >= field.coarse_height) { return; }
    for (uint pair = 0; pair < 2; pair++) {
        var sum = float4(0.0);
        for (uint dy = 0; dy < 2; dy++) {
            for (uint dx = 0; dx < 2; dx++) {
                let x = id.x * 2 + dx;
                let y = id.y * 2 + dy;
                if (x < field.width && y < field.height) {
                    sum += levels[at_of(x, y, pair)];
                }
            }
        }
        levels[(field.coarse_offset + id.y * field.coarse_width + id.x) * 2 + pair] = sum;
    }
}

/// The level above's estimate at this level's cell `(x, y)`, bilinear between its centres.
float4 coarse_at(uint x, uint y, uint pair)
{
    let at = (float2(x, y) + 0.5) * 0.5 - 0.5;
    let base = int2(floor(at));
    let t = at - float2(base);
    var share = float4(0.0);
    for (int dy = 0; dy < 2; dy++) {
        for (int dx = 0; dx < 2; dx++) {
            let cx = clamp(base.x + dx, 0, int(field.coarse_width) - 1);
            let cy = clamp(base.y + dy, 0, int(field.coarse_height) - 1);
            let w = (dx == 0 ? 1.0 - t.x : t.x) * (dy == 0 ? 1.0 - t.y : t.y);
            share += w * estimates[(field.coarse_offset + uint(cy) * field.coarse_width + uint(cx)) * 2 + pair];
        }
    }
    return share;
}

/// The top level's light about cell `(x, y)`, its own and its eight neighbours', and `UNLIT` with
/// none at all.
///
/// **The neighbours are load-bearing**: the levels stop at `highlight::LEVELS`, well short of a
/// frame, so without them a blown patch a top cell across with no shoulder of its own fills
/// neutral, a white blob amid the colour around it.
float4 top_light(uint x, uint y, uint pair)
{
    var sum = float4(0.0);
    for (int dy = -1; dy <= 1; dy++) {
        for (int dx = -1; dx <= 1; dx++) {
            let cx = int(x) + dx;
            let cy = int(y) + dy;
            if (cx < 0 || cy < 0 || cx >= int(field.width) || cy >= int(field.height)) { continue; }
            sum += levels[at_of(uint(cx), uint(cy), pair)];
        }
    }
    return estimate_of(sum, 0.0, pair);
}

/// This level's estimates: its own light where it has enough, topped up from the level above where
/// it has less, or at the top from its neighbours (`top_light`).
[shader("compute")]
[numthreads(8, 8, 1)]
void field_pull(uint3 id : SV_DispatchThreadID)
{
    if (id.x >= field.width || id.y >= field.height) { return; }
    for (uint pair = 0; pair < 2; pair++) {
        let own = levels[at_of(id.x, id.y, pair)];
        let above = field.coarse_width == 0 ? top_light(id.x, id.y, pair) : coarse_at(id.x, id.y, pair);
        let borrowed = max(TRUST - own.a, 0.0);
        let topped = own + borrowed * float4(above.rgb, 1.0);
        let held = min(own.a / TRUST, 1.0);
        let near = held + (1.0 - held) * above.a * NEAR_PER_LEVEL;
        estimates[at_of(id.x, id.y, pair)] = estimate_of(topped, near, pair);
    }
}

[shader("compute")]
[numthreads(8, 8, 1)]
void field_lend(uint3 id : SV_DispatchThreadID)
{
    if (id.x >= field.width || id.y >= field.height) { return; }
    let all = estimates[at_of(id.x, id.y, ALL)];
    let here = id.y * field.width + id.x;
    if (blown_cells[here] == 0) {
        lent[here] = all;
        return;
    }
    let rim = estimates[at_of(id.x, id.y, RIM)];
    let lent_share = float3(rim.rg, 1.0 - rim.r - rim.g) - 1.0 / 3.0;
    let agree = smoothstep(AGREE_FROM, AGREE_TO, length(lent_share) / max(rim.b, 1e-6));
    lent[here] = float4(1.0 / 3.0 + lent_share.xy * agree, all.b, 1.0);
}
