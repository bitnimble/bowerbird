// Phase 2(a): the four per-slot dark references, from every workgroup's partials.
import prelude;

[vk::binding(0, 0)] StructuredBuffer<float> partial_buf;
[vk::binding(1, 0)] RWStructuredBuffer<float> params;

struct Push {
    int n_wg;
};
[vk::binding(20, 0)] ConstantBuffer<Push> pc;

[shader("compute")]
[numthreads(256, 1, 1)]
void dark_ref_finalize_mwg(uint3 id : SV_DispatchThreadID)
{
    if (id.x != 0) { return; }

    var sw = tally();
    var sw0 = tally();
    var sw1 = tally();
    var sw2 = tally();
    var sw3 = tally();
    for (int i = 0; i < pc.n_wg; i++) {
        tally_push(sw, partial_buf[i * 5 + 0]);
        tally_push(sw0, partial_buf[i * 5 + 1]);
        tally_push(sw1, partial_buf[i * 5 + 2]);
        tally_push(sw2, partial_buf[i * 5 + 3]);
        tally_push(sw3, partial_buf[i * 5 + 4]);
    }

    let inv_sw = 1.0 / max(tally_sum(sw), 1e-20);
    params[P_DARK_REF0 + 0] = tally_sum(sw0) * inv_sw;
    params[P_DARK_REF0 + 1] = tally_sum(sw1) * inv_sw;
    params[P_DARK_REF0 + 2] = tally_sum(sw2) * inv_sw;
    params[P_DARK_REF0 + 3] = tally_sum(sw3) * inv_sw;
}
