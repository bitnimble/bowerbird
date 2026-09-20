// The table's own ends, once every entry has been written.
//
// Its own dispatch because `build_inv_lut` fills the entries in
// parallel and no invocation there can see both ends.
import prelude;

[vk::binding(0, 0)] StructuredBuffer<float> lut_d;
[vk::binding(1, 0)] RWStructuredBuffer<float> lut_params;

[shader("compute")]
[numthreads(256, 1, 1)]
void lut_finalize(uint3 id : SV_DispatchThreadID)
{
    if (id.x != 0) { return; }
    lut_params[0] = lut_d[0];
    lut_params[1] = lut_d[LUT_SIZE - 1];
}
