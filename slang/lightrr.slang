// The reflection remover's forward pass (`models/dereflect/src/dereflect/model.py`, LightRR), one
// dispatch an op over NCHW planes, each its own buffer.

struct Params {
    /// Threads a dispatch row, for the index past 65535 workgroups.
    uint span;
    uint count;
    uint width;
    uint height;
    uint in_channels;
    uint out_channels;
    uint kernel;
    uint pad;
    uint groups;
    uint has_bias;
    uint src_at;
    uint src2_at;
    uint dst_at;
    uint weight_at;
    uint bias_at;
    uint extra0;
    uint extra1;
    uint extra2;
    uint extra3;
    float eps;
    uint pad0;
    uint pad1;
    uint pad2;
    uint pad3;
};

[vk::binding(20, 0)] ConstantBuffer<Params> pc;
[vk::binding(0, 0)] StructuredBuffer<float> src;
[vk::binding(1, 0)] StructuredBuffer<float> weights;
[vk::binding(2, 0)] RWStructuredBuffer<float> dst;
[vk::binding(3, 0)] StructuredBuffer<float> src2;

static const uint THREADS = 64;
static const uint STATE = 16;

uint index(uint3 id)
{
    return id.y * pc.span + id.x;
}

float silu(float x)
{
    return x / (1.0 + exp(-x));
}

/// `nn.Conv2d(stride=1)`, any kernel, groups and padding, weights `[out][in / groups][k][k]`.
[shader("compute")]
[numthreads(THREADS, 1, 1)]
void conv(uint3 id : SV_DispatchThreadID)
{
    let e = index(id);
    if (e >= pc.count) { return; }
    let plane = pc.width * pc.height;
    let o = e / plane;
    let p = e % plane;
    let y = int(p / pc.width);
    let x = int(p % pc.width);
    let in_group = pc.in_channels / pc.groups;
    let out_group = pc.out_channels / pc.groups;
    let first = (o / out_group) * in_group;
    let k = pc.kernel;
    let taps = k * k;
    var sum = pc.has_bias != 0 ? weights[pc.bias_at + o] : 0.0;
    for (uint i = 0; i < in_group; i++) {
        let w_at = pc.weight_at + (o * in_group + i) * taps;
        let s_at = pc.src_at + (first + i) * plane;
        for (uint ky = 0; ky < k; ky++) {
            let yy = y + int(ky) - int(pc.pad);
            if (yy < 0 || yy >= int(pc.height)) { continue; }
            for (uint kx = 0; kx < k; kx++) {
                let xx = x + int(kx) - int(pc.pad);
                if (xx < 0 || xx >= int(pc.width)) { continue; }
                sum += weights[w_at + ky * k + kx] * src[s_at + uint(yy) * pc.width + uint(xx)];
            }
        }
    }
    dst[pc.dst_at + e] = sum;
}

/// `nn.LayerNorm(C)` over each pixel's channels.
[shader("compute")]
[numthreads(THREADS, 1, 1)]
void layernorm(uint3 id : SV_DispatchThreadID)
{
    let p = index(id);
    if (p >= pc.count) { return; }
    let plane = pc.width * pc.height;
    let c = pc.in_channels;
    var mean = 0.0;
    for (uint i = 0; i < c; i++) { mean += src[pc.src_at + i * plane + p]; }
    mean /= float(c);
    var variance = 0.0;
    for (uint i = 0; i < c; i++) {
        let d = src[pc.src_at + i * plane + p] - mean;
        variance += d * d;
    }
    let scale = 1.0 / sqrt(variance / float(c) + pc.eps);
    for (uint i = 0; i < c; i++) {
        let v = (src[pc.src_at + i * plane + p] - mean) * scale;
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

/// `y * silu(z)`.
[shader("compute")]
[numthreads(THREADS, 1, 1)]
void gate(uint3 id : SV_DispatchThreadID)
{
    let e = index(id);
    if (e >= pc.count) { return; }
    dst[pc.dst_at + e] = src[pc.src_at + e] * silu(src2[pc.src2_at + e]);
}

/// `x * skip_scale[c] + y`.
[shader("compute")]
[numthreads(THREADS, 1, 1)]
void scale_add(uint3 id : SV_DispatchThreadID)
{
    let e = index(id);
    if (e >= pc.count) { return; }
    let c = e / (pc.width * pc.height);
    dst[pc.dst_at + e] = src[pc.src_at + e] * weights[pc.weight_at + c] + src2[pc.src2_at + e];
}

/// `attention + kv * alpha + q * beta`, in place over the attention.
[shader("compute")]
[numthreads(THREADS, 1, 1)]
void fuse(uint3 id : SV_DispatchThreadID)
{
    let e = index(id);
    if (e >= pc.count) { return; }
    dst[pc.dst_at + e] += src[pc.src_at + e] * weights[pc.weight_at]
        + src2[pc.src2_at + e] * weights[pc.bias_at];
}

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
    let a = src[at];
    let b = src[at + 1];
    let cc = src[at + pc.width];
    let d = src[at + pc.width + 1];
    let band = pc.in_channels * half_plane;
    let out = pc.dst_at + c * half_plane + p;
    dst[out] = 0.5 * (a + b + cc + d);
    dst[out + band] = 0.5 * (a + b - cc - d);
    dst[out + 2 * band] = 0.5 * (a - b + cc - d);
    dst[out + band + 2 * band] = 0.5 * (a - b - cc + d);
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
    let ll = src[at];
    let lh = src[at + band];
    let hl = src[at + 2 * band];
    let hh = src[at + band + 2 * band];
    let wide = 2 * pc.width;
    let out = pc.dst_at + c * half_plane * 4 + 2 * i * wide + 2 * j;
    dst[out] = 0.5 * (ll + lh + hl + hh);
    dst[out + 1] = 0.5 * (ll + lh - hl - hh);
    dst[out + wide] = 0.5 * (ll - lh + hl - hh);
    dst[out + wide + 1] = 0.5 * (ll - lh - hl + hh);
}

/// Where step `l` of direction `k` sits in a row-major `h x w` plane: rows, columns, then both
/// reversed, as `forward_core` unrolls them.
uint scan_place(uint k, uint l, uint h, uint w)
{
    let n = w * h;
    let along = k >= 2 ? n - 1 - l : l;
    if ((k & 1) == 0) { return along; }
    return (along % h) * w + along / h;
}

/// The four-direction selective scan, one thread a direction and inner channel, sequential along
/// the plane. `src` is the LL band `[D][L]`, `src2` the `x_proj` output `[K][R + 2N][L]`, and
/// `dst` takes each direction's `y` at its own place, `[K][D][L]`.
///
/// `extra0` is where `A_logs` start, `extra1` `Ds`, `extra2` the rank, `extra3` D.
[shader("compute")]
[numthreads(THREADS, 1, 1)]
void scan(uint3 id : SV_DispatchThreadID)
{
    let t = index(id);
    if (t >= pc.count) { return; }
    let inner = pc.extra3;
    let rank = pc.extra2;
    let k = t / inner;
    let d = t % inner;
    let h = pc.height;
    let w = pc.width;
    let n = h * w;
    let rows = rank + 2 * STATE;
    let x_dbl = pc.src2_at + k * rows * n;

    var a: float[STATE];
    var state: float[STATE];
    for (uint s = 0; s < STATE; s++) {
        a[s] = -exp(weights[pc.extra0 + t * STATE + s]);
        state[s] = 0.0;
    }
    let skip = weights[pc.extra1 + t];
    let bias = weights[pc.bias_at + t];
    let dt_at = pc.weight_at + t * rank;

    for (uint l = 0; l < n; l++) {
        let p = scan_place(k, l, h, w);
        var raw = bias;
        for (uint r = 0; r < rank; r++) { raw += weights[dt_at + r] * src2[x_dbl + r * n + p]; }
        let delta = raw > 20.0 ? raw : log(1.0 + exp(raw));
        let u = src[pc.src_at + d * n + p];
        var y = skip * u;
        for (uint s = 0; s < STATE; s++) {
            let b = src2[x_dbl + (rank + s) * n + p];
            let c = src2[x_dbl + (rank + STATE + s) * n + p];
            state[s] = exp(delta * a[s]) * state[s] + delta * b * u;
            y += c * state[s];
        }
        dst[pc.dst_at + t * n + p] = y;
    }
}

/// The four directions' sum, over `dst`'s first D channels (the LL band the scan read).
[shader("compute")]
[numthreads(THREADS, 1, 1)]
void sum4(uint3 id : SV_DispatchThreadID)
{
    let e = index(id);
    if (e >= pc.count) { return; }
    let quarter = pc.count;
    let at = pc.src_at + e;
    dst[pc.dst_at + e] = src[at] + src[at + quarter] + src[at + 2 * quarter] + src[at + quarter + 2 * quarter];
}

/// Channel attention logits, `normalize(q) . normalize(k) * temperature[head]`, as a `C x C`
/// matrix with zero outside each head's block. `src` is q, `src2` k, `extra0` heads, `extra1`
/// where the temperatures start.
[shader("compute")]
[numthreads(THREADS, 1, 1)]
void gram(uint3 id : SV_DispatchThreadID)
{
    let e = index(id);
    if (e >= pc.count) { return; }
    let c = pc.in_channels;
    let i = e / c;
    let j = e % c;
    let per_head = c / pc.extra0;
    if (i / per_head != j / per_head) {
        dst[e] = 0.0;
        return;
    }
    let plane = pc.width * pc.height;
    var qq = 0.0;
    var kk = 0.0;
    var qk = 0.0;
    for (uint p = 0; p < plane; p++) {
        let q = src[pc.src_at + i * plane + p];
        let k = src2[pc.src2_at + j * plane + p];
        qq += q * q;
        kk += k * k;
        qk += q * k;
    }
    let norms = max(sqrt(qq), 1e-12) * max(sqrt(kk), 1e-12);
    dst[e] = qk / norms * weights[pc.extra1 + i / per_head];
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
    var top = -1e30;
    for (uint j = first; j < first + per_head; j++) { top = max(top, dst[i * c + j]); }
    var sum = 0.0;
    for (uint j = first; j < first + per_head; j++) {
        let v = exp(dst[i * c + j] - top);
        dst[i * c + j] = v;
        sum += v;
    }
    for (uint j = first; j < first + per_head; j++) { dst[i * c + j] /= sum; }
}
