import prelude;
import "../px.slang";
import "../light.slang";

[vk::binding(0, 0)] StructuredBuffer<float> c1_in;
[vk::binding(1, 0)] StructuredBuffer<float> c2_in;
[vk::binding(2, 0)] StructuredBuffer<float> c3_in;
[vk::binding(3, 0)] StructuredBuffer<float> luma;
[vk::binding(4, 0)] StructuredBuffer<float> raw;
[vk::binding(5, 0)] StructuredBuffer<float> params;
[vk::binding(6, 0)] RWStructuredBuffer<float> out_gat;

struct Push {
    int width;
    int height;
    int halfwidth;
    int halfheight;
    uint packed0;
    float colour_amount;
    int pooled;
    int detail;
};
[vk::binding(20, 0)] ConstantBuffer<Push> pc;

static const int TILE_DIM = 16;
static const Span<Sensor> HALO = { 3 };
static const int TILE_W = TILE_DIM + 2 * int(HALO.n);
static const int TILE_PIX = TILE_W * TILE_W;
/// How far out `shares_at` reads a block's neighbours' palettes.
static const Span<Sensor> SHARES_REACH = { 2 };
static const int PALETTE_HALO = int(HALO.n) + int(SHARES_REACH.n);
static const int PALETTE_W = TILE_DIM + 2 * PALETTE_HALO;
static const int PALETTE_PIX = PALETTE_W * PALETTE_W;

groupshared float4 blocks[484];
groupshared float4 palettes[676];

uint colour_at(int x, int y)
{
    let slot = uint((y & 1) * 2 + (x & 1));
    return (pc.packed0 >> (2u * slot)) & 3u;
}

float raw_at(int x, int y)
{
    if (x < 0) { x = -x; }
    if (y < 0) { y = -y; }
    if (x >= pc.width) { x = 2 * pc.width - x - 2; }
    if (y >= pc.height) { y = 2 * pc.height - y - 2; }
    x = clamp(x, 0, pc.width - 1);
    y = clamp(y, 0, pc.height - 1);
    Gain sample;
    sample.g = raw[y * pc.width + x];
    let transformed = gat_forward(sample, params[P_ALPHA], params[P_SIGMA_SQ]);
    let slot = (y & 1) | ((x & 1) << 1);
    return transformed * params[P_INV_SG] - params[P_DARK_REF0 + slot];
}

float4 palette_at(int x, int y)
{
    let at = float2(x, y) * 0.5;
    let base = int2(floor(at));
    let fraction = at - float2(base);
    var c = float3(0.0);
    for (int dy = 0; dy < 2; dy++) {
        let hy = clamp(base.y + dy, 0, pc.halfheight - 1);
        let wy = dy == 0 ? 1.0 - fraction.y : fraction.y;
        for (int dx = 0; dx < 2; dx++) {
            let hx = clamp(base.x + dx, 0, pc.halfwidth - 1);
            let wx = dx == 0 ? 1.0 - fraction.x : fraction.x;
            let hp = hy * pc.halfwidth + hx;
            c += wx * wy * float3(c1_in[hp], c2_in[hp], c3_in[hp]);
        }
    }
    return 0.5 * float4(
        c.x + c.y + c.z,
        c.x - c.y - c.z,
        -c.x + c.y - c.z,
        -c.x - c.y + c.z);
}

/// Where `palettes` sits on the frame. The width travels rather than being read off `PALETTE_W`,
/// whose `Span` would otherwise be built under the block loops (`wgsl_call_shapes.rs`).
struct Table {
    int2 origin;
    int width;
};

/// `palette_at`, off the tile's own table.
float4 palette_held(Table table, int x, int y)
{
    return palettes[(y - table.origin.y) * table.width + x - table.origin.x];
}

float3 signs_at(int x, int y)
{
    let row = y == 0 ? 1.0 : -1.0;
    let column = x == 0 ? 1.0 : -1.0;
    return float3(row, column, row * column);
}

float4 shares_at(Table table, int x, int y)
{
    var level = 0.0;
    var palette = float4(0.0);
    for (int dy = -1; dy <= 1; dy++) {
        for (int dx = -1; dx <= 1; dx++) {
            level += luma_sample(luma, pc.width, pc.height, x + 2 * dx, y + 2 * dy);
            palette += palette_held(table, x + 2 * dx, y + 2 * dy);
        }
    }
    if (level <= 1e-3) { return float4(0.25); }
    var levels = float4(0.0);
    for (int j = 0; j < 4; j++) {
        let slot = ((y + (j >> 1)) & 1) * 2 + ((x + (j & 1)) & 1);
        levels[j] = max(0.5 * level + palette[slot], 0.0);
    }
    return levels / dot(levels, float4(1.0));
}

float4 block_at(Table table, int x, int y, float strength)
{
    let samples = float4(raw_at(x, y), raw_at(x + 1, y), raw_at(x, y + 1), raw_at(x + 1, y + 1));
    let raw_chroma = 0.5 * float3(
        samples.x - samples.z + samples.y - samples.w,
        samples.x + samples.z - samples.y - samples.w,
        samples.x - samples.z - samples.y + samples.w);
    let pooled = pooled_luma(luma, pc.width, pc.height, x, y, pc.pooled != 0);
    if (strength <= 0.0) { return float4(raw_chroma, pooled); }

    let palette = palette_held(table, x, y);
    var shares = float4(0.25);
    var derivatives = float3(0.0);
    if (pc.detail != 0) {
        shares = shares_at(table, x, y);
        derivatives = brightness_derivatives(luma, pc.width, pc.height, x, y);
    }
    var chroma = float3(0.0);
    for (int j = 0; j < 4; j++) {
        let sx = j & 1;
        let sy = j >> 1;
        let i = float(sx) - 0.5;
        let k = float(sy) - 0.5;
        let detail = 2.0 * shares[j] * (i * derivatives.x + k * derivatives.y + 2.0 * i * k * derivatives.z);
        let slot = ((y + sy) & 1) * 2 + ((x + sx) & 1);
        chroma += (0.5 * palette[slot] + detail) * signs_at(sx, sy);
    }
    let green_sign = colour_at(x, y) == 1u ? 1.0 : -1.0;
    let observed_green = raw_chroma.x + green_sign * raw_chroma.y;
    let predicted_green = chroma.x + green_sign * chroma.y;
    let correction = 0.5 * green_confidence(observed_green) * (observed_green - predicted_green);
    chroma.x += correction;
    chroma.y += green_sign * correction;
    return float4(lerp(raw_chroma, chroma, strength), pooled);
}

[shader("compute")]
[numthreads(16, 16, 1)]
void reconstruct_bayer(uint3 group : SV_GroupID, uint3 local : SV_GroupThreadID)
{
    if (pc.width <= 0 || pc.height <= 0) { return; }
    let tile_x = int(group.x) * TILE_DIM;
    let tile_y = int(group.y) * TILE_DIM;
    let lx = int(local.x);
    let ly = int(local.y);
    let lid = ly * TILE_DIM + lx;
    let halo = int(HALO.n);
    let amount = clamp(pc.colour_amount, 0.0, 1.0);
    let strength = amount * amount * (3.0 - 2.0 * amount);
    Table table;
    table.origin = int2(tile_x - PALETTE_HALO, tile_y - PALETTE_HALO);
    table.width = PALETTE_W;
    if (strength > 0.0) {
        for (int i = lid; i < PALETTE_PIX; i += TILE_DIM * TILE_DIM) {
            palettes[i] = palette_at(table.origin.x + i % table.width, table.origin.y + i / table.width);
        }
    }
    GroupMemoryBarrierWithGroupSync();

    for (int i = lid; i < TILE_PIX; i += TILE_DIM * TILE_DIM) {
        let x = tile_x - halo + i % TILE_W;
        let y = tile_y - halo + i / TILE_W;
        let parity_x = x & 1;
        let parity_y = y & 1;
        // Clamped towards the frame, so a block stays inside the tile's own reach and its
        // palettes inside the table.
        let sx = clamp(x, -parity_x, pc.width - 2 + parity_x);
        let sy = clamp(y, -parity_y, pc.height - 2 + parity_y);
        blocks[i] = block_at(table, sx, sy, strength);
    }
    GroupMemoryBarrierWithGroupSync();

    let x = tile_x + lx;
    let y = tile_y + ly;
    if (x >= pc.width || y >= pc.height) { return; }
    var sum = 0.0;
    for (int dy = 0; dy < 2; dy++) {
        for (int dx = 0; dx < 2; dx++) {
            let at = (ly + halo - dy) * TILE_W + lx + halo - dx;
            let block = blocks[at];
            var nmin = float3(1e30);
            var nmax = float3(-1e30);
            for (int ny = -1; ny <= 1; ny++) {
                for (int nx = -1; nx <= 1; nx++) {
                    if (nx == 0 && ny == 0) { continue; }
                    let neighbour = blocks[at + 2 * ny * TILE_W + 2 * nx].xyz;
                    nmin = min(nmin, neighbour);
                    nmax = max(nmax, neighbour);
                }
            }
            let observed = block.xyz;
            let green_sign = colour_at(x - dx, y - dy) == 1u ? 1.0 : -1.0;
            let confidence = green_confidence(observed.x + green_sign * observed.y);
            let chroma = lerp(clamp(observed, nmin, nmax), observed, confidence);
            sum += block.w + dot(signs_at(dx, dy), chroma);
        }
    }
    out_gat[y * pc.width + x] = 0.25 * sum;
}
