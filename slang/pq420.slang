// A drawn frame as ten-bit PQ BT.2020 4:2:0 in video range: the planes the editor's VP9 encoder
// takes on Firefox, whose compositor shows HDR for video and nothing else (DESIGN §21.2).
//
// The frame holds what a canvas would: Display P3 over SDR white, through the sRGB curve with the
// sign kept (`frame.slang`'s `fs`). That is undone to the nits the platform shows a PQ video's SDR
// range at (`sdr_match.slang`), so the video sits where the same photo drawn SDR does.
//
// Two samples to a word, the left one in the low half: the little-endian `u16` rows the encoder
// reads. Each lane codes a four-by-two block of luma and the two chroma samples over it, sited
// with the left luma column of each pair and between its two rows, as the MP4's `vpcC` says. Where the
// planes are and how long their rows are is the host's (`gpu::Pq420Layout`), so a lane past the
// picture's right or bottom edge writes padding the encoder never reads.
import light;
import prelude;
import primaries;
import sdr_match;
import video_range;

struct Planes {
    uint width;
    uint height;
    /// In words, as every offset here is.
    uint luma_stride;
    uint chroma_stride;
    uint cb_at;
    uint cr_at;
    float white;
    uint reads_sdr_as_power;
};

[vk::binding(0, 0)] Texture2D<float4> drawn;
[vk::binding(1, 0)] RWStructuredBuffer<uint> packed;
[vk::binding(2, 0)] ConstantBuffer<Planes> planes;

float3 video_at(int x, int y)
{
    let held = clamp(int2(x, y), int2(0), int2(int(planes.width) - 1, int(planes.height) - 1));
    let canvas = measured<P3Linear>(srgb_eotf_signed(drawn.Load(int3(held, 0)).rgb));
    let whites = mul(P3_TO_R2020, canvas.v);
    let nits = matched(whites, measured<DisplayNits>(planes.white), planes.reads_sdr_as_power).v;
    let signal = float3(
        pq(measured<DisplayNits>(nits.r)).v,
        pq(measured<DisplayNits>(nits.g)).v,
        pq(measured<DisplayNits>(nits.b)).v);
    return video_of_pq(measured<Pq>(signal));
}

uint pair(float first, float second)
{
    let codes = uint2(clamp(round(float2(first, second)), float2(0.0), float2(1023.0)));
    return codes.x | (codes.y << 16);
}

float2 sited(float3 left_top, float3 centre_top, float3 right_top, float3 left_bottom, float3 centre_bottom, float3 right_bottom)
{
    let sum = left_top.yz + 2.0 * centre_top.yz + right_top.yz
        + left_bottom.yz + 2.0 * centre_bottom.yz + right_bottom.yz;
    return sum / 8.0;
}

[shader("compute")]
[numthreads(8, 8, 1)]
void pack_pq420(uint3 id : SV_DispatchThreadID)
{
    if (id.x * 4 >= planes.width || id.y * 2 >= planes.height) { return; }
    let left = int(id.x) * 4;
    let top = int(id.y) * 2;

    let t0 = video_at(left - 1, top);
    let t1 = video_at(left, top);
    let t2 = video_at(left + 1, top);
    let t3 = video_at(left + 2, top);
    let t4 = video_at(left + 3, top);
    let b0 = video_at(left - 1, top + 1);
    let b1 = video_at(left, top + 1);
    let b2 = video_at(left + 1, top + 1);
    let b3 = video_at(left + 2, top + 1);
    let b4 = video_at(left + 3, top + 1);

    let luma_top = uint(top) * planes.luma_stride + id.x * 2;
    let luma_bottom = luma_top + planes.luma_stride;
    packed[luma_top] = pair(t1.x, t2.x);
    packed[luma_top + 1] = pair(t3.x, t4.x);
    packed[luma_bottom] = pair(b1.x, b2.x);
    packed[luma_bottom + 1] = pair(b3.x, b4.x);

    let first = sited(t0, t1, t2, b0, b1, b2);
    let second = sited(t2, t3, t4, b2, b3, b4);
    let chroma = id.y * planes.chroma_stride + id.x;
    packed[planes.cb_at + chroma] = pair(first.x, second.x);
    packed[planes.cr_at + chroma] = pair(first.y, second.y);
}
