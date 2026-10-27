//! A HEIC as the viewer's stage draws it: the coded tiles the page's own hardware decoder reads, and
//! what the samples it hands back mean.

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub base: Coded,
    pub gain: Option<Gain>,
    /// Clockwise degrees that stand the picture up. None for a mirrored one, which the stage
    /// cannot draw.
    pub rotation: Option<u16>,
    /// The base's linear RGB to Rec.2020, a row per vector.
    pub matrix: [[f32; 3]; 3],
    /// Where the transfer table is in the payload: `code * 3 + channel` as `f32`s, light with
    /// diffuse white at 1.0, which is `linearise.slang`'s table.
    pub table: Span,
    /// Why the picture may not be the one the file describes, as a sentence.
    pub unhandled: Option<String>,
}

/// One coded picture: a grid of tiles, or a grid of one.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Coded {
    pub width: usize,
    pub height: usize,
    pub depth: u32,
    pub grid: [usize; 2],
    pub tile: [usize; 2],
    /// The `hvcC` record, which is a decoder's `description`.
    pub config: Span,
    /// The WebCodecs codec string the record declares (ISO/IEC 14496-15 Annex E).
    pub codec: String,
    pub tiles: Vec<Span>,
    /// The YCbCr matrix's luma weights for red and blue.
    pub kr: f32,
    pub kb: f32,
    pub full_range: bool,
}

#[derive(Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "mode"
)]
pub enum Gain {
    Iso {
        map: Coded,
        min: [f32; 3],
        max: [f32; 3],
        gamma: [f32; 3],
        offset_base: [f32; 3],
        offset_alternate: [f32; 3],
        /// The brightest the map takes diffuse white, which is where the stage's roll-off fits from.
        brightest: f32,
    },
    Apple {
        map: Coded,
        headroom: f32,
        brightest: f32,
    },
}

/// Bytes into the payload behind the JSON.
#[derive(Serialize, Clone, Copy)]
pub struct Span {
    pub offset: usize,
    pub length: usize,
}

/// The view, framed: a little-endian `u32` length, that much JSON, padding to a word, then the
/// payload its spans point into.
pub fn framed(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let file = crate::rendered::read_heif(bytes)?;
    let mut payload = Vec::new();
    let view = view_of(&file, &mut payload)?;
    framing(&view, &payload)
}

fn framing(view: &View, payload: &[u8]) -> Result<Vec<u8>, String> {
    let json = serde_json::to_vec(view).map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(4 + json.len() + 3 + payload.len());
    out.extend_from_slice(&(json.len() as u32).to_le_bytes());
    out.extend_from_slice(&json);
    out.resize(out.len().next_multiple_of(4), 0);
    out.extend_from_slice(payload);
    Ok(out)
}

fn view_of(file: &heif::File, payload: &mut Vec<u8>) -> Result<View, String> {
    let picture = &file.primary;
    if picture.codec != heif::Codec::Hevc {
        return Err("this HEIF holds no HEVC picture".to_string());
    }
    let coding = crate::rendered::coding_of(picture, depth_of(picture));
    let table = coding.table();
    // The base's brightest code, which is above diffuse white for a PQ or HLG one.
    let peak = table.get(table.len().saturating_sub(3)).copied().unwrap_or(1.0);
    let base = coded(picture, payload);
    let gain = file.gain.as_ref().and_then(|map| {
        if map.picture.codec != heif::Codec::Hevc {
            return None;
        }
        let terms = crate::rendered::heif_terms(map, file.exif.as_deref())?;
        let brightest = terms.brightest(f64::from(peak)) as f32;
        let map_coded = coded(&map.picture, payload);
        Some(match terms {
            crate::gain_map::Reconstruction::Iso {
                min,
                max,
                gamma,
                offset_base,
                offset_alternate,
            } => Gain::Iso {
                map: map_coded,
                min,
                max,
                gamma,
                offset_base,
                offset_alternate,
                brightest,
            },
            crate::gain_map::Reconstruction::Apple { headroom } => Gain::Apple {
                map: map_coded,
                headroom,
                brightest,
            },
        })
    });
    payload.resize(payload.len().next_multiple_of(4), 0);
    let table_span = Span {
        offset: payload.len(),
        length: table.len() * 4,
    };
    payload.extend(table.iter().flat_map(|value| value.to_le_bytes()));
    Ok(View {
        base,
        gain,
        rotation: rotation_of(picture.turn),
        matrix: coding.matrix,
        table: table_span,
        unhandled: picture.unhandled.clone(),
    })
}

fn coded(picture: &heif::Picture, payload: &mut Vec<u8>) -> Coded {
    let mut keep = |bytes: &[u8]| {
        let span = Span {
            offset: payload.len(),
            length: bytes.len(),
        };
        payload.extend_from_slice(bytes);
        span
    };
    let config = keep(&picture.config);
    let tiles = picture.tiles.iter().map(|tile| keep(tile)).collect();
    let signal = heif::signal_of(picture);
    let (kr, kb) = crate::hevc::coefficients(signal);
    Coded {
        width: picture.width,
        height: picture.height,
        depth: depth_of(picture),
        grid: [picture.grid.0, picture.grid.1],
        tile: [picture.tile.0, picture.tile.1],
        config,
        codec: codec_of(&picture.config),
        tiles,
        kr,
        kb,
        full_range: signal.is_some_and(|it| it.full_range),
    }
}

/// The bitstream's luma depth out of its `hvcC`, which is what a decoder hands back whatever the
/// container's `pixi` says.
fn depth_of(picture: &heif::Picture) -> u32 {
    picture
        .config
        .get(17)
        .map_or(picture.depth, |byte| u32::from(byte & 0x07) + 8)
}

fn codec_of(config: &[u8]) -> String {
    let Some(head) = config.get(..13) else {
        return "hvc1".to_string();
    };
    let space = ["", "A", "B", "C"][usize::from(head[1] >> 6)];
    let tier = if head[1] & 0x20 != 0 { 'H' } else { 'L' };
    let compatibility = u32::from_be_bytes([head[2], head[3], head[4], head[5]]).reverse_bits();
    let constraints = &head[6..12];
    let kept = constraints
        .iter()
        .rposition(|byte| *byte != 0)
        .map_or(0, |last| last + 1);
    let tail: String = constraints[..kept]
        .iter()
        .map(|byte| format!(".{byte:X}"))
        .collect();
    format!(
        "hvc1.{space}{}.{compatibility:X}.{tier}{}{tail}",
        head[1] & 0x1f,
        head[12]
    )
}

fn rotation_of(turn: heif::Orientation) -> Option<u16> {
    match turn {
        heif::Orientation::Normal => Some(0),
        heif::Orientation::Rotate90 => Some(90),
        heif::Orientation::Rotate180 => Some(180),
        heif::Orientation::Rotate270 => Some(270),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn picture(tiles: usize) -> heif::Picture {
        heif::Picture {
            codec: heif::Codec::Hevc,
            width: 1000,
            height: 750,
            depth: 8,
            config: vec![1, 2, 3],
            tiles: (0..tiles).map(|at| vec![at as u8; 5]).collect(),
            grid: (2, 2),
            tile: (512, 512),
            nclx: Some(heif::Nclx {
                primaries: 1,
                transfer: 13,
                matrix: 5,
                full_range: true,
            }),
            icc: None,
            turn: heif::Orientation::Rotate90,
            unhandled: None,
        }
    }

    fn gain_mapped() -> heif::File {
        heif::File {
            primary: picture(4),
            exif: None,
            gain: Some(heif::GainMap {
                picture: picture(2),
                metadata: Some(vec![
                    0, 0, 0, 0, 0, 0x00, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0,
                    0, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0,
                    0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1,
                ]),
            }),
        }
    }

    fn keys(value: &serde_json::Value) -> Vec<&str> {
        let mut keys: Vec<&str> = value
            .as_object()
            .expect("an object")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        keys
    }

    /// The names `heif_decode.ts` reads, and the framing it reads them out of.
    #[test]
    fn the_framed_view_is_what_the_page_reads() {
        let mut payload = Vec::new();
        let view = view_of(&gain_mapped(), &mut payload).expect("a view");
        let framed = framing(&view, &payload).expect("framed");

        let length = u32::from_le_bytes(framed[..4].try_into().unwrap()) as usize;
        let json: serde_json::Value = serde_json::from_slice(&framed[4..4 + length]).expect("json");
        assert_eq!(&framed[(4 + length).next_multiple_of(4)..], &payload[..]);
        assert_eq!(
            keys(&json),
            ["base", "gain", "matrix", "rotation", "table", "unhandled"]
        );
        assert_eq!(
            keys(&json["base"]),
            [
                "codec",
                "config",
                "depth",
                "fullRange",
                "grid",
                "height",
                "kb",
                "kr",
                "tile",
                "tiles",
                "width"
            ]
        );
        assert_eq!(
            keys(&json["gain"]),
            [
                "brightest",
                "gamma",
                "map",
                "max",
                "min",
                "mode",
                "offsetAlternate",
                "offsetBase"
            ]
        );
        assert_eq!(json["gain"]["mode"], "iso");
        assert_eq!(keys(&json["table"]), ["length", "offset"]);
        let apple = serde_json::to_value(Gain::Apple {
            map: view_of(&gain_mapped(), &mut Vec::new()).unwrap().base,
            headroom: 4.0,
            brightest: 4.0,
        })
        .unwrap();
        assert_eq!(keys(&apple), ["brightest", "headroom", "map", "mode"]);
        assert_eq!(apple["mode"], "apple");
    }

    /// Every span lands on the bytes it names, through the base, the map and the table after them.
    #[test]
    fn the_spans_point_at_the_bytes_they_name() {
        let mut payload = Vec::new();
        let view = view_of(&gain_mapped(), &mut payload).expect("a view");
        let at = |span: Span| &payload[span.offset..span.offset + span.length];

        assert_eq!(at(view.base.config), [1, 2, 3]);
        assert_eq!(at(view.base.tiles[3]), [3; 5]);
        assert_eq!(
            (view.base.kr, view.base.kb, view.base.full_range),
            (0.299, 0.114, true)
        );
        assert_eq!(view.rotation, Some(90));
        let Some(Gain::Iso {
            map,
            max,
            brightest,
            ..
        }) = view.gain
        else {
            panic!("an ISO gain map");
        };
        assert_eq!(at(map.tiles[1]), [1; 5]);
        assert_eq!(max, [2.0; 3]);
        assert_eq!(brightest, 4.0, "two stops above diffuse white");
        assert_eq!(view.table.offset % 4, 0);
        let table: Vec<f32> = at(view.table)
            .chunks_exact(4)
            .map(|word| f32::from_le_bytes(word.try_into().unwrap()))
            .collect();
        assert_eq!(table.len(), 256 * 3);
        assert_eq!(table[0], 0.0);
        assert!(
            (table[255 * 3] - 1.0).abs() < 1e-6,
            "full scale is diffuse white"
        );
    }

    #[test]
    fn the_codec_string_is_the_records_own() {
        let galaxy = [1, 3, 0x10, 0, 0, 0, 0xb0, 0, 0, 0, 0, 0, 0x96, 0xf0];
        assert_eq!(codec_of(&galaxy), "hvc1.3.8.L150.B0");
        let main = [1, 1, 0x60, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 0x5d];
        assert_eq!(codec_of(&main), "hvc1.1.6.L93.90");
    }

    #[test]
    fn the_depth_is_the_bitstreams_whatever_pixi_says() {
        let mut ten = picture(1);
        ten.config = vec![0; 23];
        ten.config[17] = 0xfa; // reserved ones, then bitDepthLumaMinus8 = 2
        assert_eq!(depth_of(&ten), 10);
        assert_eq!(depth_of(&picture(1)), 8, "no record past its header");
    }

    #[test]
    fn a_mirrored_picture_has_no_rotation_the_stage_can_draw() {
        assert_eq!(rotation_of(heif::Orientation::HorizontalFlip), None);
        assert_eq!(rotation_of(heif::Orientation::Rotate270), Some(270));
    }
}
