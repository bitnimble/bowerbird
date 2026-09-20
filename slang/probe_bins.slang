// `peak`'s `bin_of` over values the colour transform can genuinely hand it.
//
// `the_histogram_bins_a_nan_and_an_infinity_somewhere_defined` feeds this a NaN and an infinity
// through the histogram buffer's own bits. A conversion undefined there is not a rounding
// difference - one driver puts it at the top of the histogram, where it shifts the quantile,
// and another at the bottom, where it does not.
import peak;

[shader("compute")]
[numthreads(1, 1, 1)]
void probe_bins()
{
    for (uint i = 0; i < 4; i = i + 1) {
        peak_out[i] = float(bin_of(asfloat(histogram[i].load())));
    }
}
