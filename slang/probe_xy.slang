// `white_balance`'s forward map, reachable on its own.
//
// `the_shader_solves_the_illuminant_this_crate_reads_back` runs this against the `as_shot` entry
// point's inverse over the slider's whole range. A probe rather than a rendition because a matrix
// that happens to look plausible is exactly what that test refuses to accept, and `xy_of` is
// upstream of the matrix.
import edit;
import white_balance;

[shader("compute")]
[numthreads(1, 1, 1)]
void probe_xy()
{
    let xy = xy_of(edit.temperature, edit.tint);
    balance_out[0] = xy.x;
    balance_out[1] = xy.y;
}
