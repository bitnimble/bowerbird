# Where the fixtures came from

The RAWs and the snapshots are Git LFS objects (`.gitattributes`), so a fresh clone needs
`git lfs pull` before the suites that read them will run.

## AFXT2721.RAF

A Fujifilm X-T3 frame, from the [PIXLS.US raw sample archive](https://raw.pixls.us/), which takes
every contribution under **CC0** - the uploader releases it into the public domain. Downloaded from
`https://raw.pixls.us/data/Fujifilm/X-T3/AFXT2721.RAF`.

**The compressed one of the two X-T3 samples there, deliberately.** Its sibling is uncompressed, and
would leave `decompress_fuji` - the part of the RAF decoder with any real work in it - unexercised.

It is a still life rather than the landscape one would reach for, and that is the better fixture
here: sharp high-contrast lettering over saturated blue and red is where an X-Trans demosaic shows
what it does wrong. A landscape's foliage hides chroma error; a printed word does not.

## DSCF8146.RAF

A Fujifilm X-T10 frame from the same archive and under the same CC0 terms, downloaded from
`https://raw.pixls.us/data/Fujifilm/X-T10/DSCF8146.RAF`.

**Shot at ISO 4000**, which is the whole reason it is here and is the highest in the archive's Fuji
samples by more than two stops - the next is 800. A blind noise fit is fitted per photograph off the
mosaic's own statistics, so every claim about one has to be made against a frame that actually has
noise in it; `AFXT2721.RAF` is a lit still life at ISO 160 and would agree with anything.

**And it is a different generation of the pattern.** The X-T10 is X-Trans II where the X-T3 is IV, so
what reaches the decoder is a second body's pattern rather than a second copy of one - and bodies
write different phases of the one 6x6, naming theirs in metadata.

A stained-glass window in a dim church interior: no photographed people, large flat plaster where
noise is most visible, deep saturated glass for the chroma arm, and real shadow.

The other files are the project's own. `snapshots/` holds pictures the tests pin (`snapshot.rs`),
each written by a test under `BOWERBIRD_WRITE_FIXTURES=1`; `tables/` holds the text that holds two
hosts' copies of a rule together.
