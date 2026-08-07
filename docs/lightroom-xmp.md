# Camera Raw XMP: import specification

Date: 2026-08-07. Status: spec, not built.

What an `.xmp` sidecar (or embedded XMP packet) written by Lightroom / Adobe Camera
Raw contains, and what Bowerbird reads out of it.

Scope is **read-only import**. Nothing here writes XMP.

---

## 1. What this has to produce

One function plus a Zod schema and its tests. That is the entire deliverable.

```ts
function parseXmp(xml: string): XmpSettings | null;
```

Null means the input was not usable XMP at all (§9.4). It does not throw: this
sits on a library-scan path where one unreadable file must not fail the scan, the
same reason `exif_zone.ts` returns null rather than throwing.

It does not touch the filesystem, LibRaw, or the database: callers hand it a string
and get a struct. Mapping `XmpSettings` onto Bowerbird's own edit parameters is a
separate piece of work and is **not** specified here; the two models are
deliberately decoupled, because this one is dictated by an external format and ours
is not.

### 1.1 The boundary, and why it is here

**Bowerbird has no edit persistence yet.** There is no edits table; the schema is
libraries, shoots, photos, albums, stacks and settings. A sidecar has nowhere to
land today.

That is the reason for the split, not an accident of it. A pure
`string -> XmpSettings` function has no dependency on storage that doesn't exist,
so it can be written, tested and finished now, against fixture strings alone. The
alternative, waiting for the edit model, would either block this work or invent a
storage shape to import into, and an external format is the worst possible thing to
let dictate our own.

**This deliverable owns:** XML/RDF parsing (§3), process-version gating (§4),
parameter extraction with types, ranges and defaults (§5 to §8, §11), clamping and
issue collection (§9), and recording what it didn't support (§10). Its only output
is the struct.

**A later deliverable owns**, and this spec deliberately does not describe:

- Locating a sidecar for a photo, and the base-name collision in §2
- Resolving null as-shot white balance against the camera's recorded neutral (§5.1)
- Resolving `crs:CameraProfile` / `crs:Look` to anything renderable (§7, §8)
- Deciding whether to derive approximate current-generation tones from `legacyTone`
  (§4.3)
- Comparing `crs:RawFileName` / `photoshop:SidecarForExtension` against the file
  actually matched (§11)
- Reconciling `tiff:Orientation` against the raw's own orientation (§6.1)
- **Applying the geometry**: orientation, distortion, upright, straighten, crop,
  post-crop effects, in the order at §6.4
- **Closing the one verification this deliverable cannot** (§12.2)
- **Re-importing when an `unsupported` feature later becomes supported** (§10)
- Anything shown to a user: `unsupported` warnings, `issues`, unreproduced
  geometry, `alreadyApplied`, `legacy`
- The edit model itself, and storing any of this

Where a section below mentions one of those, it is naming what the struct must
carry so the later work is possible, not assigning the behaviour here. The test for
whether something belongs in this deliverable: **it can be asserted against an
input string and nothing else.**

### 1.2 Result shape

```ts
interface XmpSettings {
  processVersion: ProcessVersion;   // §4, resolved, never the raw string
  crsVersion: string | null;        // §4.2, writer build, feature hints only
  legacy: boolean;                  // §4.3, pre-2012 source
  hasSettings: boolean;             // §9.3
  alreadyApplied: boolean;          // §9.3

  whiteBalance: WhiteBalance;       // §5.1
  tone: Tone;                       // §5.2, §5.4
  presence: Presence;               // §5.3
  hsl: Hsl;                         // §5.5
  detail: Detail;                   // §5.6
  colorGrading: ColorGrading;       // §5.7
  lens: Lens;                       // §5.8
  effects: Effects;                 // §5.9
  calibration: Calibration;         // §5.10
  geometry: Geometry;               // §6
  profile: CameraProfile;           // §7
  look: Look | null;                // §8
  metadata: Metadata;               // §11

  legacyTone: LegacyTone | null;    // §4.3, never merged into `tone`
  unsupported: string[];            // §10
  issues: Issue[];                  // §9.2
}
```

Every block is **non-optional and fully populated with defaults**, always, even
when `hasSettings` is false. Absence of a tag is expressed as that tag's default,
not as a missing block. `look` and `legacyTone` are the two exceptions, because
"no look" and "no look data" are genuinely different from any default.

`legacyTone`, `unsupported` and `issues` are the fields most likely to be dropped
as unnecessary. They are not. Each exists because a specific class of file would
otherwise import wrong and say nothing about it.

### 1.3 Field naming

The tables below give **XMP tag names**, not struct field names. The mapping is a
rule, not a table, so it cannot drift:

> Field name is the lowerCamelCase of the tag's local name, with every occurrence
> of `PV2012` or `2012` deleted, wherever in the name it appears.

So `crs:Exposure2012` becomes `tone.exposure`, `crs:Clarity2012` becomes
`presence.clarity`, `crs:PostCropVignetteAmount` becomes
`effects.postCropVignetteAmount`. The generation marker is the wire discriminator
(§4.3), not part of the meaning, and carrying it into our names would date the
struct. It is deleted rather than stripped from the end because it is not always at
the end: `crs:ToneCurvePV2012Red` carries it in the middle.

Three exceptions, each because the mechanical result would be worse than the name
it replaces:

- **The tone curves**, whose local names all begin with `ToneCurve` while already
  living under `tone`. Spelled out rather than derived, since the rule alone gives
  `tone.toneCurveRed`:

  | Tag | Field |
  |---|---|
  | `crs:ToneCurvePV2012` | `tone.curve` |
  | `crs:ToneCurvePV2012Red` | `tone.curveRed` |
  | `crs:ToneCurvePV2012Green` | `tone.curveGreen` |
  | `crs:ToneCurvePV2012Blue` | `tone.curveBlue` |
  | `crs:ToneCurveName2012` | `tone.curveName` |
  | `crs:ToneCurve`, `crs:ToneCurveRed` etc. (§4.3) | `legacyTone.curve`, `legacyTone.curveRed` etc. |

- §5.7's `Sat` / `Lum` abbreviations expand to `saturation` / `luminance`. The
  format is inconsistent with itself here; our struct need not be.
- The eight-band blocks (§5.5) are keyed maps, not 32 flat fields:
  `hsl.hue.red`, `hsl.saturation.aqua`, `hsl.gray.magenta`.

### 1.4 Zod

The Zod schema is the source of truth; the TypeScript types are `z.infer` of it.
It is **not** a validation gate on input: §9 requires clamping and degradation, not
rejection, so all coercion happens before the schema sees anything. The schema's
job is to make the struct's shape unforgeable at the boundary and to give the later
deliverable something to build against.

It describes an internal struct, so it is camelCase and lives beside the parser,
not in `src/schemas/` (which holds snake_case wire DTOs).

---

## 2. Where the XMP lives

Context for whoever calls this, not work for this deliverable (§1.1). One parser
serves all three; none of them changes what it does.

1. **Sidecar file.** `IMG_1234.xmp` beside `IMG_1234.CR2`. Base name matches, the
   raw's extension is replaced, not appended. Sidecars exist because proprietary
   raw containers can't be safely rewritten.
2. **Embedded in the raw.** DNG, and some other containers, carry an XMP packet
   inline. LibRaw surfaces it as `libraw_iparams_t.xmpdata` / `.xmplen`; that
   pointer is already in our generated bindings but nothing reads it yet.
3. **Embedded in a rendered file.** JPEG/TIFF/HEIF carry an XMP packet in a marker
   segment.

Only (1) matters for the first caller. (2) is cheap to add later and needs a new
field on the header read, not a new parser, which is the point of taking a string
rather than a path.

One trap for that caller, recorded here so it isn't rediscovered: `IMG_1234.CR2`
and `IMG_1234.JPG` in one folder both map to `IMG_1234.xmp`. The sidecar belongs to
the raw, and it usually says so itself in `photoshop:SidecarForExtension` (§11),
which is a more reliable answer than guessing.

---

## 3. Container and parsing rules

### 3.1 Envelope

```xml
<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="...">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
    crs:Version="17.0"
    crs:Exposure2012="+0.35">
   ...
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
```

- The `<?xpacket ...?>` processing instructions are optional. Embedded packets are
  usually padded with hundreds of bytes of trailing whitespace before `end`; strip
  it, don't choke on it.
- That `id` value is a fixed constant of the format, identical in every file. It
  carries no information. Do not validate against it and do not parse it.
- `begin` carries a UTF-8 BOM as its literal value. Tolerate a BOM at the start of
  the string.
- `x:xmpmeta` may be absent; `rdf:RDF` at the root is legal.
- **There may be more than one `rdf:Description`.** Writers split properties across
  several, grouped by namespace. Merge them all into one property set; do not stop
  at the first. If the same property appears twice with different values, **last
  wins** and the collision goes in `issues`.

### 3.2 Namespaces

| Prefix | URI |
|---|---|
| `rdf` | `http://www.w3.org/1999/02/22-rdf-syntax-ns#` |
| `x` | `adobe:ns:meta/` |
| `crs` | `http://ns.adobe.com/camera-raw-settings/1.0/` |
| `xmp` | `http://ns.adobe.com/xap/1.0/` |
| `dc` | `http://purl.org/dc/elements/1.1/` |
| `tiff` | `http://ns.adobe.com/tiff/1.0/` |
| `exif` | `http://ns.adobe.com/exif/1.0/` |
| `photoshop` | `http://ns.adobe.com/photoshop/1.0/` |
| `lr` | `http://ns.adobe.com/lightroom/1.0/` |

Bind by **URI, not prefix.** The prefix is conventional, not guaranteed: a file may
declare `xmlns:foo="http://ns.adobe.com/camera-raw-settings/1.0/"` and write
`foo:Exposure2012`, and that is the same property. Resolve declarations found on
any ancestor element, since they are commonly declared on `rdf:Description` rather
than the root.

Compare URIs exactly, except that a missing or extra trailing `/` must not change
the answer; some writers emit the crs URI without it.

**No off-the-shelf XML parser does this for you.** The available option strips
prefixes and keeps local names, which silently merges `crs:Contrast` with
`tiff:Contrast`. Expect to walk the parsed tree accumulating `xmlns:*` declarations
and rewriting each property to its URI-qualified name. This is the load-bearing
rule of §3 and the one most likely to be skipped because a shortcut appears to
work.

Throughout this document, `crs:X` means "the property `X` in the crs URI", never
"a property whose prefix is literally `crs`".

### 3.3 The attribute/element duality

**The single most important parsing rule.** Every scalar property can appear in
either of two forms, and both are valid:

```xml
<rdf:Description crs:Exposure2012="+0.35" />
```

```xml
<rdf:Description>
  <crs:Exposure2012>+0.35</crs:Exposure2012>
</rdf:Description>
```

Lightroom writes scalars as attributes and structured values as elements, but other
writers make different choices for the same data, and both forms turn up in real
libraries. A parser that handles only the attribute form works on most files and
fails on a meaningful minority. **Handle both, for every scalar.**

This is also why this must not be done with regex or string scanning.

### 3.4 Arrays

Three RDF container types, all of which appear:

```xml
<crs:ToneCurvePV2012>
  <rdf:Seq>
    <rdf:li>0, 0</rdf:li>
    <rdf:li>255, 255</rdf:li>
  </rdf:Seq>
</crs:ToneCurvePV2012>
```

- `rdf:Seq`, ordered. Tone curves.
- `rdf:Bag`, unordered. Keyword sets, correction lists.
- `rdf:Alt`, language alternatives. `dc:title`, `dc:description`. Take the
  `xml:lang="x-default"` entry, else the first.

Normalise all three to a JS array, preserving order for `Seq`.

**The one-element trap:** a container holding a single `rdf:li` is returned by
typical XML parsers as an object, not a one-element array. A one-keyword file then
takes a different code path from a two-keyword file. Force array-ness explicitly
rather than discovering this from a bug report.

### 3.5 Structures

A structured value has **two serialisations, exactly as scalars do (§3.3)**, and
both are common. Handle both.

Nested `rdf:Description`:

```xml
<crs:Look>
  <rdf:Description crs:Name="Adobe Color" crs:Amount="1" />
</crs:Look>
```

Shorthand `rdf:parseType="Resource"`, with the fields as attributes or children of
the property element itself:

```xml
<crs:Look rdf:parseType="Resource">
  <crs:Name>Adobe Color</crs:Name>
  <crs:Amount>1</crs:Amount>
</crs:Look>
```

`rdf:parseType="Resource"` also appears on `rdf:li` for structured array items.
Anything round-tripped through a metadata tool tends to use the shorthand, so
supporting only the nested-Description form fails on a large class of real files.

Only descend into structures §5 to §8 actually consume. A mask group nests several
levels across dozens of corrections, and walking it to build an object we then
discard is the expensive way to do nothing.

### 3.6 Value lexical forms

- **Reals** may carry an explicit `+`: `"+0.35"`, `"-1.20"`. Do not assume a
  leading digit.
- **Integers** are plain, occasionally signed. A real-looking value in an
  integer-typed tag (`"25.0"`) rounds; record nothing, this is common and benign.
- **Booleans** are the strings `"True"` and `"False"`, capitalised. Compare
  case-insensitively. Several flag-typed tags instead use integer `0`/`1`; accept
  either form wherever the type column says `flag`, and expose it as a boolean.
- **Enumerated strings** are exact and may contain spaces (`"As Shot"`,
  `"Medium Contrast"`). An unrecognised value is not an error: keep it verbatim and
  record an issue. Enum-typed fields are therefore `string`, not closed unions,
  with the known values documented for the consumer's benefit.
- Whitespace around values is not significant; trim before coercing.

Do **not** enable generic value coercion in the XML parser. Coerce per-tag using
the type column, because a blanket numeric coercion turns `crs:WhiteBalance="Auto"`
into `NaN` and `crs:CameraProfile="2"` into a number.

---

## 4. Versions

Two version tags. They look alike, they are both present, and they answer different
questions. **Confusing them is the single most damaging mistake available in this
format**, because the failure is silent and affects the most common file in any
library.

### 4.1 `crs:ProcessVersion`, the rendering generation

Determines which parameter set is authoritative.

| Value | Generation | Parameter set |
|---|---|---|
| `"5.0"` | 1 | Legacy, suffix-less tags |
| `"5.7"` | 2 | Legacy, suffix-less tags |
| `"6.6"`, `"6.7"` | 3 | **Current set.** `*2012` tags. |
| `"10.0"` | 4 | Current set |
| `"11.0"` | 5 | Current set |
| `"15.4"` and later | 6 | Current set |

**The `*2012` parameter set begins at `6.6`, not at `11.0`.** Generation 3 is where
`crs:Exposure2012` and friends were introduced, and it is by a wide margin the most
common value in the wild: every file written between 2012 and the generation-5
switch carries `6.6` or `6.7` alongside a full set of `*2012` tags. A gate placed
at `11.0` classifies all of them as legacy and discards their tones. Generations 4,
5 and 6 refine the rendering but do not rename the parameters, which is why one
threshold covers all four.

**The gate is `>= 6.6`.** Parse as a dotted numeric version and compare
componentwise, never lexicographically: `"15.4"` must sort above `"6.6"`, and a
string compare gets that backwards. Accept two or more components (`"6.7.0.0"` and
`"11"` both occur).

Absent, empty, or unparseable `crs:ProcessVersion` means legacy; some very old
files omit it entirely while carrying suffix-less tags. Resolve it into an explicit
value on the struct rather than passing the raw string through, so downstream code
never re-parses it:

```ts
type ProcessVersion =
  | { generation: number; raw: string }   // >= 6.6
  | { generation: null; raw: string | null };  // legacy or absent
```

### 4.2 `crs:Version`, the writer build

The Camera Raw build that wrote the file. It tells you which tags *might* be
present and never how to interpret them.

**Feature availability tracks `crs:Version`, not `crs:ProcessVersion`.** Colour
grading and mask groups both arrived years before generation 6, and a colour-graded
file routinely carries `crs:Version="13.0"` with `crs:ProcessVersion="11.0"`. Any
rule of the form "generation N implies feature F" is wrong.

Record it for diagnostics and for the version-dependent default in §5.6. Never gate
parameter interpretation on it.

### 4.3 Legacy files

For `generation === null`, read everything whose name and meaning did not change:
white balance (§5.1), presence (§5.3, minus `crs:Dehaze` which did not exist),
HSL (§5.5), detail (§5.6), split toning (§5.7), lens (§5.8), effects (§5.9),
calibration (§5.10) and geometry (§6). Those blocks are populated normally.

Read the legacy tonal tags into `legacyTone`, set `legacy: true`, and **leave
`tone` at its defaults**. The tonal controls were redesigned between generations 2
and 3; `crs:Brightness` and `crs:FillLight` have no current equivalent, and
pretending otherwise produces a worse result than declining to.

Deriving approximate current values from the legacy ones is a later decision for
the layer that maps onto our edit params, which can weigh a bad approximation
against no tones at all. It is not the parser's call, and `tone` must not be
back-filled here, or that layer loses the ability to tell the two apart.

| Tag | Type | Range | Default |
|---|---|---|---|
| `crs:Exposure` | real | −4.0..+4.0 | 0 |
| `crs:Brightness` | int | 0..150 | 50 **[V]** |
| `crs:Contrast` | int | −50..+100 | 25 **[V]** |
| `crs:Shadows` | int | 0..100 | 5 **[V]** |
| `crs:HighlightRecovery` | int | 0..100 | 0 |
| `crs:FillLight` | int | 0..100 | 0 |
| `crs:Clarity` | int | −100..+100 | 0 |
| `crs:ToneCurve` | Seq of point | | identity |
| `crs:ToneCurveName` | open enum | | `Medium Contrast` **[V]** |
| `crs:ToneCurveRed` / `Green` / `Blue` | Seq of point | | identity |

Note the non-zero legacy defaults, which differ from their current-generation
namesakes: an absent `crs:Contrast` on a legacy file does not mean neutral. Where a
legacy default is `[V]` and unverified, **omit the field rather than guessing a
number** (§12.1); a null in `legacyTone` is honest, a wrong non-zero default is not.

**Name collisions.** `crs:Contrast`, `crs:Shadows`, `crs:Clarity`, `crs:Exposure`,
`crs:Saturation` and `crs:Sharpness` exist in both generations with different
meanings and different defaults. Suffix presence is the discriminator, not the
name. There is no unsuffixed `crs:Highlights` and no `crs:Recovery`; generation 2's
highlight control is `crs:HighlightRecovery`.

A current-generation file often carries the unsuffixed twins as well, written for
backwards compatibility. On `generation !== null` they are not read into
`legacyTone`; they go to `unsupported` (§10) so the fact that they were present
survives.

---

## 5. Parameters

Ranges are the values the editing UI permits. Files may legitimately hold values
outside them, from older generations or programmatic writers. **Clamp on read,
never reject**, see §9.

**[V]** marks a value to confirm against real files before relying on it (§12).

### 5.1 White balance

| Tag | Type | Range | Default |
|---|---|---|---|
| `crs:WhiteBalance` | open enum | `As Shot`, `Auto`, `Daylight`, `Cloudy`, `Shade`, `Tungsten`, `Fluorescent`, `Flash`, `Custom` | `As Shot` |
| `crs:Temperature` | int | 2000..50000 **[V]** | **null** |
| `crs:Tint` | int | −150..+150 **[V]** | **null** |
| `crs:IncrementalTemperature` | int | −100..+100 | 0 |
| `crs:IncrementalTint` | int | −100..+100 | 0 |

Temperature and Tint are the only two parameters whose default is null rather than
a number. `crs:WhiteBalance = "As Shot"` means they may be absent, and the correct
value is then the camera's own recorded neutral, which this layer cannot see (§1:
no LibRaw). Null means "use as-shot"; the mapping layer resolves it. Substituting a
fixed number here would silently white-balance every as-shot import identically and
wrongly.

Keep whatever is present regardless of the `crs:WhiteBalance` value, and null only
on genuine absence. A named preset with the pair omitted is not an error.

The `Incremental*` pair is the white balance control for non-raw sources, expressed
as a relative nudge rather than an absolute Kelvin value. Different tags, different
units, not interchangeable with the pair above.

Temperature is in Kelvin but is **not** a physical colour temperature; it is the
value on the slider, and reproducing it needs the camera's own neutral as a
reference. Store it as given.

### 5.2 Basic tone

| Tag | Type | Range | Default |
|---|---|---|---|
| `crs:Exposure2012` | real | −5.00..+5.00 | 0 |
| `crs:Contrast2012` | int | −100..+100 | 0 |
| `crs:Highlights2012` | int | −100..+100 | 0 |
| `crs:Shadows2012` | int | −100..+100 | 0 |
| `crs:Whites2012` | int | −100..+100 | 0 |
| `crs:Blacks2012` | int | −100..+100 | 0 |

`crs:Exposure2012` is in **EV**, a linear stop multiplier, unlike every other value
on this list. The rest are unitless slider positions on an arbitrary scale; their
mapping to any physical quantity is not derivable from the file.

### 5.3 Presence and colour

| Tag | Type | Range | Default |
|---|---|---|---|
| `crs:Texture` | int | −100..+100 | 0 |
| `crs:Clarity2012` | int | −100..+100 | 0 |
| `crs:Dehaze` | **real** | −100..+100 | 0 |
| `crs:Vibrance` | int | −100..+100 | 0 |
| `crs:Saturation` | int | −100..+100 | 0 |

`crs:Dehaze` is a real, not an integer, unlike its neighbours. It also did not
exist before generation 3.

Texture, Clarity and Dehaze are local-contrast operators at different spatial
scales; they are not interchangeable and none is a scaled version of another.
Vibrance is a saturation adjustment weighted by a pixel's existing saturation, with
protection for hues near skin tones. Saturation is uniform.

### 5.4 Tone curve

| Tag | Type | Range | Default |
|---|---|---|---|
| `crs:ToneCurveName2012` | open enum | `Linear`, `Medium Contrast`, `Strong Contrast`, `Custom`, or a user preset name | `Linear` |
| `crs:ToneCurvePV2012` | Seq of point | | identity |
| `crs:ToneCurvePV2012Red` | Seq of point | | identity |
| `crs:ToneCurvePV2012Green` | Seq of point | | identity |
| `crs:ToneCurvePV2012Blue` | Seq of point | | identity |

`crs:ToneCurveName2012` is an **open** choice: a user-defined preset name is legal
and must not be rejected or coerced (§3.6).

Each `rdf:li` is a point, serialised `"<x>, <y>"`: two integers, **0..255**,
separated by a comma and optional whitespace. **Parse each to `{x, y}` numbers** and
carry it as `{x, y}[]`, not as raw strings. Points are ordered by ascending x; a
well-formed curve has at least two, the first at x=0 and the last at x=255.

Numeric parsing is what makes the identity check possible: the identity curve is
the two points `(0,0)` and `(255,255)`, and a file may write it explicitly rather
than omitting the tag. A string comparison against `"0, 0"` misses the equally
legal `"0,0"`, so compare numerically. Both spellings and an absent tag mean the
same thing, and all three must produce the same struct.

A malformed point drops that point and records an issue; a curve left with fewer
than two points falls back to identity.

Interpolation between points is a smooth spline, not linear. The exact spline is
not recoverable from the file. This is a known fidelity gap, not a bug to chase.

**Parametric curve**, a second, independent curve that composes with the point
curve. Both may be active at once, and it exists in every generation.

| Tag | Type | Range | Default |
|---|---|---|---|
| `crs:ParametricShadows` | int | −100..+100 | 0 |
| `crs:ParametricDarks` | int | −100..+100 | 0 |
| `crs:ParametricLights` | int | −100..+100 | 0 |
| `crs:ParametricHighlights` | int | −100..+100 | 0 |
| `crs:ParametricShadowSplit` | int | 0..100 | 25 |
| `crs:ParametricMidtoneSplit` | int | 0..100 | 50 |
| `crs:ParametricHighlightSplit` | int | 0..100 | 75 |

The three split values are the tone-range boundaries the four region sliders act
within. Their defaults are **not zero**, and a file that omits them means the
defaults, not "no split".

### 5.5 HSL and monochrome

Eight fixed colour bands, always in this order: `Red`, `Orange`, `Yellow`, `Green`,
`Aqua`, `Blue`, `Purple`, `Magenta`.

| Tag pattern | Type | Range | Default |
|---|---|---|---|
| `crs:HueAdjustment<Band>` | int | −100..+100 | 0 |
| `crs:SaturationAdjustment<Band>` | int | −100..+100 | 0 |
| `crs:LuminanceAdjustment<Band>` | int | −100..+100 | 0 |
| `crs:GrayMixer<Band>` | int | −100..+100 | 0 |
| `crs:ConvertToGrayscale` | flag | | False |

32 band tags. Generate them from the band list, don't enumerate them by hand.

`crs:ConvertToGrayscale` decides which set applies: True means the `GrayMixer` set
is authoritative and the HSL set inert, False the reverse. **Both sets are commonly
present in the same file**, so presence decides nothing. Populate both regardless
and let the flag speak; discarding the inert set here would be interpretation, and
a user toggling the conversion back expects their HSL values intact.

### 5.6 Detail

| Tag | Type | Range | Default |
|---|---|---|---|
| `crs:Sharpness` | int | 0..150 | **see below** |
| `crs:SharpenRadius` | real | 0.5..3.0 | 1.0 |
| `crs:SharpenDetail` | int | 0..100 | 25 |
| `crs:SharpenEdgeMasking` | int | 0..100 | 0 |
| `crs:LuminanceSmoothing` | int | 0..100 | 0 |
| `crs:LuminanceNoiseReductionDetail` | int | 0..100 | 50 **[V]** |
| `crs:LuminanceNoiseReductionContrast` | int | 0..100 | 0 |
| `crs:ColorNoiseReduction` | int | 0..100 | **25** |
| `crs:ColorNoiseReductionDetail` | int | 0..100 | 50 |
| `crs:ColorNoiseReductionSmoothness` | int | 0..100 | 50 |

**This block has the most non-zero defaults in the format, and getting them wrong
fails silently.** `crs:ColorNoiseReduction` defaulting to 25 rather than 0 is the
one that bites: a file with no detail block at all still means 25 units of colour
noise reduction, and rendering it as 0 gives visibly speckled output with no error
anywhere.

**`crs:Sharpness`'s default is writer-dependent, and this is the one place §4.2's
`crs:Version` is load-bearing.** It was raised from 25 to 40 at build `10.3`. So:
`crsVersion < 10.3` or absent gives 25, `>= 10.3` gives 40. Verified in both
directions against real files, and it is a visible difference, not a rounding one.

The same default is documented elsewhere as conditional on raw versus rendered
source. That distinction is not answerable from the string alone (§2 serves all
three carriers with no signal telling them apart), so it is not applied here. If a
caller knows it is handling a rendered file, that is theirs to override.

### 5.7 Colour grading and split toning

**These are one block sharing one storage, not two competing blocks.** Colour
grading did not get a full set of new tags: it added midtone and global controls
and reused the existing split-toning tags for shadows and highlights.

| Tag | Type | Range | Default | Role |
|---|---|---|---|---|
| `crs:SplitToningShadowHue` | int | 0..360 | 0 | shadow hue |
| `crs:SplitToningShadowSaturation` | int | 0..100 | 0 | shadow saturation |
| `crs:SplitToningHighlightHue` | int | 0..360 | 0 | highlight hue |
| `crs:SplitToningHighlightSaturation` | int | 0..100 | 0 | highlight saturation |
| `crs:SplitToningBalance` | int | −100..+100 | 0 | balance |
| `crs:ColorGradeShadowLum` | int | −100..+100 | 0 | shadow luminance |
| `crs:ColorGradeMidtoneHue` | int | 0..360 | 0 | |
| `crs:ColorGradeMidtoneSat` | int | 0..100 | 0 | |
| `crs:ColorGradeMidtoneLum` | int | −100..+100 | 0 | |
| `crs:ColorGradeHighlightLum` | int | −100..+100 | 0 | |
| `crs:ColorGradeGlobalHue` | int | 0..360 | 0 | |
| `crs:ColorGradeGlobalSat` | int | 0..100 | 0 | |
| `crs:ColorGradeGlobalLum` | int | −100..+100 | 0 | |
| `crs:ColorGradeBlending` | int | 0..100 | 50 | |

**There is no `ColorGradeShadowHue`, `ColorGradeShadowSat`, `ColorGradeHighlightHue`,
`ColorGradeHighlightSat` or `ColorGradeBalance`.** Those five names are the obvious
guess from the pattern and none of them exists. Reading only tags beginning
`ColorGrade` therefore silently discards shadow hue and saturation, highlight hue
and saturation, and balance, which is most of the colour grade.

There is consequently **no arbitration to do** between the two names, and no
"newer block wins" rule: read every tag in the table into one `colorGrading` block.
A pre-colour-grading file simply leaves the midtone, global and `Lum` tags at their
defaults, which is exactly what a split-tone-only edit means.

Hues wrap at 360. A hue with zero saturation has no effect, so hue=0 is not
meaningful on its own.

`Sat` and `Lum` are the real tag names, abbreviated where §5.5 spells them out.
Expand them in our struct (§1.3).

### 5.8 Lens corrections and defringe

| Tag | Type | Range | Default |
|---|---|---|---|
| `crs:LensProfileEnable` | flag | | False |
| `crs:LensProfileSetup` | open enum | `LensDefaults`, `Auto`, `Custom` | `LensDefaults` |
| `crs:LensProfileName` | string | | null |
| `crs:LensProfileFilename` | string | | null |
| `crs:LensProfileDigest` | string | | null |
| `crs:LensProfileIsEmbedded` | flag | | False |
| `crs:LensProfileDistortionScale` | int | 0..200 | 100 |
| `crs:LensProfileChromaticAberrationScale` | int | 0..200 | 100 |
| `crs:LensProfileVignettingScale` | int | 0..200 | 100 |
| `crs:LensManualDistortionAmount` | int | −100..+100 | 0 |
| `crs:AutoLateralCA` | flag | | False |
| `crs:ChromaticAberrationR` | int | −100..+100 | 0 |
| `crs:ChromaticAberrationB` | int | −100..+100 | 0 |
| `crs:DefringePurpleAmount` | int | 0..20 | 0 |
| `crs:DefringePurpleHueLo` | int | 0..100 | 30 **[V]** |
| `crs:DefringePurpleHueHi` | int | 0..100 | 70 **[V]** |
| `crs:DefringeGreenAmount` | int | 0..20 | 0 |
| `crs:DefringeGreenHueLo` | int | 0..100 | 40 **[V]** |
| `crs:DefringeGreenHueHi` | int | 0..100 | 60 **[V]** |

Note the defringe amounts are 0..20, not 0..100 like almost everything else.

Lens profile names reference an external profile we do not have. Record the name
and digest; do not fail when they don't resolve. Our own lens handling reads the
distortion spline the camera recorded in the raw, which is independent of this.

### 5.9 Vignetting, grain

Two distinct vignettes, applied at different points in the pipeline (§6.4). They
are not alternatives and both can be non-zero.

| Tag | Type | Range | Default |
|---|---|---|---|
| `crs:VignetteAmount` | int | −100..+100 | 0 |
| `crs:VignetteMidpoint` | int | 0..100 | 50 **[V]** |
| `crs:PostCropVignetteAmount` | int | −100..+100 | 0 |
| `crs:PostCropVignetteMidpoint` | int | 0..100 | 50 **[V]** |
| `crs:PostCropVignetteFeather` | int | 0..100 | 50 **[V]** |
| `crs:PostCropVignetteRoundness` | int | −100..+100 | 0 |
| `crs:PostCropVignetteStyle` | enum-int | 1 = Highlight Priority, 2 = Color Priority, 3 = Paint Overlay | 1 |
| `crs:PostCropVignetteHighlightContrast` | int | 0..100 | 0 |
| `crs:GrainAmount` | int | 0..100 | 0 |
| `crs:GrainSize` | int | 0..100 | 25 **[V]** |
| `crs:GrainFrequency` | int | 0..100 | 50 **[V]** |
| `crs:GrainSeed` | int | | 0 **[V]** |

`crs:VignetteAmount` is **manual lens vignetting**, corrected against the sensor
frame. "Post-crop" is literal: that vignette is applied relative to the cropped
frame, which is what distinguishes it, and its geometry therefore depends on §6.

`crs:PostCropVignetteStyle` selects the operator, not just its parameters: the
three values behave differently with respect to exposure, they are not intensities.

### 5.10 Camera calibration

| Tag | Type | Range | Default |
|---|---|---|---|
| `crs:ShadowTint` | int | −100..+100 | 0 |
| `crs:RedHue` | int | −100..+100 | 0 |
| `crs:RedSaturation` | int | −100..+100 | 0 |
| `crs:GreenHue` | int | −100..+100 | 0 |
| `crs:GreenSaturation` | int | −100..+100 | 0 |
| `crs:BlueHue` | int | −100..+100 | 0 |
| `crs:BlueSaturation` | int | −100..+100 | 0 |

Applied before the colour matrix, on primaries rather than on rendered colour.
Cheap to read, and old presets lean on it heavily, so it matters most for exactly
the legacy files §4.3 covers.

---

## 6. Geometry: crop, rotation, keystone

**The section most likely to be implemented wrong, with errors that are visual
rather than exceptional.** The parser's job is to carry these values faithfully and
losslessly; the transform itself is downstream (§1.1), and §12.2 says which part of
the verification can be closed here and which cannot.

### 6.1 Orientation

| Tag | Type | Range | Default |
|---|---|---|---|
| `tiff:Orientation` | int | 1..8 | null |

Standard EXIF orientation codes. Record as given, or null when absent.

Two things for the consumer, neither of them this layer's work. The XMP copy may
disagree with the raw's own orientation, because a user may have rotated the image
in the editor after import; deciding which wins needs both, and the parser sees
one. And LibRaw's flip code is a different encoding of the same idea, so the two
must never be assigned to each other.

### 6.2 Crop

| Tag | Type | Range | Default |
|---|---|---|---|
| `crs:HasCrop` | flag | | False |
| `crs:CropTop` | real | 0..1 | 0 |
| `crs:CropLeft` | real | 0..1 | 0 |
| `crs:CropBottom` | real | 0..1 | 1 |
| `crs:CropRight` | real | 0..1 | 1 |
| `crs:CropAngle` | real | −45..+45 **[V]** | 0 |
| `crs:CropWidth` | real | | null |
| `crs:CropHeight` | real | | null |
| `crs:CropUnits` | enum-int | 0 = pixels, 1 = inches, 2 = cm **[V]** | 0 |
| `crs:CropConstrainToWarp` | flag | | False |

Rules that matter:

- **`crs:HasCrop` is authoritative.** Crop values are frequently present and
  non-default while `HasCrop` is False: stale state from a crop the user undid. If
  `HasCrop` is False or absent, there is no crop, regardless of the four edges.
- The four edges are **normalised fractions, not pixels.** Multiply by the frame
  dimensions at the point of use, never store as pixels.
- **`crs:CropUnits` breaks that invariant.** Older writers express crops in
  absolute units together with `crs:CropWidth` / `crs:CropHeight`, in which case the
  fractions are not the whole story. Carry all three through unmodified and record
  an issue when `CropUnits` is non-zero, so the consumer knows the simple reading
  does not apply. Do not attempt the conversion here; it needs the frame dimensions,
  which this layer does not have.
- The edges are expressed in the frame **after** `tiff:Orientation` is applied
  (the upright frame the user was looking at), and in the frame **rotated by**
  `crs:CropAngle`. The rectangle is axis-aligned within that rotated frame, which is
  why a straightened crop is not an axis-aligned rectangle on the sensor grid.
  **[V]**, and see §12.2: the rotation's direction and centre cannot be confirmed
  from files alone.
- Degenerate rectangles occur: `Top >= Bottom` or `Left >= Right` is malformed.
  Treat as no crop and record an issue; do not emit a negative-size frame.

### 6.3 Perspective and keystone

Yes, this is in the sidecar. Two layers, and both may be present.

**Manual sliders:**

| Tag | Type | Range | Default |
|---|---|---|---|
| `crs:PerspectiveVertical` | int | −100..+100 | 0 |
| `crs:PerspectiveHorizontal` | int | −100..+100 | 0 |
| `crs:PerspectiveRotate` | real | −10..+10 **[V]** | 0 |
| `crs:PerspectiveScale` | int | 50..150 | **100** |
| `crs:PerspectiveAspect` | int | −100..+100 | 0 |
| `crs:PerspectiveX` | **real** | −100..+100 | 0 |
| `crs:PerspectiveY` | **real** | −100..+100 | 0 |

`crs:PerspectiveScale` defaults to **100, not 0**; a missing value means unity
scale, and treating it as 0 collapses the image.

`PerspectiveVertical` and `PerspectiveHorizontal` are the keystone controls.
`PerspectiveRotate` is a separate rotation from `crs:CropAngle` and composes with
it rather than replacing it; a file can carry both. `PerspectiveX` and
`PerspectiveY` are reals, unlike the rest of the block.

**Automatic correction.** Grouped by what they do, not by the order they appear in
a file:

| Tag | Type | Range | Default |
|---|---|---|---|
| `crs:PerspectiveUpright` | enum-int | 0 = Off, 1 = Auto, 2 = Full, 3 = Level, 4 = Vertical, 5 = Guided | 0 |
| `crs:UprightVersion` | int | | null |
| `crs:UprightCenterMode` | int | | null |
| `crs:UprightCenterNormX` | real | 0..1 | null |
| `crs:UprightCenterNormY` | real | 0..1 | null |
| `crs:UprightFocalMode` | int | | null |
| `crs:UprightFocalLength35mm` | real | mm | null |
| `crs:UprightPreview` | flag | | False |
| `crs:UprightTransformCount` | int | | null |
| `crs:UprightFourSegmentsCount` | int | | null |

Plus the opaque payloads: `crs:UprightTransform_0` through `_5`, and
`crs:UprightFourSegments_0` through `_3`, both observed with those cardinalities
**[V]**. These are encoded transform data whose format is not documented and not
derivable from inspection. **Do not attempt to decode them.** Skip the values,
record the names (§10).

`crs:UprightPreview` is editor UI state with no bearing on rendering. It is read
and discarded rather than carried, and its name goes in `unsupported` like anything
else we decline, so "we saw it and chose to drop it" stays distinguishable from
"we never looked".

The consequence that matters: when `crs:PerspectiveUpright` is non-zero, the
geometry was determined by an algorithm we cannot reproduce, and the manual sliders
alone do not describe the result. Carry the mode value itself, so a consumer can
tell "no automatic correction" from "an automatic correction we did not reproduce".
Those two must not collapse into the same struct, or the difference is
unrecoverable downstream and the result is a subtly wrong image with no indication
anything was lost. What to do about it, warn, refuse, or render anyway, is the
caller's (§1.1).

### 6.4 Composition order

Geometry is applied in this order, and it is not commutative. Recorded for the
consumer that applies it (§1.1), not performed here:

1. Orientation (`tiff:Orientation`)
2. Lens distortion correction
3. Perspective / upright transform
4. Straighten (`crs:CropAngle`)
5. Crop rectangle
6. Post-crop vignette and grain (§5.9)

Step 2 is in the list for position, not because the XMP drives it; our distortion
comes from the spline the camera recorded (§5.8). It matters because a crop
rectangle was authored against an already-undistorted frame, so applying the crop
to a distorted one puts the edges in the wrong place.

---

## 7. Camera profile

| Tag | Type | Default |
|---|---|---|
| `crs:CameraProfile` | string | null |
| `crs:CameraProfileDigest` | string | null |

The profile is a **reference, not a payload**: the file names a profile that lives
elsewhere and carries none of its data. The digest is a fingerprint of the
profile's contents, so a consumer can detect "a profile with this name exists
locally but is not the same one".

Resolution is out of scope (§1.1). Record both strings. Never fail an import
because a profile is unknown: an unresolved profile is something for the consumer
to report, not a parse error.

---

## 8. Look

`crs:Look` is a structure (§3.5) describing a creative rendering layered **on top
of** the camera profile in §7. The two compose; a file naming both means both
apply. `look` is null when the structure is absent, which is different from a Look
with default fields.

| Field | Type | Notes |
|---|---|---|
| `crs:Name` | string | Display name |
| `crs:Amount` | real | Strength, typically 0..1 |
| `crs:UUID` | string | Stable identifier |
| `crs:Group` | lang-alt | Category |
| `crs:Cluster` | string | |
| `crs:Copyright` | string | |
| `crs:SupportsAmount` | flag | |
| `crs:SupportsMonochrome` | flag | |
| `crs:SupportsOutputReferred` | flag | |
| `crs:Parameters` | struct | See below |

Field list is **[V]**: several are optional and it is unlikely to be exhaustive.
Unknown fields inside the structure go to `unsupported` as `crs:Look/<Name>`.

`crs:Parameters` is a nested structure with a mostly readable shape: `Version`,
`ProcessVersion`, `CameraProfile`, `Clarity2012`, `ConvertToGrayscale`,
`Highlights2012`, `Shadows2012`, and the four `ToneCurvePV2012*` curves, all
meaning what they mean elsewhere in this document. **The single opaque member is
`crs:LookTable`**, an encoded lookup table: skip it, name it in `unsupported`.

A sometimes-present, sometimes-absent `LookTable` is normal, not corrupt; which it
is depends on the look's origin, not on anything predictable from the other fields.

**Disambiguate `crs:LookName` from `crs:Look/crs:Name`.** Some writers emit a
top-level `crs:LookName` scalar alongside the structure. They are different
properties at different nesting depths and must not be merged.

Reading only the scalar fields and skipping `crs:Parameters` entirely is a valid
first cut, provided the skip is named in `unsupported`. A look changes rendering
substantially, so a file carrying one and a file carrying none must not produce the
same struct.

---

## 9. Defaults, clamping, absence, failure

### 9.1 The three cases

Routinely conflated:

1. **Tag absent** gives the documented default. Defaults are **not uniformly zero**
   (§4.3, §5.4, §5.6, §5.9, §6.3), and two are null rather than a number (§5.1).
   Absence never means "skip this operation".
2. **Tag present, value out of range** clamps to the range and records an issue.
   Files legitimately hold out-of-range values, and rejecting them loses a whole
   import over one slider.
3. **Tag present, value unparseable** records an issue, uses the default, and
   continues. One malformed attribute must not fail the file.

### 9.2 Issues

```ts
interface Issue {
  tag: string;      // URI-qualified, as §3.2
  reason: 'clamped' | 'unparseable' | 'duplicate' | 'malformed' | 'unconvertible';
  value: string;    // the offending value, verbatim
}
```

A closed reason set, because the consumer has to branch on it and free prose
cannot be branched on. `unconvertible` covers the cases where the value is
well-formed and simply cannot be used here, like §6.2's non-zero `crs:CropUnits`.

### 9.3 Two flags that are not settings

`crs:HasSettings`, a boolean asserting the file carries develop settings at all.
When False or absent, the file may hold only metadata: a rating, some keywords, no
edit.

**Populate every block with its defaults regardless** (§1.2). The parser has no way
to express "no edit" other than this flag, and making a dozen blocks nullable to
encode one bit would push the check into every consumer instead of one. What the
flag means, and whether an all-defaults struct should be applied to a photo, is the
caller's (§1.1).

`crs:AlreadyApplied`, a boolean meaning **the pixel data has already been rendered
with these settings**. It appears on files written out of the editor. When True the
values describe what was baked in, not what to apply, and applying them again
double-processes the image. Read the settings and set the flag; this layer must not
drop them, because they are still the correct description of how the file was
produced.

### 9.4 When the whole parse fails

Return null, only for: input that is not well-formed XML, or well-formed XML with
no `rdf:RDF` element. Everything below that degrades per §9.1.

Well-formedness needs an explicit check. Typical XML parsers are lenient by default
and will happily return a partial tree for truncated input, which then reads as a
file with almost every tag absent, which §9.1 turns into a confident set of
defaults. That is the worst available outcome: a corrupt file importing silently as
a neutral edit.

---

## 10. Unsupported tags

Two rules, and neither involves keeping the values.

**Never fail on a tag you don't handle.** Skip it and carry on. The format gains
tags with every release, so this is the difference between next year's file
importing with one feature missing and not importing at all.

**Record the names of unsupported tags that were present**, in `unsupported`.
URI-qualified names only (§3.2), sorted, deduplicated across merged
`rdf:Description` elements, no payloads. The rule is **any `crs:` property this
document does not consume** anywhere in §4 to §9 or §11, plus these, which are
known and deliberately declined:

- `crs:MaskGroupBasedCorrections`, current-generation masks and local adjustments
- `crs:CircularGradientBasedCorrections`, `crs:GradientBasedCorrections`,
  `crs:PaintBasedCorrections`, earlier local-adjustment generations
- `crs:RetouchAreas`, `crs:RetouchInfo`, heal and clone
- `crs:RangeMaskMapInfo`, `crs:DepthBasedCorrections`, `crs:DepthMapInfo`,
  `crs:RedEyeInfo`, `crs:LensBlur`
- `crs:PointColors`, `crs:ColorVariance`, point colour
- `crs:HDREditMode` and the `crs:SDR*` block, HDR editing
- `crs:UprightTransform_0..5`, `crs:UprightFourSegments_0..3`,
  `crs:UprightDependentDigest`, `crs:UprightGuidedDependentDigest` (§6.3)
- `crs:UprightPreview` (§6.3), read and discarded
- `crs:Look/crs:LookTable`, and unknown `crs:Look` fields (§8)
- The unsuffixed legacy twins on a current-generation file (§4.3)

Properties outside the `crs` namespace that we simply don't read are **not**
recorded; the bucket would fill with `xmpMM:` bookkeeping and stop being a signal.

**`crs:HDREditMode` deserves a note.** In HDR mode the global tone values mean
something different rather than merely being accompanied by extra ones, so a file
carrying it is misread rather than partially read. It belongs in `unsupported` like
the rest, but it is the one entry whose presence should make a consumer distrust
the tone block rather than just note a missing feature.

The names earn their place twice. They let a caller say *this photo's edit included
four local adjustments that were not imported*, a correctness disclosure that
cannot be made from an empty result. And aggregated across a library they say which
tag to support next, which is better evidence than guessing.

**The values do not.** The sidecar stays on disk next to the raw, so when masks are
supported the answer is to re-read it. Carrying payloads we can't interpret buys a
re-parse we can do anyway, at the cost of a blob whose schema Adobe controls and we
don't, and it would have to be carried through every layer above this one.

Some of these hold machine-generated content that can't be reproduced from its
parameters even once the feature is supported, which is a further reason not to
mistake keeping a copy for progress toward supporting it.

---

## 11. Non-`crs` metadata

Cheap, and the import path is already open.

| Tag | Type | Default | Notes |
|---|---|---|---|
| `xmp:Rating` | real | null | −1..5. **−1 means rejected**, not "one below zero". Real, not int: `3.5` is spec-legal even though editors write integers. |
| `xmp:Label` | string | null | Colour label, free text, localised |
| `xmp:CreateDate` | date | null | |
| `xmp:ModifyDate` | date | null | |
| `xmp:MetadataDate` | date | null | |
| `dc:subject` | Bag of string | `[]` | Flat keywords |
| `lr:hierarchicalSubject` | Bag of string | `[]` | Keyword paths, `Animals\|Birds\|Owl` |
| `dc:title` | lang-alt | null | |
| `dc:description` | lang-alt | null | |
| `dc:creator` | Seq of string | `[]` | |
| `dc:rights` | lang-alt | null | |
| `photoshop:DateCreated` | date | null | |
| `photoshop:SidecarForExtension` | string | null | The raw extension this sidecar belongs to, e.g. `CR2` |
| `crs:RawFileName` | string | null | Original raw filename |

Read **both** keyword tags. `dc:subject` is flat, `lr:hierarchicalSubject` carries
the tree; reading only the former silently flattens a hierarchy the user built.

Record `crs:RawFileName` and `photoshop:SidecarForExtension` verbatim. This layer
has no filename to compare them against and must not try; the comparison is the
caller's (§1.1), and it matters because either one disagreeing with the file matched
by base name means the sidecar was moved or renamed relative to its raw, and
applying it would put someone else's edit on a photo.

**Dates are a pair, not a `Date`.** ISO 8601, frequently with no zone, and a
zoneless date is local time in an unknown zone. Constructing a JS `Date` coerces it
to UTC by definition and loses that. Carry:

```ts
interface XmpDate { value: string; offset: string | null }
```

matching the existing capture-time handling, which keeps the wall clock and the
offset as separate nullable fields for exactly this reason. An unparseable date is
an issue and yields null.

---

## 12. Verification

### 12.1 What the corpus settles, and what to do without one

Every value marked **[V]** is a claim to confirm, not a fact to rely on.

Collect sidecars spanning process versions, camera makes and editor versions, plus
files carrying crops, straightening, keystone corrections, monochrome conversions
and looks. Dump every `crs:` property with its observed value range and frequency.
That corpus answers three questions no table can:

- Which properties actually occur, a small fraction of those that exist
- What values really appear, including out-of-range ones
- Which properties co-occur, which is how the version gating in §4 gets validated

**This is a research task, not part of the deliverable.** It needs real files;
§1.1's deliverable needs only strings. Its output is fixture strings and confirmed
numbers, which the deliverable then consumes. Keeping them separate is what lets
the parser be finished before the corpus exists.

**If a `[V]` value cannot be confirmed, ship the tabulated one and leave the marker
in place**, except in `legacyTone` (§4.3) where an unconfirmed non-zero default is
worse than a null. Do not go hunting for an authoritative table; there isn't one,
which is why the markers exist.

### 12.2 The verification this deliverable cannot close

**§6.2's crop coordinate convention.** Confirming which frame the coordinates sit
in, and the sign and centre of the straighten rotation, means applying the
transform and looking at the result, which needs a renderer this deliverable does
not have. It is carried forward to §1.1's geometry consumer.

Record it as carried forward rather than quietly treating it as settled; shipping an
unverified convention as though it were confirmed is how the next deliverable
inherits a bug it has no reason to suspect.

When it is verified, use fixtures whose content makes direction unambiguous: an
asymmetric target, not a centred one. A symmetric test image passes with the
rotation sign inverted.

### 12.3 Acceptance

Container and namespaces:

- Both property forms in §3.3 parse identically, asserted on one document written
  each way.
- Both structure forms in §3.5, nested `rdf:Description` and
  `rdf:parseType="Resource"`, parse identically.
- The crs namespace bound to a non-`crs` prefix parses identically to the
  conventional spelling; a `crs`-prefixed property bound to a different URI is not
  read as ours.
- Multiple `rdf:Description` elements merge; a property duplicated across two of
  them takes the last value and records a `duplicate` issue.
- A leading BOM and several hundred bytes of xpacket padding parse.
- A one-element `rdf:Bag` yields a one-element array, not a scalar.
- An `rdf:Alt` with `x-default` plus two other languages yields the `x-default`.
- Truncated, non-well-formed XML returns null, and does **not** return an
  all-defaults struct.

Versions, the highest-value tests in the list:

- `crs:ProcessVersion="6.7"` with `*2012` tags imports them into `tone` and leaves
  `legacy` false.
- `crs:ProcessVersion="15.4"` sorts above `"6.6"`, and `"11"` and `"6.7.0.0"` both
  parse.
- A pre-2012 file populates `legacyTone`, sets `legacy`, leaves `tone` at defaults,
  and still imports white balance, HSL, detail and geometry.
- A current-generation file carrying both `crs:Contrast` and `crs:Contrast2012`
  reads the suffixed one into `tone` and names the other in `unsupported`.

Values and defaults:

- Every non-zero default is asserted explicitly: §5.6's detail block, §5.4's
  parametric splits 25/50/75, §5.9's vignette and grain, §6.3's
  `crs:PerspectiveScale` of 100. These fail silently, so they need tests that fail
  loudly.
- `crs:Sharpness` defaults to 25 below `crs:Version="10.3"` and 40 at or above it.
- A colour-graded file's shadow and highlight hue and saturation are read from the
  `SplitToning*` tags into `colorGrading`, and none of the five non-existent
  `ColorGrade*` names is looked for.
- `crs:WhiteBalance="As Shot"` with no Temperature or Tint yields null for both,
  not a number; a named preset with the pair present keeps the pair.
- An out-of-range value clamps and produces a `clamped` issue; a corrupt attribute
  value leaves every other tag imported and produces an `unparseable` issue.
- An unrecognised enum value is kept verbatim with an issue, not coerced.

Geometry:

- `crs:HasCrop="False"` with non-default edge values yields no crop.
- A degenerate rectangle yields no crop and a `malformed` issue.
- Non-zero `crs:CropUnits` carries the values through and produces an
  `unconvertible` issue.
- `crs:PerspectiveUpright="3"` is distinguishable in the struct from `"0"`.

Curves, flags, metadata:

- The identity curve written as `"0, 0"`/`"255, 255"`, as `"0,0"`/`"255,255"`, and
  omitted entirely all produce the same struct.
- `crs:ConvertToGrayscale="True"` still populates the HSL block, and False still
  populates the gray mixer.
- `crs:AlreadyApplied="True"` imports every setting and sets the flag.
- A file with `crs:HasSettings` absent yields fully-defaulted blocks and
  `hasSettings: false`.
- A zoneless date keeps its wall clock and yields a null offset.
- Both `dc:subject` and `lr:hierarchicalSubject` are read.

Unsupported:

- An unknown `crs:` property is skipped, named in `unsupported`, and does not fail
  the parse.
- A mask group imports every global parameter, names the mask property, and stores
  none of its contents.
- A property outside the `crs` namespace that we don't read is **not** named.

---

## 13. Out of scope

§1.1 lists what the next deliverable owns. These are out of scope for both.

- **Writing XMP.** Read-only, in every direction.
- **Rendering.** This produces a struct; nothing here touches pixels.
- **Reproducing the rendering.** The transfer functions behind these values are not
  in the file and not derivable from it. Matching the numbers is achievable;
  matching the output is not, and no amount of parser work changes that. Anywhere
  the two are confused, the parser gets blamed for a rendering gap.

One consequence of §1.1 worth stating outright: **this work does not need the edit
model to exist, and must not wait for it or presuppose its shape.** If implementing
this seems to require an edits table, a photo id, or a storage call, the boundary
has been crossed. The function takes a string and returns a struct; its tests are
strings and structs. Nothing else.
