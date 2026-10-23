// `packed`'s `code_of_pq_light` and `code_of_level_light` over every light
// `the_code_searches_land_where_a_whole_table_search_does` feeds them, each float's bits replaced by
// its code.
import packed;

[vk::binding(0, 0)] StructuredBuffer<float> table;
[vk::binding(1, 0)] RWStructuredBuffer<uint> words;

uint count()
{
    uint count;
    uint stride;
    words.GetDimensions(count, stride);
    return count;
}

[shader("compute")]
[numthreads(64, 1, 1)]
void probe_pq_codes(uint3 id : SV_DispatchThreadID)
{
    if (id.x >= count()) { return; }
    words[id.x] = code_of_pq_light(table, asfloat(words[id.x]));
}

[shader("compute")]
[numthreads(64, 1, 1)]
void probe_level_codes(uint3 id : SV_DispatchThreadID)
{
    if (id.x >= count()) { return; }
    words[id.x] = code_of_level_light(table, asfloat(words[id.x]));
}
