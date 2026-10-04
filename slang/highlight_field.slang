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
    /// Each channel's ceiling in `xyz` (`decode_rawler::channel_ceilings`); `w` is unused.
    float4 ceiling;
};

[vk::binding(0, 1)] ConstantBuffer<Field> field;
/// Every level's cells, finest first: weighted colour shares in `rgb`, their weight in `a`.
[vk::binding(1, 1)] RWStructuredBuffer<float4> levels;
/// Every level's filled colour share in `rgb`, summing to one; `a` is unused.
[vk::binding(2, 1)] RWStructuredBuffer<float4> estimates;

/// The weight at which a cell's own light needs nothing from the level above.
static const float TRUST = 0.25;

static const float3 NEUTRAL = float3(1.0 / 3.0);

static const float SHOULDER_POWER = 32.0;

/// Where a site's fullest photosite starts to be too near its ceiling to trust its share.
static const float UNCLIPPED_TO = 0.95;

/// The least ratio of a colour's dimmest photosite to its brightest across a site's window, from
/// trusting none of it to trusting all of it.
static const float EDGE_FROM = 0.4;
static const float EDGE_TO = 0.7;

/// One site's colour share and weight.
///
/// **Over a window centred on the site, not the site's own block**: a block puts red and blue a
/// diagonal apart, which on a steep edge swings the share by the gradient alone. Centred, every
/// colour balances about one point and a straight gradient cancels.
float4 site_light(Pattern cfa, int top, int left)
{
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
    let total = level.r + level.g + level.b;
    if (total <= 0.0) { return float4(0.0); }
    // Steep, so a blown region's own shoulder just under its ceiling outweighs dimmer light lit
    // beside it by orders of magnitude.
    // Off the fullest photosite rather than the mean: a window whose greens have started clipping
    // still averages under the ceiling, and its share comes out short of green, pink.
    let unclipped = 1.0 - smoothstep(UNCLIPPED_TO, SATURATED_AT, fullest);
    let weight = pow(brightest, SHOULDER_POWER) * unclipped * even;
    return float4(level / total * weight, weight);
}

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
    var sum = float4(0.0);
    for (int sy = 0; sy < sites; sy++) {
        for (int sx = 0; sx < sites; sx++) {
            sum += site_light(cfa, int(id.y) * cell + sy * side, int(id.x) * cell + sx * side);
        }
    }
    levels[field.offset + id.y * field.width + id.x] = sum;
}

[shader("compute")]
[numthreads(8, 8, 1)]
void field_push(uint3 id : SV_DispatchThreadID)
{
    if (id.x >= field.coarse_width || id.y >= field.coarse_height) { return; }
    var sum = float4(0.0);
    for (uint dy = 0; dy < 2; dy++) {
        for (uint dx = 0; dx < 2; dx++) {
            let x = id.x * 2 + dx;
            let y = id.y * 2 + dy;
            if (x < field.width && y < field.height) {
                sum += levels[field.offset + y * field.width + x];
            }
        }
    }
    levels[field.coarse_offset + id.y * field.coarse_width + id.x] = sum;
}

/// The level above's filled share at this level's cell `(x, y)`, bilinear between its centres.
float3 coarse_at(uint x, uint y)
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
            share += w * estimates[field.coarse_offset + uint(cy) * field.coarse_width + uint(cx)];
        }
    }
    return share.rgb;
}

/// The top level's light about cell `(x, y)`, its own and its eight neighbours', and neutral with
/// none at all.
///
/// **The neighbours are load-bearing**: the levels stop at `highlight::LEVELS`, well short of a
/// frame, so without them a blown patch a top cell across with no shoulder of its own fills
/// neutral, a white blob amid the colour around it.
float3 top_light(uint x, uint y)
{
    var sum = float4(0.0);
    for (int dy = -1; dy <= 1; dy++) {
        for (int dx = -1; dx <= 1; dx++) {
            let cx = int(x) + dx;
            let cy = int(y) + dy;
            if (cx < 0 || cy < 0 || cx >= int(field.width) || cy >= int(field.height)) { continue; }
            sum += levels[field.offset + uint(cy) * field.width + uint(cx)];
        }
    }
    return sum.a > 0.0 ? sum.rgb / sum.a : NEUTRAL;
}

/// This level's filled share: its own light where it has enough, topped up from the level above
/// where it has less, or at the top from its neighbours (`top_light`).
[shader("compute")]
[numthreads(8, 8, 1)]
void field_pull(uint3 id : SV_DispatchThreadID)
{
    if (id.x >= field.width || id.y >= field.height) { return; }
    let own = levels[field.offset + id.y * field.width + id.x];
    let above = field.coarse_width == 0 ? top_light(id.x, id.y) : coarse_at(id.x, id.y);
    let lent = max(TRUST - own.a, 0.0);
    let share = (own.rgb + lent * above) / (own.a + lent);
    estimates[field.offset + id.y * field.width + id.x] = float4(share, 0.0);
}
