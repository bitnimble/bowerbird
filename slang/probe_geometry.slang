// `geometry_at` over every output pixel, so `the_draw_places_a_pixel_where_the_gather_does`
// can hold it against `image::Plan::at`.
//
// The mapping is four lines of arithmetic on each side and nothing else compares them: the
// editor draws through this one, and Rust needs its own to work out what a cropped render has
// to decode.
import edit;
import geometry;

[vk::binding(6, 0)] RWStructuredBuffer<float> probe_out;

[shader("compute")]
[numthreads(64, 1, 1)]
void probe_geometry(uint3 id : SV_DispatchThreadID)
{
    let out = uint2(edit.output_width, edit.output_height);
    if (id.x >= out.x * out.y) { return; }
    // Pixel centres, which is what a fragment carries: `geometry_at` speaks in positions, and
    // handing it indices would agree with a gather that had the same bug.
    let at = geometry_at(float2(float(id.x % out.x) + 0.5, float(id.x / out.x) + 0.5));
    probe_out[id.x * 2] = at.x;
    probe_out[id.x * 2 + 1] = at.y;
}
