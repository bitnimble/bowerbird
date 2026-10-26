// The reflection remover (`models/dereflect/src/dereflect/model.py`, LightRR reading DINOv2 ViT-S/14)
// over planes laid out channel by channel, `[C][H * W]`. DINOv2's tokens are such planes one row
// tall, the class token first.
//
// Every spatial constant here is the network's own, on its fixed 1024 working plane or its token
// grid: scale-exact by construction (`px.slang`). `PATCH` is DINOv2's 14-pixel patch on the
// resized picture it reads.

import times;

struct Params {
    /// Threads a dispatch row, for the index past 65535 workgroups.
    uint span;
    uint count;
    uint width;
    uint height;
    uint in_channels;
    uint out_channels;
    uint mode;
    uint flags;
    uint src_at;
    uint src2_at;
    uint dst_at;
    uint weight_at;
    uint bias_at;
    uint extra0;
    uint extra1;
    uint extra2;
    uint extra3;
    uint state_at;
    float eps;
    float scale;
};

/// Cell type of every buffer but `wide_*`: `half` in the `shader-f16` build.
#ifndef STORED
#define STORED float
#endif
typealias Stored = STORED;

[vk::binding(20, 0)] ConstantBuffer<Params> pc;
[vk::binding(0, 0)] StructuredBuffer<Stored> src;
[vk::binding(1, 0)] StructuredBuffer<Stored> weights;
[vk::binding(2, 0)] RWStructuredBuffer<Stored> dst;
[vk::binding(3, 0)] StructuredBuffer<Stored> src2;
[vk::binding(4, 0)] StructuredBuffer<float> wide_src;
[vk::binding(5, 0)] RWStructuredBuffer<float> wide_dst;

static const uint THREADS = 64;
static const uint STATE = 16;
static const uint PATCH = 14;

static const uint GATHER_PLAIN = 0;
static const uint GATHER_3X3 = 1;
static const uint GATHER_PATCH = 2;
static const uint A_FROM_SRC2 = 1;
static const uint ACCUMULATE = 2;
/// `layernorm` and `idwt` read from `wide_src`, and `idwt` writes to `wide_dst`.
static const uint WIDE = 4;

uint index(uint3 id)
{
    return id.y * pc.span + id.x;
}

float input(uint at)
{
    return (pc.flags & WIDE) != 0 ? wide_src[at] : float(src[at]);
}

float silu(float x)
{
    return x / (1.0 + exp(-x));
}

/// Abramowitz and Stegun 7.1.26, within 1.5e-7 of `erf`, which WGSL lacks.
float erf_close(float x)
{
    let t = 1.0 / (1.0 + 0.3275911 * abs(x));
    let poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
    return sign(x) * (1.0 - poly * exp(-x * x));
}

float gelu(float x)
{
    return 0.5 * x * (1.0 + erf_close(x * 0.70710678118654752));
}

// --- Matrices -------------------------------------------------------------------------------

static const uint TILE = 64;
static const uint DEPTH = 16;
static const uint PER = 4;

groupshared float tile_a[DEPTH][TILE];
groupshared float tile_b[DEPTH][TILE];

/// `B[k][n]` of the product: a plane stack's channel `k` at pixel `n`, or the column a 3x3
/// convolution or DINOv2's patch embedding reads there.
float gathered(uint k, uint n)
{
    if (pc.mode == GATHER_PLAIN) {
        return src[pc.src_at + k * pc.count + n];
    }
    if (pc.mode == GATHER_3X3) {
        let channel = k / 9;
        let tap = k - times(channel, 9);
        let y = int(n / pc.width) + int(tap / 3) - 1;
        let x = int(n % pc.width) + int(tap % 3) - 1;
        if (y < 0 || y >= int(pc.height) || x < 0 || x >= int(pc.width)) { return 0.0; }
        return src[pc.src_at + channel * pc.width * pc.height + uint(y) * pc.width + uint(x)];
    }
    let taps = PATCH * PATCH;
    let channel = k / taps;
    let tap = k - times(channel, taps);
    let row = n / pc.width;
    let column = n % pc.width;
    let across = times(pc.width, PATCH);
    let y = times(row, PATCH) + tap / PATCH;
    let x = times(column, PATCH) + tap % PATCH;
    return src[pc.src_at + channel * across * times(pc.height, PATCH) + y * across + x];
}

float coefficient(uint m, uint k)
{
    let at = pc.weight_at + m * pc.in_channels + k;
    return (pc.flags & A_FROM_SRC2) != 0 ? src2[at] : weights[at];
}

/// `C[M][N] = A[M][K] B[K][N] (+ bias[M])`: `A` the weights' `[out][in]` rows (or `src2`'s),
/// `B` as `gathered` reads it. `out_channels` is M, `in_channels` K, `count` N. With
/// `ACCUMULATE`, C adds to what is there.
[shader("compute")]
[numthreads(16, 16, 1)]
void gemm(uint3 group : SV_GroupID, uint3 lane : SV_GroupThreadID)
{
    let rows = pc.out_channels;
    let inner = pc.in_channels;
    let columns = pc.count;
    let first_m = group.y * TILE;
    let first_n = group.x * TILE;
    let slot = lane.y * 16 + lane.x;
    float sums[PER][PER];
    [ForceUnroll]
    for (uint i = 0; i < PER; i++) {
        [ForceUnroll]
        for (uint j = 0; j < PER; j++) { sums[i][j] = 0.0; }
    }
    for (uint k0 = 0; k0 < inner; k0 += DEPTH) {
        [ForceUnroll]
        for (uint e = 0; e < PER; e++) {
            let cell = slot + e * 256;
            let k = cell % DEPTH;
            let m = cell / DEPTH;
            let kk = k0 + k;
            tile_a[k][m] = (first_m + m < rows && kk < inner) ? coefficient(first_m + m, kk) : 0.0;
            let n = cell % TILE;
            let kb = cell / TILE;
            let kkb = k0 + kb;
            tile_b[kb][n] = (first_n + n < columns && kkb < inner) ? gathered(kkb, first_n + n) : 0.0;
        }
        GroupMemoryBarrierWithGroupSync();
        [ForceUnroll]
        for (uint k = 0; k < DEPTH; k++) {
            float a[PER];
            float b[PER];
            [ForceUnroll]
            for (uint i = 0; i < PER; i++) { a[i] = tile_a[k][lane.y * PER + i]; }
            [ForceUnroll]
            for (uint j = 0; j < PER; j++) { b[j] = tile_b[k][lane.x * PER + j]; }
            [ForceUnroll]
            for (uint i = 0; i < PER; i++) {
                [ForceUnroll]
                for (uint j = 0; j < PER; j++) { sums[i][j] += a[i] * b[j]; }
            }
        }
        GroupMemoryBarrierWithGroupSync();
    }
    [ForceUnroll]
    for (uint i = 0; i < PER; i++) {
        let m = first_m + lane.y * PER + i;
        if (m >= rows) { continue; }
        let bias = pc.bias_at != 0xffffffff ? weights[pc.bias_at + m] : 0.0;
        [ForceUnroll]
        for (uint j = 0; j < PER; j++) {
            let n = first_n + lane.x * PER + j;
            if (n >= columns) { continue; }
            let at = pc.dst_at + m * columns + n;
            let value = sums[i][j] + bias;
            dst[at] = (pc.flags & ACCUMULATE) != 0 ? dst[at] + value : value;
        }
    }
}

/// A depthwise 3x3 convolution, `[C][1][3][3]` weights, a bias where `bias_at` is set.
[shader("compute")]
[numthreads(THREADS, 1, 1)]
void depthwise(uint3 id : SV_DispatchThreadID)
{
    let e = index(id);
    if (e >= pc.count) { return; }
    let plane = pc.width * pc.height;
    let c = e / plane;
    let p = e % plane;
    let y = int(p / pc.width);
    let x = int(p % pc.width);
    var sum = pc.bias_at != 0xffffffff ? weights[pc.bias_at + c] : 0.0;
    let w_at = pc.weight_at + times(c, 9);
    let s_at = pc.src_at + c * plane;
    var tap = w_at;
    for (int yy = y - 1; yy <= y + 1; yy++) {
        for (int xx = x - 1; xx <= x + 1; xx++) {
            if (yy >= 0 && yy < int(pc.height) && xx >= 0 && xx < int(pc.width)) {
                sum += float(weights[tap]) * src[s_at + uint(yy) * pc.width + uint(xx)];
            }
            tap++;
        }
    }
    dst[pc.dst_at + e] = sum;
}

// --- Per-pixel ------------------------------------------------------------------------------

/// `nn.LayerNorm(C)` over each pixel's channels, epsilon `eps`.
[shader("compute")]
[numthreads(THREADS, 1, 1)]
void layernorm(uint3 id : SV_DispatchThreadID)
{
    let p = index(id);
    if (p >= pc.count) { return; }
    let plane = pc.count;
    let c = pc.in_channels;
    var mean = 0.0;
    for (uint i = 0; i < c; i++) { mean += input(pc.src_at + i * plane + p); }
    mean /= float(c);
    var variance = 0.0;
    for (uint i = 0; i < c; i++) {
        let d = input(pc.src_at + i * plane + p) - mean;
        variance += d * d;
    }
    let scale = 1.0 / sqrt(variance / float(c) + pc.eps);
    for (uint i = 0; i < c; i++) {
        let v = (input(pc.src_at + i * plane + p) - mean) * scale;
        dst[pc.dst_at + i * plane + p] = v * weights[pc.weight_at + i] + weights[pc.bias_at + i];
    }
}

[shader("compute")]
[numthreads(THREADS, 1, 1)]
void silu_inplace(uint3 id : SV_DispatchThreadID)
{
    let e = index(id);
    if (e >= pc.count) { return; }
    dst[pc.dst_at + e] = silu(dst[pc.dst_at + e]);
}

[shader("compute")]
[numthreads(THREADS, 1, 1)]
void gelu_inplace(uint3 id : SV_DispatchThreadID)
{
    let e = index(id);
    if (e >= pc.count) { return; }
    dst[pc.dst_at + e] = gelu(dst[pc.dst_at + e]);
}

[shader("compute")]
[numthreads(THREADS, 1, 1)]
void copy(uint3 id : SV_DispatchThreadID)
{
    let e = index(id);
    if (e >= pc.count) { return; }
    dst[pc.dst_at + e] = src[pc.src_at + e];
}

/// `y * silu(z)`.
[shader("compute")]
[numthreads(THREADS, 1, 1)]
void gate(uint3 id : SV_DispatchThreadID)
{
    let e = index(id);
    if (e >= pc.count) { return; }
    dst[pc.dst_at + e] = src[pc.src_at + e] * silu(src2[pc.src2_at + e]);
}

/// `x * scale[c] + y`, with `width` the plane size.
[shader("compute")]
[numthreads(THREADS, 1, 1)]
void scale_add(uint3 id : SV_DispatchThreadID)
{
    let e = index(id);
    if (e >= pc.count) { return; }
    let c = e / pc.width;
    dst[pc.dst_at + e] = Stored(float(src[pc.src_at + e]) * weights[pc.weight_at + c] + src2[pc.src2_at + e]);
}

/// `x + y * gamma[c]` in place over `x`, DINOv2's LayerScale residual; `width` the plane size.
[shader("compute")]
[numthreads(THREADS, 1, 1)]
void add_scaled(uint3 id : SV_DispatchThreadID)
{
    let e = index(id);
    if (e >= pc.count) { return; }
    let c = e / pc.width;
    dst[pc.dst_at + e] = Stored(dst[pc.dst_at + e] + float(src[pc.src_at + e]) * weights[pc.weight_at + c]);
}

/// `attention + kv * alpha + q * beta`, in place over the attention.
[shader("compute")]
[numthreads(THREADS, 1, 1)]
void fuse(uint3 id : SV_DispatchThreadID)
{
    let e = index(id);
    if (e >= pc.count) { return; }
    dst[pc.dst_at + e] = Stored(dst[pc.dst_at + e] + (float(src[pc.src_at + e]) * weights[pc.weight_at]
        + float(src2[pc.src2_at + e]) * weights[pc.bias_at]));
}

/// The output convolution's three channels, in place, scaled by the location gate: `src2` the
/// gate's logit, `width` the plane size, `scale` 1 over the open gate's share.
[shader("compute")]
[numthreads(THREADS, 1, 1)]
void located(uint3 id : SV_DispatchThreadID)
{
    let e = index(id);
    if (e >= pc.count) { return; }
    let p = e % pc.width;
    let open = 1.0 / (1.0 + exp(-float(src2[pc.src2_at + p])));
    dst[pc.dst_at + e] = Stored(float(dst[pc.dst_at + e]) * open * pc.scale);
}

// --- Wavelets -------------------------------------------------------------------------------

/// Haar DWT as `torch_wavelets.DWT_2D` computes it: `[LL, LH, HL, HH]`, each `C` channels at half
/// size. `width` and `height` are the input's.
[shader("compute")]
[numthreads(THREADS, 1, 1)]
void dwt(uint3 id : SV_DispatchThreadID)
{
    let e = index(id);
    if (e >= pc.count) { return; }
    let w2 = pc.width / 2;
    let half_plane = w2 * (pc.height / 2);
    let c = e / half_plane;
    let p = e % half_plane;
    let i = p / w2;
    let j = p % w2;
    let at = pc.src_at + c * pc.width * pc.height + 2 * i * pc.width + 2 * j;
    let a = float(src[at]);
    let b = float(src[at + 1]);
    let cc = float(src[at + pc.width]);
    let d = float(src[at + pc.width + 1]);
    let band = pc.in_channels * half_plane;
    let out = pc.dst_at + c * half_plane + p;
    dst[out] = 0.5 * (a + b + cc + d);
    dst[out + band] = 0.5 * (a + b - cc - d);
    dst[out + times(band, 2)] = 0.5 * (a - b + cc - d);
    dst[out + times(band, 3)] = 0.5 * (a - b - cc + d);
}

/// Its inverse, from `[LL, LH, HL, HH]` of `C` channels each. `width` and `height` are the
/// input's, half the output's.
[shader("compute")]
[numthreads(THREADS, 1, 1)]
void idwt(uint3 id : SV_DispatchThreadID)
{
    let e = index(id);
    if (e >= pc.count) { return; }
    let half_plane = pc.width * pc.height;
    let c = e / half_plane;
    let p = e % half_plane;
    let i = p / pc.width;
    let j = p % pc.width;
    let band = pc.out_channels * half_plane;
    let at = pc.src_at + c * half_plane + p;
    let widened = (pc.flags & WIDE) != 0;
    let ll = widened ? wide_src[pc.src2_at + c * half_plane + p] : float(src[at]);
    let lh = float(src[at + band]);
    let hl = float(src[at + times(band, 2)]);
    let hh = float(src[at + times(band, 3)]);
    let across = 2 * pc.width;
    let out = pc.dst_at + c * half_plane * 4 + 2 * i * across + 2 * j;
    let corners = float4(ll + lh + hl + hh, ll + lh - hl - hh, ll - lh + hl - hh, ll - lh - hl + hh) * 0.5;
    if (widened) {
        wide_dst[out] = corners.x;
        wide_dst[out + 1] = corners.y;
        wide_dst[out + across] = corners.z;
        wide_dst[out + across + 1] = corners.w;
    } else {
        dst[out] = Stored(corners.x);
        dst[out + 1] = Stored(corners.y);
        dst[out + across] = Stored(corners.z);
        dst[out + across + 1] = Stored(corners.w);
    }
}

// --- The selective scan -----------------------------------------------------------------------

/// Where step `l` of direction `k` sits in a row-major `h x w` plane: rows, columns, then both
/// reversed, as `forward_core` unrolls them.
uint scan_place(uint k, uint l, uint h, uint w)
{
    let n = w * h;
    let along = k >= 2 ? n - 1 - l : l;
    if ((k & 1) == 0) { return along; }
    return (along % h) * w + along / h;
}

/// The scan's inputs at step `l` of thread `t`'s direction: the step size and the input.
struct Step {
    float delta;
    float u;
    uint place;
}

Step scan_step(uint t, uint l)
{
    let inner = pc.extra3;
    let rank = pc.extra2;
    let k = t / inner;
    let d = t % inner;
    let n = pc.width * pc.height;
    let rows = rank + 2 * STATE;
    let x_dbl = pc.src2_at + k * rows * n;
    let place = scan_place(k, l, pc.height, pc.width);
    var raw = float(weights[pc.bias_at + t]);
    let dt_at = pc.weight_at + t * rank;
    for (uint r = 0; r < rank; r++) { raw += float(weights[dt_at + r]) * src2[x_dbl + r * n + place]; }
    Step step;
    step.delta = raw > 20.0 ? raw : log(1.0 + exp(raw));
    step.u = src[pc.src_at + d * n + place];
    step.place = place;
    return step;
}

/// Thread `t` (a direction and inner channel) over chunk `chunk` from `state`: with `write`, each
/// step's `y` into `dst` at its place; leaves the end state in `state` and, in `decay`, how much
/// of a start state survives the chunk.
void scan_chunk(uint t, uint chunk, inout float state[STATE], out float decay[STATE], bool write)
{
    let inner = pc.extra3;
    let rank = pc.extra2;
    let k = t / inner;
    let n = pc.width * pc.height;
    let rows = rank + 2 * STATE;
    let x_dbl = pc.src2_at + k * rows * n;
    float a[STATE];
    [ForceUnroll]
    for (uint s = 0; s < STATE; s++) {
        a[s] = -exp(float(weights[pc.extra0 + t * STATE + s]));
        decay[s] = 1.0;
    }
    let skip = float(weights[pc.extra1 + t]);
    let first = chunk * pc.mode;
    let last = min(first + pc.mode, n);
    for (uint l = first; l < last; l++) {
        let step = scan_step(t, l);
        var y = skip * step.u;
        [ForceUnroll]
        for (uint s = 0; s < STATE; s++) {
            let b = float(src2[x_dbl + (rank + s) * n + step.place]);
            let kept = exp(step.delta * a[s]);
            state[s] = kept * state[s] + step.delta * b * step.u;
            decay[s] *= kept;
            if (write) {
                let c = float(src2[x_dbl + (rank + STATE + s) * n + step.place]);
                y += c * state[s];
            }
        }
        if (write) { wide_dst[pc.dst_at + t * n + step.place] = y; }
    }
}

/// The four-direction selective scan in three passes, each direction's sequence cut into chunks of
/// `mode` steps. `src` is the LL band `[D][L]`, `src2` the `x_proj` output `[K][R + 2N][L]`;
/// `wide_dst` takes each direction's `y` at its own place, `[K][D][L]`, and holds the chunks' states
/// from `state_at`, `[chunk][t][2 * STATE]`. `weight_at` is where `dt_projs_weight` starts,
/// `bias_at` `dt_projs_bias`, `extra0` `A_logs`, `extra1` `Ds`, `extra2` the rank, `extra3` D.
///
/// The first: each chunk run from rest, its end state and decay. `count` is threads times chunks.
[shader("compute")]
[numthreads(THREADS, 1, 1)]
void scan_ends(uint3 id : SV_DispatchThreadID)
{
    let e = index(id);
    if (e >= pc.count) { return; }
    let threads = pc.extra3 * 4;
    let t = e % threads;
    let chunk = e / threads;
    float state[STATE];
    float decay[STATE];
    [ForceUnroll]
    for (uint s = 0; s < STATE; s++) { state[s] = 0.0; }
    scan_chunk(t, chunk, state, decay, false);
    let at = pc.state_at + e * 2 * STATE;
    [ForceUnroll]
    for (uint s = 0; s < STATE; s++) {
        wide_dst[at + s] = state[s];
        wide_dst[at + STATE + s] = decay[s];
    }
}

/// The second: each thread walks its chunks' ends in order and leaves, in place of each end, the
/// state that chunk starts from. `count` is threads, `in_channels` chunks.
[shader("compute")]
[numthreads(THREADS, 1, 1)]
void scan_carry(uint3 id : SV_DispatchThreadID)
{
    let t = index(id);
    if (t >= pc.count) { return; }
    let threads = pc.count;
    float carry[STATE];
    [ForceUnroll]
    for (uint s = 0; s < STATE; s++) { carry[s] = 0.0; }
    for (uint chunk = 0; chunk < pc.in_channels; chunk++) {
        let at = pc.state_at + (chunk * threads + t) * 2 * STATE;
        [ForceUnroll]
        for (uint s = 0; s < STATE; s++) {
            let end = wide_dst[at + s];
            let decay = wide_dst[at + STATE + s];
            wide_dst[at + s] = carry[s];
            carry[s] = decay * carry[s] + end;
        }
    }
}

/// The third: each chunk run again from the state it starts from, writing `y`.
[shader("compute")]
[numthreads(THREADS, 1, 1)]
void scan_out(uint3 id : SV_DispatchThreadID)
{
    let e = index(id);
    if (e >= pc.count) { return; }
    let threads = pc.extra3 * 4;
    let t = e % threads;
    let chunk = e / threads;
    float state[STATE];
    float decay[STATE];
    let at = pc.state_at + e * 2 * STATE;
    [ForceUnroll]
    for (uint s = 0; s < STATE; s++) { state[s] = wide_dst[at + s]; }
    scan_chunk(t, chunk, state, decay, true);
}

/// The four directions' `y` in `wide_src` summed into `wide_dst`, `[D][L]`.
[shader("compute")]
[numthreads(THREADS, 1, 1)]
void sum4(uint3 id : SV_DispatchThreadID)
{
    let e = index(id);
    if (e >= pc.count) { return; }
    let quarter = pc.count;
    let at = pc.src_at + e;
    wide_dst[pc.dst_at + e] = wide_src[at] + wide_src[at + quarter] + wide_src[at + times(quarter, 2)] + wide_src[at + times(quarter, 3)];
}

// --- Channel attention ----------------------------------------------------------------------

static const uint REDUCE = 256;
groupshared float reduce_qq[REDUCE];
groupshared float reduce_kk[REDUCE];
groupshared float reduce_qk[REDUCE];

/// Channel attention logits, `normalize(q) . normalize(k) * temperature[head]`, one workgroup an
/// entry, `span` workgroups a row: `src` is q, `src2` k, `extra0` heads, `extra1` where the
/// temperatures start, `in_channels` C; `dst` takes the `C x C` matrix, zero outside the blocks.
[shader("compute")]
[numthreads(REDUCE, 1, 1)]
void gram(uint3 group : SV_GroupID, uint lane : SV_GroupIndex)
{
    let e = group.y * pc.span + group.x;
    let c = pc.in_channels;
    if (e >= c * c) { return; }
    let i = e / c;
    let j = e % c;
    let per_head = c / pc.extra0;
    if (i / per_head != j / per_head) {
        if (lane == 0) { dst[pc.dst_at + e] = 0.0; }
        return;
    }
    let plane = pc.width * pc.height;
    var qq = 0.0;
    var kk = 0.0;
    var qk = 0.0;
    for (uint p = lane; p < plane; p += REDUCE) {
        let q = float(src[pc.src_at + i * plane + p]);
        let k = float(src2[pc.src2_at + j * plane + p]);
        qq += q * q;
        kk += k * k;
        qk += q * k;
    }
    reduce_qq[lane] = qq;
    reduce_kk[lane] = kk;
    reduce_qk[lane] = qk;
    GroupMemoryBarrierWithGroupSync();
    for (uint stride = REDUCE / 2; stride > 0; stride /= 2) {
        if (lane < stride) {
            reduce_qq[lane] += reduce_qq[lane + stride];
            reduce_kk[lane] += reduce_kk[lane + stride];
            reduce_qk[lane] += reduce_qk[lane + stride];
        }
        GroupMemoryBarrierWithGroupSync();
    }
    if (lane == 0) {
        let norms = max(sqrt(reduce_qq[0]), 1e-12) * max(sqrt(reduce_kk[0]), 1e-12);
        dst[pc.dst_at + e] = reduce_qk[0] / norms * weights[pc.extra1 + i / per_head];
    }
}

/// Softmax along each row's own head block of `gram`'s matrix, in place.
[shader("compute")]
[numthreads(THREADS, 1, 1)]
void softmax(uint3 id : SV_DispatchThreadID)
{
    let i = index(id);
    if (i >= pc.count) { return; }
    let c = pc.in_channels;
    let per_head = c / pc.extra0;
    let first = (i / per_head) * per_head;
    let row = pc.dst_at + i * c;
    var top = -1e30;
    for (uint j = first; j < first + per_head; j++) { top = max(top, dst[row + j]); }
    var sum = 0.0;
    for (uint j = first; j < first + per_head; j++) {
        let v = exp(dst[row + j] - top);
        dst[row + j] = v;
        sum += v;
    }
    for (uint j = first; j < first + per_head; j++) { dst[row + j] = Stored(float(dst[row + j]) / sum); }
}

// --- DINOv2 ---------------------------------------------------------------------------------

/// One axis of `F.interpolate(mode="bilinear", antialias=True)`, torch's own index and weight
/// arithmetic: `width` x `height` in, `extra0` the output's length along the axis, `extra1` 1 to
/// resize rows (along x) or 0 columns. `count` is channels times the output plane.
[shader("compute")]
[numthreads(THREADS, 1, 1)]
void resize_axis(uint3 id : SV_DispatchThreadID)
{
    let e = index(id);
    if (e >= pc.count) { return; }
    let along_x = pc.extra1 != 0;
    let out_w = along_x ? pc.extra0 : pc.width;
    let out_h = along_x ? pc.height : pc.extra0;
    let plane = out_w * out_h;
    let c = e / plane;
    let p = e % plane;
    let oy = p / out_w;
    let ox = p % out_w;
    let size_in = along_x ? pc.width : pc.height;
    let o = along_x ? ox : oy;
    let scale = float(size_in) / float(pc.extra0);
    let center = scale * (float(o) + 0.5);
    let support = scale >= 1.0 ? scale : 1.0;
    let invscale = scale >= 1.0 ? 1.0 / scale : 1.0;
    let first = max(int(center - support + 0.5), 0);
    let size = min(int(center + support + 0.5), int(size_in)) - first;
    var total = 0.0;
    var sum = 0.0;
    let in_plane = pc.width * pc.height;
    for (int j = 0; j < size; j++) {
        let w = max(0.0, 1.0 - abs((float(j + first) - center + 0.5) * invscale));
        let at = along_x ? oy * pc.width + uint(j + first) : uint(j + first) * pc.width + ox;
        sum += w * src[pc.src_at + c * in_plane + at];
        total += w;
    }
    dst[pc.dst_at + e] = total > 0.0 ? sum / total : 0.0;
}

/// Coded light, clamped to [0, 1] and standardised by ImageNet's mean and spread per channel.
[shader("compute")]
[numthreads(THREADS, 1, 1)]
void standardise(uint3 id : SV_DispatchThreadID)
{
    let e = index(id);
    if (e >= pc.count) { return; }
    let c = e / pc.width;
    let mean = c == 0 ? 0.485 : (c == 1 ? 0.456 : 0.406);
    let spread = c == 0 ? 0.229 : (c == 1 ? 0.224 : 0.225);
    dst[pc.dst_at + e] = (clamp(dst[pc.dst_at + e], 0.0, 1.0) - mean) / spread;
}

/// The tokens: the class token then each patch's embedding, each plus its position. `src` is the
/// patches `[D][N]`, `src2` the positions `[D][1 + N]` the host interpolated, `weight_at` the class
/// token, `width` N.
[shader("compute")]
[numthreads(THREADS, 1, 1)]
void tokens(uint3 id : SV_DispatchThreadID)
{
    let e = index(id);
    if (e >= pc.count) { return; }
    let tokens = pc.width + 1;
    let d = e / tokens;
    let t = e % tokens;
    let embedded = t == 0 ? weights[pc.weight_at + d] : src[pc.src_at + d * pc.width + t - 1];
    dst[pc.dst_at + e] = Stored(float(embedded) + src2[pc.src2_at + e]);
}

static const uint HEAD = 64;
static const uint KEYS = 32;
groupshared float keys_tile[HEAD][KEYS];
groupshared float values_tile[HEAD][KEYS];

/// Softmax attention of each head, one query a thread, keys in tiles with a running softmax:
/// `src` is `qkv`, `[3 * D][T]`, `dst` the attended `[D][T]`; `width` T, `extra0` heads.
[shader("compute")]
[numthreads(THREADS, 1, 1)]
void attention(uint3 group : SV_GroupID, uint lane : SV_GroupIndex)
{
    let tokens = pc.width;
    let head = group.y;
    let query = group.x * THREADS + lane;
    let dim = pc.extra0 * HEAD;
    let q_at = pc.src_at + head * HEAD * tokens;
    let k_at = q_at + dim * tokens;
    let v_at = k_at + dim * tokens;
    let live = query < tokens;
    float q[HEAD];
    float sums[HEAD];
    // A running place rather than `d * tokens`: unrolled, that is a runtime multiply by 3.
    var place = q_at + query;
    [ForceUnroll]
    for (uint d = 0; d < HEAD; d++) {
        q[d] = live ? src[place] * pc.scale : 0.0;
        sums[d] = 0.0;
        place += tokens;
    }
    var top = -1e30;
    var total = 0.0;
    for (uint first = 0; first < tokens; first += KEYS) {
        for (uint cell = lane; cell < HEAD * KEYS; cell += THREADS) {
            let d = cell / KEYS;
            let key = cell % KEYS;
            let t = first + key;
            keys_tile[d][key] = t < tokens ? src[k_at + d * tokens + t] : 0.0;
            values_tile[d][key] = t < tokens ? src[v_at + d * tokens + t] : 0.0;
        }
        GroupMemoryBarrierWithGroupSync();
        let here = min(KEYS, tokens - first);
        for (uint key = 0; key < here; key++) {
            var logit = 0.0;
            [ForceUnroll]
            for (uint d = 0; d < HEAD; d++) { logit += q[d] * keys_tile[d][key]; }
            let raised = max(top, logit);
            let shrink = exp(top - raised);
            let weight = exp(logit - raised);
            total = total * shrink + weight;
            [ForceUnroll]
            for (uint d = 0; d < HEAD; d++) { sums[d] = sums[d] * shrink + weight * values_tile[d][key]; }
            top = raised;
        }
        GroupMemoryBarrierWithGroupSync();
    }
    if (!live) { return; }
    var out = pc.dst_at + head * HEAD * tokens + query;
    [ForceUnroll]
    for (uint d = 0; d < HEAD; d++) {
        dst[out] = sums[d] / total;
        out += tokens;
    }
}

/// The patch descriptions, `[D][1 + rows * columns]` with the class token first, spread over the
/// `width` x `height` coarsest level bilinearly as `F.interpolate(align_corners=False)` does:
/// `extra0` columns, `extra1` rows.
[shader("compute")]
[numthreads(THREADS, 1, 1)]
void spread(uint3 id : SV_DispatchThreadID)
{
    let e = index(id);
    if (e >= pc.count) { return; }
    let plane = pc.width * pc.height;
    let d = e / plane;
    let p = e % plane;
    let y = p / pc.width;
    let x = p % pc.width;
    let columns = pc.extra0;
    let rows = pc.extra1;
    let fy = max((float(y) + 0.5) * float(rows) / float(pc.height) - 0.5, 0.0);
    let fx = max((float(x) + 0.5) * float(columns) / float(pc.width) - 0.5, 0.0);
    let y0 = min(uint(fy), rows - 1);
    let x0 = min(uint(fx), columns - 1);
    let y1 = min(y0 + 1, rows - 1);
    let x1 = min(x0 + 1, columns - 1);
    let wy = fy - float(y0);
    let wx = fx - float(x0);
    let tokens = rows * columns + 1;
    let at = pc.src_at + d * tokens + 1;
    let top = src[at + y0 * columns + x0] * (1.0 - wx) + src[at + y0 * columns + x1] * wx;
    let bottom = src[at + y1 * columns + x0] * (1.0 - wx) + src[at + y1 * columns + x1] * wx;
    dst[pc.dst_at + e] = top * (1.0 - wy) + bottom * wy;
}

// --- Crossing to the frame's planes ---------------------------------------------------------

/// `x` rounded to bfloat16, to nearest even, as torch's `to(torch.bfloat16)`.
float bfloat16(float x)
{
    let bits = asuint(x);
    return asfloat((bits + 0x7fffu + ((bits >> 16) & 1u)) & 0xffff0000u);
}

/// The network's input from the frame's `float` planes, rounded to bfloat16 as it trained on it.
[shader("compute")]
[numthreads(THREADS, 1, 1)]
void admit(uint3 id : SV_DispatchThreadID)
{
    let e = index(id);
    if (e >= pc.count) { return; }
    dst[pc.dst_at + e] = Stored(bfloat16(wide_src[pc.src_at + e]));
}

[shader("compute")]
[numthreads(THREADS, 1, 1)]
void widen(uint3 id : SV_DispatchThreadID)
{
    let e = index(id);
    if (e >= pc.count) { return; }
    wide_dst[pc.dst_at + e] = float(src[pc.src_at + e]);
}
