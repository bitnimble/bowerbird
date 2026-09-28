# Where the fixtures came from

RAWs and snapshots use Git LFS (`.gitattributes`). Run `git lfs pull` before fixture suites.

## AFXT2721.RAF

A Fujifilm X-T3 frame, from the [PIXLS.US raw sample archive](https://raw.pixls.us/), which takes
every contribution under **CC0** - the uploader releases it into the public domain. Downloaded from
`https://raw.pixls.us/data/Fujifilm/X-T3/AFXT2721.RAF`.

Compressed sample exercises `decompress_fuji`; uncompressed sibling does not. Still-life lettering
over saturated blue/red exposes X-Trans chroma errors that landscape foliage hides.

## DSCF8146.RAF

A Fujifilm X-T10 frame from the same archive and under the same CC0 terms, downloaded from
`https://raw.pixls.us/data/Fujifilm/X-T10/DSCF8146.RAF`.

**ISO 4000**, more than two stops above archive's next Fuji sample at 800, exercises blind
per-photo mosaic noise fitting. `AFXT2721.RAF` at ISO 160 is too clean for that claim.

X-T10's X-Trans II also differs from X-T3's IV; bodies encode different phases of the 6x6
pattern in metadata.

A stained-glass window in a dim church interior: no photographed people, large flat plaster where
noise is most visible, deep saturated glass for the chroma arm, and real shadow.

The other files are the project's own. `snapshots/` holds pictures the tests pin (`snapshot.rs`),
each written by a test under `BOWERBIRD_WRITE_FIXTURES=1`; `tables/` holds the text that holds two
hosts' copies of a rule together.

## DSC05765.ARW

One of those, and the one with something done to it. A Sony ILCE-7CR frame at **ISO 40000**, eight
times the next fixture up and the only Bayer frame here with real noise in it - `DSCF8146.RAF` is
the noisy one on the X-Trans side, and a fit measured off a mosaic sees the two patterns
differently. A shoreline after sunset, metered two stops under: shadow over most of the frame, which
is where a read noise measurement takes its population, with a street lamp and tail lights for
clipped highlights.

**Its Sony maker note blocks are zeroed**, every enciphered `0x90xx`-`0x94xx` tag but `0x9416`,
which is the one the decoder reads for the lens id. Those blocks carry the body's internal serial
number and its shutter count; nothing else in the file names anyone, and there is no GPS IFD. The
decode is unchanged by it - same levels, same matrices, same sample sum.

## DSC05726.ARW

Project-owned ILCE-7CR night street, warm lamps, red awning and lanterns. Crushed blue across most
of the frame must constrain the matrix as a bound; treating it as a level turns reds pink
(`a_crushed_blue_does_not_put_blue_on_red`).

**Scrubbed with `examples/scrub.rs`:** standard identity tags, GPS and encrypted Sony maker-note
blocks cleared, except lens-data block `0x9416`. Fit unchanged.

## IMG_8789.CR3

Project-owned Canon EOS R10 frame: two brown dogs, lawn and wall. Dominant grass must not tint
the dogs or neutrals green (`a_lawn_does_not_tint_the_dogs_green`).

**Scrubbed with `examples/scrub.rs`:** standard identity tags, XMP, `CMT4` GPS, Canon owner/body
identifiers (`0x0009`, `0x000c`, `0x0028`, `0x0096`) and the first five bytes of `0x4019` (lens serial)
cleared. Technical lens data and fit unchanged.

## mosaics/red-plate-rim.f32

Approved crop only: upright 720×208 conditioned photosites covering red plate, blue rim and white
plates; no metadata. Row-major little-endian f32, GBRG. `galosh.rs` supplies the noise fit and
dark references in spatial slot order.
