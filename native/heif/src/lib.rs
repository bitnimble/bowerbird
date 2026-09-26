//! What a HEIF file holds, read out of its boxes: the picture, its colour, its turn, its EXIF and
//! its gain map.
//!
//! **A container, not a codec.** HEIC and AVIF are the same file format with a different codec
//! inside - ISO/IEC 23008-12 items in an ISOBMFF `meta` box - so everything about finding the
//! picture is shared and only the bitstream at the end differs. That is why this is its own crate:
//! rawshim's `decode_rendered` and the browser's AV1 decoder (`native/avif_planes`) ask it what is
//! in the file and then hand the coded bytes to whichever decoder the item names.
//!
//! **Ours rather than a crate's**, because the two crates that read this are AGPL and the licence
//! is the one thing about a dependency that cannot be worked around later. What it costs is the
//! walk below, which is a few hundred lines of box parsing against a published layout.
//!
//! What is deliberately not here: sequences, alpha, layered and predictively-coded items, and the
//! `clap` clean aperture. A still photograph from a camera or a phone is a `hvc1` or an `av01` item,
//! often as a `grid` of tiles, with `colr`, `pixi`, `irot`/`imir` and an `Exif` item beside it, and
//! anything else is declined by name rather than half-read.

/// Which way up a picture is shown, as the eight EXIF orientations.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Orientation {
    Normal,
    HorizontalFlip,
    Rotate180,
    VerticalFlip,
    Transpose,
    Rotate90,
    Transverse,
    Rotate270,
}

/// The bitstream a picture item is coded in.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Codec {
    /// HEVC, which is what a HEIC from a phone or a camera is.
    Hevc,
    /// AV1, which is what an AVIF is.
    Av1,
}

/// A `colr` box's `nclx`: the CICP code points saying what the samples mean.
#[derive(Clone, Copy, Debug)]
pub struct Nclx {
    pub primaries: u16,
    pub transfer: u16,
    pub matrix: u16,
    pub full_range: bool,
}

/// One picture item, with everything needed to decode and interpret it.
pub struct Picture {
    pub codec: Codec,
    /// The picture's own size, before the turn.
    pub width: usize,
    pub height: usize,
    pub depth: u32,
    /// The decoder configuration record - `hvcC` or `av1C` - which carries the parameter sets.
    pub config: Vec<u8>,
    /// The coded bytes, one entry per tile of a `grid` and one entry otherwise, in raster order.
    pub tiles: Vec<Vec<u8>>,
    /// The grid's shape, `(columns, rows)`, and `(1, 1)` for a picture that is one item.
    pub grid: (usize, usize),
    /// One tile's size, which the grid's own is not: the last column and row are cropped.
    pub tile: (usize, usize),
    pub nclx: Option<Nclx>,
    pub icc: Option<Vec<u8>>,
    pub turn: Orientation,
    /// An essential property this reader does not act on, so the picture may not be the one the
    /// file describes. The caller says so: this crate has no console of its own on every host.
    pub unhandled: Option<String>,
}

/// A gain map beside the picture, and the terms that apply it.
pub struct GainMap {
    pub picture: Picture,
    /// ISO 21496-1's metadata, as the `tmap` item's own payload. None for Apple's auxiliary map,
    /// which carries its headroom in the maker note instead.
    pub metadata: Option<Vec<u8>>,
}

pub struct File {
    pub primary: Picture,
    /// The TIFF block an `Exif` item holds, with the four-byte offset header already stepped over.
    pub exif: Option<Vec<u8>>,
    pub gain: Option<GainMap>,
}

/// Whether these bytes are a HEIF still, by the brands its `ftyp` box declares.
///
/// **The brands, not the box.** ISOBMFF is a container family, and a CR3 is one of them - it
/// begins `ftyp crx ` and holds a Canon RAW. Reading the box alone as "this is a HEIF" hands every
/// Canon file to the wrong decoder, which is a library that imports nothing and reports that no
/// decoder read it.
pub fn is_heif(bytes: &[u8]) -> bool {
    let Some(ftyp) = top_level(bytes, b"ftyp") else { return false };
    // The major brand, then the compatible brands: four bytes each, with a version between them.
    let major = ftyp.get(..4);
    let compatible = ftyp.get(8..).into_iter().flat_map(|rest| rest.chunks_exact(4));
    major.into_iter().chain(compatible).any(|brand| STILL_BRANDS.contains(&brand))
}

/// The brands that mean "a still picture in a `meta` box", out of ISO/IEC 23008-12 §B and the
/// AVIF specification. `mif1` and `miaf` are the generic ones a phone writes beside its own.
const STILL_BRANDS: [&[u8]; 12] = [
    b"heic", b"heix", b"hevc", b"hevx", b"heim", b"heis", b"hevm", b"hevs", b"mif1", b"mif2",
    b"miaf", b"avif",
];

/// Everything this reader can say about a HEIF file.
pub fn read(bytes: &[u8]) -> Result<File, String> {
    if !is_heif(bytes) {
        return Err("not a HEIF file: it does not begin with an ftyp box".to_string());
    }
    let meta = top_level(bytes, b"meta").ok_or("this HEIF file has no meta box")?;
    // `meta` is a full box: a version and three flag bytes before its children.
    let meta = meta.get(4..).ok_or("this HEIF file's meta box is truncated")?;
    let catalogue = Catalogue::read(bytes, meta)?;

    let primary = catalogue.primary.ok_or("this HEIF file names no primary item")?;
    let (base, gain) = catalogue.tone_mapped(primary);
    let mut picture = catalogue.picture(base)?;
    // **Where the pair splits, the reader's own answers belong to the primary.** For an ISO
    // 21496-1 file the primary is the `tmap` and the base is what it derives from, and a writer
    // associates the turn with the item a naive reader displays - so a base with no `irot` of its
    // own takes the primary's rather than coming out sideways. Only where the base states none,
    // since a base that does is the more specific claim.
    if base != primary && picture.turn == Orientation::Normal {
        picture.turn = catalogue.turn_of(primary);
    }
    Ok(File {
        primary: picture,
        // Either item's, for the same reason: `cdsc` conventionally points at whichever one is
        // displayed, and a file that linked its EXIF to the pair rather than to the base would
        // otherwise import with no capture date and no camera at all.
        exif: catalogue.exif(base).or_else(|| catalogue.exif(primary)),
        gain: gain.and_then(|(map, metadata)| {
            Some(GainMap { picture: catalogue.picture(map).ok()?, metadata })
        }),
    })
}

/// Where an item's bytes are: a run of extents, each an offset and a length.
struct Location {
    /// 0 is an offset into the file, 1 an offset into the `idat` box.
    construction: u8,
    extents: Vec<(usize, usize)>,
}

struct Entry {
    kind: [u8; 4],
}

/// One property an item carries: which of `ipco`'s children, and whether the file says a reader
/// that cannot act on it may show the picture anyway.
#[derive(Clone, Copy)]
struct Association {
    /// One-based, as `ipma` writes it; 0 means "no property".
    index: usize,
    essential: bool,
}

/// The `meta` box, taken apart: which items exist, where their bytes are, what properties each
/// carries, and what refers to what.
struct Catalogue<'a> {
    bytes: &'a [u8],
    idat: &'a [u8],
    primary: Option<u32>,
    items: std::collections::HashMap<u32, Entry>,
    locations: std::collections::HashMap<u32, Location>,
    /// The `ipco` box's children in order, since `ipma` indexes them one-based.
    properties: Vec<(&'a [u8; 4], &'a [u8])>,
    /// Item to the properties it carries.
    assigned: std::collections::HashMap<u32, Vec<Association>>,
    /// `(kind, from, to)` for every reference, which is the direction `iref` writes them in.
    references: Vec<([u8; 4], u32, Vec<u32>)>,
}

impl<'a> Catalogue<'a> {
    fn read(bytes: &'a [u8], meta: &'a [u8]) -> Result<Catalogue<'a>, String> {
        let mut out = Catalogue {
            bytes,
            idat: &[],
            primary: None,
            items: std::collections::HashMap::new(),
            locations: std::collections::HashMap::new(),
            properties: Vec::new(),
            assigned: std::collections::HashMap::new(),
            references: Vec::new(),
        };
        for (kind, body) in boxes(meta) {
            match kind {
                b"pitm" => out.primary = read_pitm(body),
                b"iinf" => out.items = read_iinf(body),
                b"iloc" => out.locations = read_iloc(body),
                b"idat" => out.idat = body,
                b"iref" => out.references = read_iref(body),
                b"iprp" => {
                    for (inner, payload) in boxes(body) {
                        match inner {
                            b"ipco" => out.properties = boxes(payload).collect(),
                            // Extended, not replaced: `iprp` may hold more than one `ipma`, and a
                            // file that splits its associations across two would otherwise lose
                            // everything the first one said and fail with "does not say how big
                            // it is".
                            b"ipma" => out.assigned.extend(read_ipma(payload)),
                            _ => {}
                        }
                    }
                }
                _ => {}
            }
        }
        Ok(out)
    }

    /// Where a `tmap` primary splits into the base picture and the map that lifts it.
    ///
    /// **ISO 21496-1 makes the tone-mapped pair the primary item**, and its two `dimg` references
    /// are the base and the gain map in that order. The base is what a reader that knows nothing
    /// about gain maps shows, which is why the pair is spelled this way round.
    ///
    /// Apple's older files have no `tmap` at all: the primary *is* the base, and the map is an
    /// auxiliary item pointed at it by `auxl`. Both shapes come out here as the same pair.
    fn tone_mapped(&self, primary: u32) -> (u32, Option<(u32, Option<Vec<u8>>)>) {
        if self.kind_of(primary) == Some(*b"tmap") {
            let derived = self.referenced(primary, b"dimg");
            if let [base, map, ..] = derived[..] {
                return (base, Some((map, self.item_bytes(primary))));
            }
        }
        let apple = self
            .items
            .keys()
            .copied()
            .filter(|id| self.aux_type(*id).as_deref() == Some(APPLE_GAIN_MAP))
            .find(|id| self.referenced(*id, b"auxl").contains(&primary));
        (primary, apple.map(|id| (id, None)))
    }

    /// What an auxiliary item says it is, out of its `auxC` property.
    ///
    /// **The property, not `infe`'s trailing string.** 14496-12 only gives an `infe` an
    /// `item_uri_type` for a `mime` or `uri ` item, and Apple's gain map is an `hvc1` - so
    /// reading it off there finds nothing on every real file, and the branch that looks for it
    /// would never fire.
    fn aux_type(&self, item: u32) -> Option<String> {
        let (_, body) = self.properties_of(item).find(|(kind, _)| *kind == b"auxC")?;
        let urn = body.get(4..)?.split(|byte| *byte == 0).next()?;
        Some(String::from_utf8_lossy(urn).into_owned())
    }

    fn kind_of(&self, item: u32) -> Option<[u8; 4]> {
        self.items.get(&item).map(|entry| entry.kind)
    }

    /// The items `from` points at with a reference of this kind.
    fn referenced(&self, from: u32, kind: &[u8; 4]) -> Vec<u32> {
        self.references
            .iter()
            .filter(|(this, at, _)| this == kind && *at == from)
            .flat_map(|(_, _, to)| to.iter().copied())
            .collect()
    }

    /// The TIFF block of the `Exif` item this picture describes.
    ///
    /// The reference runs from the metadata to the picture - `cdsc`, content describes - so this
    /// looks for an item pointing *at* the picture rather than one it points to.
    fn exif(&self, picture: u32) -> Option<Vec<u8>> {
        let item = self
            .items
            .iter()
            .filter(|(_, entry)| &entry.kind == b"Exif")
            .map(|(id, _)| *id)
            .find(|id| self.referenced(*id, b"cdsc").contains(&picture))?;
        let payload = self.item_bytes(item)?;
        // Four bytes of `exif_tiff_header_offset` before the TIFF block itself, which is almost
        // always zero and is not allowed to be assumed. Checked, because `usize` is 32 bits on
        // the browser build and a claimed offset near `u32::MAX` would wrap into a valid-looking
        // index somewhere else in the payload.
        let stated = u32::from_be_bytes(payload.get(..4)?.try_into().ok()?);
        let skip = usize::try_from(stated).ok()?.checked_add(4)?;
        payload.get(skip..).map(<[u8]>::to_vec)
    }

    /// One picture item, its tiles gathered and its properties read.
    fn picture(&self, item: u32) -> Result<Picture, String> {
        match self.kind_of(item) {
            Some(kind) if &kind == b"grid" => self.gridded(item),
            Some(_) => self.single(item),
            None => Err(format!("this HEIF file has no item {item}")),
        }
    }

    fn single(&self, item: u32) -> Result<Picture, String> {
        let mut picture = self.described(item)?;
        picture.tiles = vec![self
            .item_bytes(item)
            .ok_or_else(|| format!("item {item}'s coded bytes are not in the file"))?];
        picture.tile = (picture.width, picture.height);
        credible(&picture)?;
        Ok(picture)
    }

    /// A `grid` derived item: one picture assembled from a raster of coded tiles.
    ///
    /// **The shape every phone HEIC actually uses.** A 12MP still is stored as a grid of 512x512
    /// HEVC tiles, so a reader that only handles a single item reads nothing at all from one.
    fn gridded(&self, item: u32) -> Result<Picture, String> {
        let header = self
            .item_bytes(item)
            .ok_or_else(|| format!("grid item {item} has no payload"))?;
        let [_version, flags, rows_less_one, columns_less_one, rest @ ..] = &header[..] else {
            return Err("this HEIF file's grid header is truncated".to_string());
        };
        let wide = flags & 1 == 1;
        let field = |at: usize| -> Option<usize> {
            match wide {
                true => rest.get(at * 4..at * 4 + 4).map(|b| be32(b) as usize),
                false => rest.get(at * 2..at * 2 + 2).map(|b| be16(b) as usize),
            }
        };
        let (width, height) = (field(0), field(1));
        let (Some(width), Some(height)) = (width, height) else {
            return Err("this HEIF file's grid header is truncated".to_string());
        };
        let (columns, rows) = (usize::from(*columns_less_one) + 1, usize::from(*rows_less_one) + 1);

        let members = self.referenced(item, b"dimg");
        if members.len() != columns * rows {
            return Err(format!(
                "this HEIF file's grid says {columns}x{rows} and names {} tiles",
                members.len(),
            ));
        }
        // The tiles' own properties, off the first: a grid's members are all one size and one
        // codec, and the derived item carries none of that itself.
        let mut picture = self.described(members[0])?;
        picture.tile = (picture.width, picture.height);
        picture.width = width;
        picture.height = height;
        picture.grid = (columns, rows);
        picture.tiles = members
            .iter()
            .map(|tile| {
                self.item_bytes(*tile)
                    .ok_or_else(|| format!("grid tile {tile}'s coded bytes are not in the file"))
            })
            .collect::<Result<_, _>>()?;
        // The turn is the derived item's, not a tile's: `irot` on a grid member would rotate each
        // tile inside the mosaic. The colour is the derived item's too where it states one - a
        // grid is the picture being displayed, so that is where a writer puts `colr`, and reading
        // only the first tile's shows a PQ or HLG photograph as flat sRGB.
        picture.turn = self.turn_of(item);
        let (nclx, icc) = self.colour_of(item);
        if nclx.is_some() || icc.is_some() {
            picture.nclx = nclx;
            picture.icc = icc;
        }
        // A grid's declared size is a crop of the raster its tiles tile out to, which is always
        // inward: a larger one is a file asking for an allocation its own tiles cannot fill.
        if width > columns * picture.tile.0 || height > rows * picture.tile.1 {
            return Err(format!(
                "this HEIF file's grid says {width}x{height} out of {columns}x{rows} tiles of \
                 {}x{}",
                picture.tile.0, picture.tile.1,
            ));
        }
        credible(&picture)?;
        Ok(picture)
    }

    /// Everything a picture item's properties say about it, with no bytes gathered yet.
    fn described(&self, item: u32) -> Result<Picture, String> {
        let kind = self.kind_of(item).ok_or_else(|| format!("no item {item}"))?;
        let codec = match &kind {
            b"hvc1" | b"hev1" => Codec::Hevc,
            b"av01" => Codec::Av1,
            other => {
                return Err(format!(
                    "this HEIF file's picture is a {} item, which this build does not decode",
                    String::from_utf8_lossy(other),
                ));
            }
        };
        let mut picture = Picture {
            codec,
            width: 0,
            height: 0,
            depth: 8,
            config: Vec::new(),
            tiles: Vec::new(),
            grid: (1, 1),
            tile: (0, 0),
            nclx: None,
            icc: None,
            turn: Orientation::Normal,
            unhandled: None,
        };
        for (kind, body) in self.properties_of(item) {
            match kind {
                b"ispe" => {
                    picture.width = body.get(4..8).map_or(0, |b| be32(b) as usize);
                    picture.height = body.get(8..12).map_or(0, |b| be32(b) as usize);
                }
                b"hvcC" | b"av1C" => picture.config = body.to_vec(),
                b"pixi" => picture.depth = u32::from(*body.get(5).unwrap_or(&8)),
                _ => {}
            }
        }
        (picture.nclx, picture.icc) = self.colour_of(item);
        picture.turn = self.turn_of(item);
        picture.unhandled = self.unhandled_essential(item).map(|kind| {
            format!(
                "this HEIF item carries an essential {kind} property this build does not act on, \
                 so the picture may not be the one the file describes"
            )
        });
        if picture.width == 0 || picture.height == 0 {
            return Err(format!("item {item} does not say how big it is"));
        }
        Ok(picture)
    }

    /// What a `colr` box says an item's samples mean.
    ///
    /// Its own function because a `grid` needs it and is not a picture item: the codec check in
    /// [`Catalogue::described`] refuses a derived item outright, and the colour of a grid belongs
    /// to the grid rather than to whichever tile happens to be first.
    fn colour_of(&self, item: u32) -> (Option<Nclx>, Option<Vec<u8>>) {
        let (mut nclx, mut icc) = (None, None);
        for (kind, body) in self.properties_of(item) {
            if kind != b"colr" {
                continue;
            }
            match body.get(..4) {
                Some(b"nclx") => {
                    nclx = Some(Nclx {
                        primaries: body.get(4..6).map_or(1, be16),
                        transfer: body.get(6..8).map_or(13, be16),
                        matrix: body.get(8..10).map_or(1, be16),
                        full_range: body.get(10).is_some_and(|b| b & 0x80 != 0),
                    });
                }
                Some(b"prof") | Some(b"rICC") => icc = Some(body[4..].to_vec()),
                _ => {}
            }
        }
        (nclx, icc)
    }

    /// The turn `irot` and `imir` ask for, as the one `Orientation` the rest of the crate speaks.
    ///
    /// **Both, and in the order the specification applies them**: `irot` first and then `imir`,
    /// which is the order MIAF fixes for the transformative properties. Reading only `irot`
    /// leaves every selfie flipped, and composing them the other way round is a 180 degree error
    /// on exactly the four mixed cases - a front-camera picture taken sideways, upside down.
    fn turn_of(&self, item: u32) -> Orientation {
        let mut quarters = 0u8;
        let mut mirrored = None;
        for (kind, body) in self.properties_of(item) {
            match kind {
                b"irot" => quarters = body.first().copied().unwrap_or(0) & 3,
                b"imir" => mirrored = body.first().map(|axis| axis & 1),
                _ => {}
            }
        }
        turn_of(quarters, mirrored)
    }

    fn properties_of(&self, item: u32) -> impl Iterator<Item = (&'a [u8; 4], &'a [u8])> + '_ {
        self.assigned
            .get(&item)
            .into_iter()
            .flatten()
            .filter_map(|at| self.properties.get(at.index.wrapping_sub(1)).copied())
    }

    /// A property this item calls essential that this build does not act on.
    ///
    /// **Said out loud rather than ignored.** The essential bit means "a reader that does not
    /// understand this must not display the picture", and the one that matters is `clap`: a clean
    /// aperture this reader skips is a photograph shown wider than the file says it is. Warned
    /// rather than refused, because dropping an importable photograph over a property almost no
    /// file carries is the worse of the two failures - but silence is not one of the options.
    fn unhandled_essential(&self, item: u32) -> Option<String> {
        const HANDLED: [&[u8; 4]; 7] =
            [b"ispe", b"hvcC", b"av1C", b"pixi", b"colr", b"irot", b"imir"];
        let assigned = self.assigned.get(&item)?;
        assigned.iter().filter(|it| it.essential).find_map(|at| {
            let (kind, _) = self.properties.get(at.index.wrapping_sub(1))?;
            match HANDLED.contains(&kind) {
                true => None,
                false => Some(String::from_utf8_lossy(*kind).into_owned()),
            }
        })
    }

    /// An item's bytes, gathered across however many extents `iloc` split them into.
    fn item_bytes(&self, item: u32) -> Option<Vec<u8>> {
        let location = self.locations.get(&item)?;
        let source = match location.construction {
            0 => self.bytes,
            1 => self.idat,
            _ => return None,
        };
        let mut out = Vec::new();
        for (at, length) in &location.extents {
            out.extend_from_slice(source.get(*at..at.checked_add(*length)?)?);
        }
        Some(out)
    }
}

/// Apple's auxiliary gain map, which is what an iPhone HEIC carried before ISO 21496-1.
pub const APPLE_GAIN_MAP: &str = "urn:com:apple:photo:2020:aux:hdrgainmap";

/// `irot` then `imir` as one orientation.
///
/// `irot`'s angle is anticlockwise and counts the turns *already applied* to the stored picture, so
/// a reader undoes it - which is the same direction `Orientation` means.
///
/// **The order is the specification's, and it is only visible on four of the eight.** MIAF fixes
/// the association order as `clap`, `irot`, `imir`, and a mirror does not commute with a quarter
/// turn: `M . R(t) == R(-t) . M`. So composing them the other way round leaves the four mixed
/// cases 180 degrees out - a front-camera picture taken sideways, the right size and the right
/// pixels, upside down. The pure rotations and the pure mirrors are the same either way.
fn turn_of(quarters: u8, mirrored: Option<u8>) -> Orientation {
    match (quarters, mirrored) {
        (0, None) => Orientation::Normal,
        (1, None) => Orientation::Rotate270,
        (2, None) => Orientation::Rotate180,
        (3, None) => Orientation::Rotate90,
        // `imir` 0 mirrors about a horizontal axis, which flips top for bottom.
        (0, Some(0)) => Orientation::VerticalFlip,
        (0, Some(_)) => Orientation::HorizontalFlip,
        (2, Some(0)) => Orientation::HorizontalFlip,
        (2, Some(_)) => Orientation::VerticalFlip,
        (1, Some(0)) => Orientation::Transpose,
        (1, Some(_)) => Orientation::Transverse,
        (3, Some(0)) => Orientation::Transverse,
        (3, Some(_)) => Orientation::Transpose,
        // `irot` is two bits, so there is no fifth quarter turn to reach here.
        _ => Orientation::Normal,
    }
}

/// Whether a picture's declared size is one a decoder should allocate for.
///
/// **The container is what vouches for these numbers, so it is where they are checked.** `ispe`
/// and a `grid` header are file-controlled `u32`s, and the consumer allocates from them before it
/// decodes anything: rawshim's `hevc::decode` reserves `width * height * 3` samples, so a file
/// claiming 65535 by 65535 asks for 25GB and the allocator's failure is an abort that its `guard`
/// cannot catch - the whole server, not the one job. A larger one overflows the multiply instead.
///
/// An absolute bound, not one relative to the file's length: AV1 codes a flat sky in almost
/// nothing, and a 1200x800 web image in 65kB is past any ratio that still rejects the 25GB file.
fn credible(picture: &Picture) -> Result<(), String> {
    match picture.width.checked_mul(picture.height).filter(|pixels| *pixels <= MAX_PIXELS) {
        Some(_) => Ok(()),
        None => Err(format!(
            "this HEIF file says its picture is {}x{}, which is past the {MAX_PIXELS} pixels this \
             reader opens",
            picture.width, picture.height,
        )),
    }
}

/// A gigapixel: past any panorama this application stitches.
const MAX_PIXELS: usize = 1 << 30;

fn be16(bytes: &[u8]) -> u16 {
    u16::from_be_bytes([bytes[0], bytes[1]])
}

fn be32(bytes: &[u8]) -> u32 {
    u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
}

/// A box's children: its four-character type and its payload.
///
/// Handles the 64-bit `largesize` form and the `size == 0` tail, and stops at the first header it
/// cannot read rather than walking off the end - a truncated file reports the picture it managed
/// to describe instead of panicking.
fn boxes(bytes: &[u8]) -> impl Iterator<Item = (&[u8; 4], &[u8])> {
    let mut at = 0usize;
    std::iter::from_fn(move || {
        let header = bytes.get(at..at + 8)?;
        let kind: &[u8; 4] = header[4..8].try_into().ok()?;
        let (body_at, size) = match be32(&header[..4]) {
            // Everything to the end of the parent.
            0 => (at + 8, bytes.len() - at),
            1 => {
                let large = bytes.get(at + 8..at + 16)?;
                let size = u64::from_be_bytes(large.try_into().ok()?) as usize;
                (at + 16, size)
            }
            size => (at + 8, size as usize),
        };
        let end = at.checked_add(size.max(8))?.min(bytes.len());
        let body = bytes.get(body_at..end)?;
        at = end;
        Some((kind, body))
    })
}

/// The first top-level box of this type.
fn top_level<'a>(bytes: &'a [u8], want: &[u8; 4]) -> Option<&'a [u8]> {
    boxes(bytes).find(|(kind, _)| *kind == want).map(|(_, body)| body)
}

fn read_pitm(body: &[u8]) -> Option<u32> {
    match body.first() {
        Some(0) => body.get(4..6).map(|b| u32::from(be16(b))),
        Some(_) => body.get(4..8).map(be32),
        None => None,
    }
}

fn read_iinf(body: &[u8]) -> std::collections::HashMap<u32, Entry> {
    let version = body.first().copied().unwrap_or(0);
    let after_count = match version {
        0 => 6,
        _ => 8,
    };
    let mut out = std::collections::HashMap::new();
    for (kind, entry) in boxes(body.get(after_count..).unwrap_or(&[])) {
        if kind != b"infe" {
            continue;
        }
        let version = entry.first().copied().unwrap_or(0);
        // Versions 0 and 1 name the item by a two-byte id and carry no item type at all; the
        // still-image profiles are all version 2 or 3.
        let (id, kind_at) = match version {
            2 => (entry.get(4..6).map(|b| u32::from(be16(b))), 8),
            3 => (entry.get(4..8).map(be32), 10),
            _ => (None, 0),
        };
        let (Some(id), Some(kind)) = (id, entry.get(kind_at..kind_at + 4)) else { continue };
        let kind: [u8; 4] = match kind.try_into() {
            Ok(kind) => kind,
            Err(_) => continue,
        };
        out.insert(id, Entry { kind });
    }
    out
}

fn read_iloc(body: &[u8]) -> std::collections::HashMap<u32, Location> {
    let mut out = std::collections::HashMap::new();
    let version = body.first().copied().unwrap_or(0);
    let Some(sizes) = body.get(4..6) else { return out };
    let (offset_size, length_size) = ((sizes[0] >> 4) as usize, (sizes[0] & 15) as usize);
    let (base_size, index_size) = ((sizes[1] >> 4) as usize, (sizes[1] & 15) as usize);

    let mut at = 6;
    let count = match version < 2 {
        true => {
            let count = body.get(at..at + 2).map_or(0, be16) as usize;
            at += 2;
            count
        }
        false => {
            let count = body.get(at..at + 4).map_or(0, be32) as usize;
            at += 4;
            count
        }
    };

    let number = |body: &[u8], at: usize, width: usize| -> Option<usize> {
        let bytes = body.get(at..at + width)?;
        Some(bytes.iter().fold(0usize, |value, byte| (value << 8) | usize::from(*byte)))
    };

    for _ in 0..count {
        let id = match version < 2 {
            true => body.get(at..at + 2).map(|b| u32::from(be16(b))).inspect(|_| at += 2),
            false => body.get(at..at + 4).map(be32).inspect(|_| at += 4),
        };
        let Some(id) = id else { break };
        let construction = match version >= 1 {
            true => {
                let method = body.get(at + 1).copied().unwrap_or(0) & 15;
                at += 2;
                method
            }
            false => 0,
        };
        // A non-zero `data_reference_index` means the extents index a *different* file, and this
        // reader has only this one - so its offsets would be read out of the wrong bytes and
        // handed to a decoder as if they were the picture. Declined rather than misread.
        let external = body.get(at..at + 2).map(be16).unwrap_or(0) != 0;
        at += 2;
        let Some(base) = number(body, at, base_size) else { break };
        at += base_size;
        let Some(extents) = body.get(at..at + 2).map(be16) else { break };
        at += 2;

        let mut spans = Vec::new();
        let mut whole = true;
        for _ in 0..extents {
            if version >= 1 && index_size > 0 {
                at += index_size;
            }
            let (Some(offset), Some(length)) =
                (number(body, at, offset_size), number(body, at + offset_size, length_size))
            else {
                whole = false;
                break;
            };
            at += offset_size + length_size;
            // **Checked, because both halves are eight bytes out of the file.** An `iloc` stating
            // `0xFFFF_FFFF_FFFF_FFFF` for each overflows the add, and `overflow-checks` is on in
            // every profile this ships - so the sum is a panic rather than a wrong offset, which
            // on the browser build is a trapped module rather than a photograph that will not
            // open.
            match base.checked_add(offset) {
                Some(start) => spans.push((start, length)),
                None => whole = false,
            }
        }
        // A partial list is worse than none: the cursor is now misaligned, so every later item
        // would be minted from the wrong bytes and could overwrite a good one.
        if !whole {
            break;
        }
        if !external {
            out.insert(id, Location { construction, extents: spans });
        }
    }
    out
}

fn read_ipma(body: &[u8]) -> std::collections::HashMap<u32, Vec<Association>> {
    let mut out = std::collections::HashMap::new();
    let version = body.first().copied().unwrap_or(0);
    let wide_index = body.get(3).is_some_and(|flags| flags & 1 == 1);
    let mut at = 4;
    let count = body.get(at..at + 4).map_or(0, be32) as usize;
    at += 4;
    for _ in 0..count {
        let id = match version < 1 {
            true => body.get(at..at + 2).map(|b| u32::from(be16(b))).inspect(|_| at += 2),
            false => body.get(at..at + 4).map(be32).inspect(|_| at += 4),
        };
        let Some(id) = id else { break };
        let Some(associations) = body.get(at).copied() else { break };
        at += 1;
        let mut indices = Vec::new();
        for _ in 0..associations {
            // The top bit is `essential`, which is kept rather than masked away: a property this
            // reader skips is a different question depending on whether the file said it may be.
            let index = match wide_index {
                true => body
                    .get(at..at + 2)
                    .map(|b| {
                        let word = be16(b);
                        Association { index: usize::from(word & 0x7fff), essential: word & 0x8000 != 0 }
                    })
                    .inspect(|_| at += 2),
                false => body
                    .get(at)
                    .map(|b| Association { index: usize::from(b & 0x7f), essential: b & 0x80 != 0 })
                    .inspect(|_| at += 1),
            };
            let Some(index) = index else { break };
            indices.push(index);
        }
        out.insert(id, indices);
    }
    out
}

fn read_iref(body: &[u8]) -> Vec<([u8; 4], u32, Vec<u32>)> {
    let version = body.first().copied().unwrap_or(0);
    let mut out = Vec::new();
    for (kind, entry) in boxes(body.get(4..).unwrap_or(&[])) {
        let wide = version >= 1;
        let step = match wide {
            true => 4,
            false => 2,
        };
        let read = |at: usize| -> Option<u32> {
            match wide {
                true => entry.get(at..at + 4).map(be32),
                false => entry.get(at..at + 2).map(|b| u32::from(be16(b))),
            }
        };
        let Some(from) = read(0) else { continue };
        let Some(count) = entry.get(step..step + 2).map(be16) else { continue };
        let to = (0..usize::from(count)).filter_map(|k| read(step + 2 + k * step)).collect();
        out.push((*kind, from, to));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A box the size of its own header and nothing else is legal, and a walk that does not treat
    /// it as progress spins forever on it.
    #[test]
    fn the_walk_makes_progress_through_an_empty_box() {
        let mut file = Vec::new();
        file.extend_from_slice(&8u32.to_be_bytes());
        file.extend_from_slice(b"free");
        file.extend_from_slice(&12u32.to_be_bytes());
        file.extend_from_slice(b"mdat");
        file.extend_from_slice(&[1, 2, 3, 4]);
        let found: Vec<_> = boxes(&file).map(|(kind, body)| (*kind, body.len())).collect();
        assert_eq!(found, vec![(*b"free", 0), (*b"mdat", 4)]);
    }

    /// A size that runs past the buffer is a truncated file, which reports what it has rather
    /// than indexing off the end.
    #[test]
    fn a_truncated_box_stops_the_walk_rather_than_panicking() {
        let mut file = Vec::new();
        file.extend_from_slice(&64u32.to_be_bytes());
        file.extend_from_slice(b"meta");
        file.extend_from_slice(&[0; 4]);
        let found: Vec<_> = boxes(&file).map(|(kind, body)| (*kind, body.len())).collect();
        assert_eq!(found, vec![(*b"meta", 4)]);
    }

    /// A CR3 is an ISOBMFF file too, and reading one as a HEIF is a Canon library that imports
    /// nothing.
    #[test]
    fn a_raw_in_the_same_container_family_is_not_a_heif() {
        let ftyp = |brand: &[u8; 4], compatible: &[&[u8; 4]]| {
            let mut out = Vec::new();
            let body = 8 + 4 * compatible.len();
            out.extend_from_slice(&((body + 8) as u32).to_be_bytes());
            out.extend_from_slice(b"ftyp");
            out.extend_from_slice(brand);
            out.extend_from_slice(&0u32.to_be_bytes());
            for brand in compatible {
                out.extend_from_slice(*brand);
            }
            out
        };
        assert!(!is_heif(&ftyp(b"crx ", &[b"crx ", b"isom"])), "a CR3");
        assert!(!is_heif(&ftyp(b"isom", &[b"mp42"])), "an MP4");
        assert!(is_heif(&ftyp(b"heic", &[b"mif1", b"heic"])), "an iPhone HEIC");
        assert!(is_heif(&ftyp(b"avif", &[b"avif", b"mif1"])), "an AVIF");
        // The generic still brand on its own, which is what a Canon or Fujifilm HIF declares.
        assert!(is_heif(&ftyp(b"mif1", &[b"heix"])));
        assert!(!is_heif(b"II*\0"), "and something that is not ISOBMFF at all");
    }

    #[test]
    fn a_mirror_and_a_rotation_compose_into_one_orientation() {
        assert_eq!(turn_of(0, None), Orientation::Normal);
        // `irot` counts anticlockwise quarter turns already applied.
        assert_eq!(turn_of(1, None), Orientation::Rotate270);
        assert_eq!(turn_of(3, None), Orientation::Rotate90);
        // A selfie: mirrored about the vertical axis, no rotation.
        assert_eq!(turn_of(0, Some(1)), Orientation::HorizontalFlip);
    }

    /// **`irot` before `imir`, which is the order MIAF fixes.** A mirror does not commute with a
    /// quarter turn, so the four mixed cases are the only ones that can be wrong - and composing
    /// them the other way round swaps `Transpose` for `Transverse`, which is a photograph 180
    /// degrees out. Held against libheif's own writer, which emits EXIF 5 as a 270 degree `irot`
    /// with a horizontal `imir` and EXIF 7 as the same turn with a vertical one.
    #[test]
    fn a_quarter_turn_and_a_mirror_compose_in_the_specifications_order() {
        assert_eq!(turn_of(1, Some(0)), Orientation::Transpose);
        assert_eq!(turn_of(1, Some(1)), Orientation::Transverse);
        assert_eq!(turn_of(3, Some(0)), Orientation::Transverse);
        assert_eq!(turn_of(3, Some(1)), Orientation::Transpose);
    }

    /// An `iloc` is two file-controlled integers added together, and `overflow-checks` is on in
    /// every profile this ships - so an unchecked sum is a panic, which on the browser build is a
    /// trapped module rather than a photograph that will not open.
    #[test]
    fn an_iloc_that_adds_past_the_address_space_is_declined_rather_than_panicking() {
        let mut iloc = Vec::new();
        iloc.extend_from_slice(&[1, 0, 0, 0]); // version 1
        iloc.push(0x88); // eight-byte offsets and lengths
        iloc.push(0x80); // eight-byte base offset, no index
        iloc.extend_from_slice(&1u16.to_be_bytes()); // one item
        iloc.extend_from_slice(&7u16.to_be_bytes()); // item 7
        iloc.extend_from_slice(&0u16.to_be_bytes()); // construction method 0
        iloc.extend_from_slice(&0u16.to_be_bytes()); // data reference
        iloc.extend_from_slice(&u64::MAX.to_be_bytes()); // base offset
        iloc.extend_from_slice(&1u16.to_be_bytes()); // one extent
        iloc.extend_from_slice(&u64::MAX.to_be_bytes()); // extent offset
        iloc.extend_from_slice(&16u64.to_be_bytes()); // extent length

        assert!(read_iloc(&iloc).get(&7).is_none(), "the item is dropped, not summed");
    }

    /// A declared size is a `u32` out of the file and the decoder allocates from it, so an absurd
    /// one has to be refused *here* - an allocation that large aborts the process, which rawshim's
    /// `guard` cannot catch.
    #[test]
    fn a_picture_too_large_to_allocate_is_refused() {
        let huge = Picture {
            codec: Codec::Hevc,
            width: 65535,
            height: 65535,
            depth: 8,
            config: Vec::new(),
            tiles: Vec::new(),
            grid: (1, 1),
            tile: (65535, 65535),
            nclx: None,
            icc: None,
            turn: Orientation::Normal,
            unhandled: None,
        };
        assert!(credible(&huge).is_err(), "25 gigabytes");
        // And the overflow case, which is the lucky one: the multiply wraps rather than asking.
        let wrapping = Picture { width: usize::MAX, height: 3, ..huge };
        assert!(credible(&wrapping).is_err());

        let ordinary = Picture { width: 4032, height: 3024, ..wrapping };
        assert!(credible(&ordinary).is_ok(), "a 12MP HEIC");
        let panorama = Picture { width: 33804, height: 8000, ..ordinary };
        assert!(credible(&panorama).is_ok(), "a stitched panorama");
    }

    /// The `iloc` walk against a hand-built box, since every camera's differs only in its widths.
    #[test]
    fn an_item_location_is_read_at_whatever_widths_it_declares() {
        let mut iloc = Vec::new();
        iloc.extend_from_slice(&[0, 0, 0, 0]); // version 0, no flags
        iloc.push(0x44); // four-byte offsets, four-byte lengths
        iloc.push(0x00); // no base offset, no index
        iloc.extend_from_slice(&1u16.to_be_bytes()); // one item
        iloc.extend_from_slice(&7u16.to_be_bytes()); // item 7
        iloc.extend_from_slice(&0u16.to_be_bytes()); // data reference
        iloc.extend_from_slice(&2u16.to_be_bytes()); // two extents
        iloc.extend_from_slice(&100u32.to_be_bytes());
        iloc.extend_from_slice(&10u32.to_be_bytes());
        iloc.extend_from_slice(&200u32.to_be_bytes());
        iloc.extend_from_slice(&20u32.to_be_bytes());

        let read = read_iloc(&iloc);
        let location = read.get(&7).expect("item 7");
        assert_eq!(location.construction, 0);
        assert_eq!(location.extents, vec![(100, 10), (200, 20)]);
    }
}
