// Light that knows which domain it is a quantity in, and whether it is a quantity or a ratio.
//
// `native/rawshim/src/light.rs` on this side of the boundary, and for the same reason: a
// photograph crosses twelve domains between the sensor and the canvas - scene-linear counts, the
// assemble stage's fraction of full scale, nits against its own diffuse white, the scene at white
// 1, the camera's own rendering, that rendering at white 1, nits at the display, the display's
// peak at 1, two gamuts and two codings - and every one of them was a bare `float3`. The render harness that graded sRGB at the HDR peak
// wrote five stops of highlight into eight bits and came out flat; the pyramid that averaged the
// frame's codes averaged a curve rather than a light.
//
// So the domains divide, exactly as they do on the host:
//
// - A domain whose unit a standard fixes is `IStandard`, and `exactly` will take a constant of it.
// - A domain anchored on something measured is not. `Rendered` sits at whatever the body's own
//   JPEG made of diffuse white, and `Signal` at whatever peak the rendition targets - 203 nits on
//   an SDR one and 1000 on an HDR one - so a constant in either is a different brightness every
//   time it is read. Those get numbers through `measured`, at the boundary that measured them.
// - `ILinear` is where light adds. A weighted sum of PQ codes is not a light, which is why
//   `frame.slang`'s pyramid decodes each tap before it weighs it.
// - `IWhiteAtOne` is where 1.0 is diffuse white, which is what lets `adjust.slang` be written once
//   and run over the scene on the neutral arm and over the camera's rendering on the matched one.
//
// **Nothing here survives into the WGSL.** A `Colour` is one `float3` in a struct with no methods
// that touch memory, and Slang monomorphises the generic away, so what a host binds and what a
// lane reads are the numbers they always were. `the_generic_lights_cost_nothing` holds that.
//
// **The type guards a stage's boundary, not every operation inside one.** A body unwraps `.v` at
// the top and wraps its answer at the end, which is where the domain actually changes; the
// arithmetic between is one domain by construction and has nothing to confuse. That is also what
// keeps the hot paths honest: `no_struct_returns_under_a_loop` refuses a struct returned by value
// under a loop, so the frame's own fetches - `nits_at`, `nits_cubic`, `pyramid_cubic` - stay
// `float3` and `covered` wraps once for all four of its taps.
module light;

/// A set of units a number in this pipeline can be a number of.
public interface IDomain {}

/// A domain where a weighted sum of samples is the light they carry.
///
/// The coded domains are not: averaging PQ or sRGB gives a number no photograph has.
public interface ILinear : IDomain {}

/// A domain whose unit a standard fixes, so a constant in it means one thing on every photograph
/// and at every output.
public interface IStandard : IDomain {}

/// A domain where 1.0 is diffuse white.
///
/// Middle grey is not the same number in the two that are, which is why `adjusted` takes its pivot
/// rather than assuming one.
public interface IWhiteAtOne : IStandard, ILinear {}

/// A domain measured in absolute nits, which is the only thing ST 2084 codes.
///
/// **Two of them, and `pq_inv` cannot tell which it is handing back.** The curve is absolute, so
/// what comes out of it is real nits either way - but whether those are the scene's, as
/// `decode.slang`'s table means them, or the display's, as `roll` means them, is the caller's to
/// name. So it names one, and the compiler holds it to that afterwards.
public interface INits : ILinear, IStandard {}

/// The decode's own scene-linear counts, before the coding.
///
/// **Counts, not a fraction of them** - `fit_scan` reports a `u16` and `Light::COUNT` is one of
/// them. What `assemble` holds on the way to writing one is `Assembled`.
///
/// Not `IStandard`: the decode scales sensor saturation to full range whatever the photographer
/// metered, so a level is a fraction of a container rather than a brightness.
public struct Level : ILinear {}

/// `assemble`'s own working colour: Rec.2020, scene-linear, as a fraction of full scale.
///
/// A `Level` divided by the container it is about to be multiplied back into, which is a
/// different number for the same light - so it is a different domain, and `within(colour, 1.0)`
/// there means full scale where the grade's means a display's peak.
public struct Assembled : ILinear, IStandard {}

/// Scene-linear nits, the photograph's own diffuse white anchored at `edit.reference`.
public struct SceneNits : INits {}

/// `SceneNits` over the reference, where diffuse white is 1 and middle grey is `PIVOT`.
public struct Scene : IWhiteAtOne {}

/// The camera's own rendering: past its tone curve, its matrix and its chroma lattice.
///
/// Not `IStandard`. The fit's target is the body's own JPEG, so diffuse white comes out wherever
/// that body put it - `matched_white` measures it per frame, two stops apart across two fixtures.
public struct Rendered : ILinear {}

/// `Rendered` over that measured white, where diffuse white is 1 again.
public struct Graded : IWhiteAtOne {}

/// Absolute nits at the display, bounded by the target's peak.
public struct DisplayNits : INits {}

/// `DisplayNits` over that peak, in 0..1, still Rec.2020 and still linear.
///
/// **Not `IStandard`: this is where SDR and HDR part.** `job::peak_nits` gives an sRGB target its
/// peak at diffuse white and a PQ target the mastering peak, so 1.0 here is 203 nits or 1000.
public struct Signal : ILinear {}

/// `Signal` through `R2020_TO_SRGB`: sRGB primaries, still linear, still at the target's peak.
public struct SrgbLinear : ILinear {}

/// `DisplayNits` through `R2020_TO_P3` over the browser's 203, which is what a canvas takes.
public struct P3Linear : ILinear, IStandard {}

/// ST 2084 over an `INits`. Absolute, which is the whole of what PQ is for.
public struct Pq : IStandard {}

/// The sRGB transfer over `SrgbLinear`: what an SDR rendition holds.
public struct Srgb : IDomain {}

/// A quantity of light, in the units of `D`.
public struct Light<D : IDomain> {
    public float v;
}

/// Three of them: a colour, in the units of `D`.
public struct Colour<D : IDomain> {
    public float3 v;
}

/// A ratio of two lights in one domain: an exposure, a saturation, what a roll-off gave back.
///
/// Belonging to no domain, because it left with the units - which is what lets it cross a whole
/// stage and still be the same picture.
public struct Gain {
    public float g;
}

/// That ratio in log units, which is where the pipeline reasons about light.
///
/// The photographer's exposure, the tone zones' reach, how far a neighbourhood may move a pixel.
/// `gain_of` and `stops_of` are the `exp2` and the `log2` with a name on them, stated once
/// rather than by each host for itself: "a caller sent stops where a multiplier belongs" is the
/// mistake a guard refusing a non-positive gain exists to catch.
public struct Stops {
    public float s;
}

/// A number entering a domain a standard fixes the unit of.
public Light<D> exactly<D : IStandard>(float v)
{
    Light<D> light;
    light.v = v;
    return light;
}

public Colour<D> exactly<D : IStandard>(float3 v)
{
    Colour<D> colour;
    colour.v = v;
    return colour;
}

/// A frame, a display or a uniform that exists, measured.
///
/// Rare on purpose, and the only way into a domain with no fixed unit. It belongs where a value
/// arrives from the uniform or off the frame and nowhere else, because everything downstream can
/// be derived.
public Light<D> measured<D : IDomain>(float v)
{
    Light<D> light;
    light.v = v;
    return light;
}

public Colour<D> measured<D : IDomain>(float3 v)
{
    Colour<D> colour;
    colour.v = v;
    return colour;
}

public Gain gain(float ratio)
{
    Gain g;
    g.g = ratio;
    return g;
}

public Stops stops(float s)
{
    Stops st;
    st.s = s;
    return st;
}

public Gain gain_of(Stops s)
{
    return gain(exp2(s.s));
}

public Stops stops_of(Gain g)
{
    return stops(log2(g.g));
}

/// Two lights in one domain make a ratio, which is the only way out of a domain that keeps its
/// meaning.
public Gain over<D : ILinear>(Light<D> of, Light<D> by)
{
    return gain(of.v / by.v);
}

public Colour<D> times<D : ILinear>(Colour<D> colour, Gain by)
{
    return measured<D>(colour.v * by.g);
}
