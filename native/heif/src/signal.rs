//! What an HEVC bitstream says its samples mean, out of the sequence parameter set's VUI.

use crate::Nclx;

/// The VUI's video signal type, out of the SPS in an `hvcC` record. None where the record holds no
/// SPS, the SPS has no VUI or states no signal type, or it is shaped in a way this does not walk.
pub fn of_hvcc(config: &[u8]) -> Option<Nclx> {
    let sps = sps_payload(config)?;
    read_sps(&mut Bits::new(&sps))
}

const SPS_NAL: u8 = 33;

/// The first SPS in the record, past its two-byte NAL header, with emulation prevention removed.
fn sps_payload(config: &[u8]) -> Option<Vec<u8>> {
    let arrays = *config.get(22)?;
    let mut at = 23;
    for _ in 0..arrays {
        let kind = config.get(at)? & 0x3f;
        let count = u16::from_be_bytes([*config.get(at + 1)?, *config.get(at + 2)?]);
        at += 3;
        for _ in 0..count {
            let length = usize::from(u16::from_be_bytes([*config.get(at)?, *config.get(at + 1)?]));
            let nal = config.get(at + 2..at + 2 + length)?;
            at += 2 + length;
            if kind == SPS_NAL {
                return Some(unescaped(nal.get(2..)?));
            }
        }
    }
    None
}

fn unescaped(nal: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(nal.len());
    let mut zeros = 0;
    for &byte in nal {
        if zeros >= 2 && byte == 3 {
            zeros = 0;
            continue;
        }
        zeros = if byte == 0 { zeros + 1 } else { 0 };
        out.push(byte);
    }
    out
}

/// H.265 7.3.2.2, as far as `vui_parameters`' video signal type.
fn read_sps(bits: &mut Bits<'_>) -> Option<Nclx> {
    bits.skip(4)?; // sps_video_parameter_set_id
    let sub_layers = bits.read(3)? as usize; // sps_max_sub_layers_minus1
    bits.skip(1)?; // sps_temporal_id_nesting_flag
    profile_tier_level(bits, sub_layers)?;
    bits.ue()?; // sps_seq_parameter_set_id
    if bits.ue()? == 3 {
        bits.skip(1)?; // separate_colour_plane_flag
    }
    bits.ue()?; // pic_width_in_luma_samples
    bits.ue()?; // pic_height_in_luma_samples
    if bits.flag()? {
        for _ in 0..4 {
            bits.ue()?; // conformance window offsets
        }
    }
    bits.ue()?; // bit_depth_luma_minus8
    bits.ue()?; // bit_depth_chroma_minus8
    let poc_lsb_bits = usize::try_from(bits.ue()?).ok()?.checked_add(4)?; // log2_max_pic_order_cnt_lsb_minus4
    let ordering_for_every_layer = bits.flag()?;
    let first = if ordering_for_every_layer {
        0
    } else {
        sub_layers
    };
    for _ in first..=sub_layers {
        for _ in 0..3 {
            bits.ue()?; // max_dec_pic_buffering, max_num_reorder_pics, max_latency_increase
        }
    }
    for _ in 0..6 {
        bits.ue()?; // block and transform sizes, transform hierarchy depths
    }
    if bits.flag()? && bits.flag()? {
        scaling_list_data(bits)?;
    }
    bits.skip(2)?; // amp_enabled_flag, sample_adaptive_offset_enabled_flag
    if bits.flag()? {
        bits.skip(8)?; // pcm sample bit depths
        bits.ue()?;
        bits.ue()?;
        bits.skip(1)?;
    }
    short_term_ref_pic_sets(bits)?;
    if bits.flag()? {
        for _ in 0..bits.ue()? {
            bits.skip(poc_lsb_bits.checked_add(1)?)?; // lt_ref_pic_poc_lsb_sps, used_by_curr_pic_lt
        }
    }
    bits.skip(2)?; // sps_temporal_mvp_enabled_flag, strong_intra_smoothing_enabled_flag
    if !bits.flag()? {
        return None; // no VUI
    }
    if bits.flag()? && bits.read(8)? == 255 {
        bits.skip(32)?; // sar_width, sar_height
    }
    if bits.flag()? {
        bits.skip(1)?; // overscan_appropriate_flag
    }
    if !bits.flag()? {
        return None; // no video signal type
    }
    bits.skip(3)?; // video_format
    let full_range = bits.flag()?;
    let (primaries, transfer, matrix) = match bits.flag()? {
        true => (bits.byte()?, bits.byte()?, bits.byte()?),
        // H.273's "unspecified" for each.
        false => (2, 2, 2),
    };
    Some(Nclx {
        primaries,
        transfer,
        matrix,
        full_range,
    })
}

/// 7.3.3, for the SPS: the general profile and level, then each sub-layer's where present.
fn profile_tier_level(bits: &mut Bits<'_>, sub_layers: usize) -> Option<()> {
    bits.skip(88 + 8)?; // general profile fields, general_level_idc
    let mut present = Vec::with_capacity(sub_layers);
    for _ in 0..sub_layers {
        present.push((bits.flag()?, bits.flag()?));
    }
    if sub_layers > 0 {
        bits.skip(2 * (8 - sub_layers))?; // reserved_zero_2bits
    }
    for (profile, level) in present {
        if profile {
            bits.skip(88)?;
        }
        if level {
            bits.skip(8)?;
        }
    }
    Some(())
}

/// 7.3.4, read for its length alone.
fn scaling_list_data(bits: &mut Bits<'_>) -> Option<()> {
    for size in 0..4usize {
        let step = if size == 3 { 3 } else { 1 };
        for _ in (0..6).step_by(step) {
            if !bits.flag()? {
                bits.ue()?; // scaling_list_pred_matrix_id_delta
                continue;
            }
            let coefficients = 64.min(1 << (4 + (size << 1)));
            if size > 1 {
                bits.se()?; // scaling_list_dc_coef_minus8
            }
            for _ in 0..coefficients {
                bits.se()?; // scaling_list_delta_coef
            }
        }
    }
    Some(())
}

/// 7.3.7 for every set the SPS declares. A set predicted from the one before it reads one flag per
/// picture that set refers to, so each set's count is carried into the next.
fn short_term_ref_pic_sets(bits: &mut Bits<'_>) -> Option<()> {
    let sets = bits.ue()?;
    let mut previous = 0u32;
    for index in 0..sets {
        let predicted = index != 0 && bits.flag()?;
        previous = if predicted {
            bits.skip(1)?; // delta_rps_sign
            bits.ue()?; // abs_delta_rps_minus1
            let mut count = 0;
            for _ in 0..=previous {
                let used = bits.flag()?;
                if used || bits.flag()? {
                    count += 1;
                }
            }
            count
        } else {
            let pictures = bits.ue()?.checked_add(bits.ue()?)?; // num_negative_pics, num_positive_pics
            for _ in 0..pictures {
                bits.ue()?; // delta_poc_minus1
                bits.skip(1)?; // used_by_curr_pic_flag
            }
            pictures
        };
    }
    Some(())
}

struct Bits<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Bits<'a> {
    fn new(bytes: &'a [u8]) -> Bits<'a> {
        Bits { bytes, at: 0 }
    }

    fn bit(&mut self) -> Option<u32> {
        let byte = *self.bytes.get(self.at / 8)?;
        let bit = (byte >> (7 - self.at % 8)) & 1;
        self.at += 1;
        Some(u32::from(bit))
    }

    fn flag(&mut self) -> Option<bool> {
        Some(self.bit()? == 1)
    }

    fn read(&mut self, count: usize) -> Option<u32> {
        (0..count).try_fold(0u32, |value, _| Some((value << 1) | self.bit()?))
    }

    fn byte(&mut self) -> Option<u16> {
        u16::try_from(self.read(8)?).ok()
    }

    fn skip(&mut self, count: usize) -> Option<()> {
        let end = self.at.checked_add(count)?;
        (end <= self.bytes.len() * 8).then(|| self.at = end)
    }

    /// Exp-Golomb, unsigned. Past 31 leading zeros no `u32` holds the value, so the stream is
    /// declined rather than wrapped.
    fn ue(&mut self) -> Option<u32> {
        let mut zeros = 0;
        while self.bit()? == 0 {
            zeros += 1;
            if zeros > 31 {
                return None;
            }
        }
        Some((1u32 << zeros) - 1 + self.read(zeros)?)
    }

    fn se(&mut self) -> Option<i64> {
        let code = i64::from(self.ue()?);
        Some(if code % 2 == 1 {
            (code + 1) / 2
        } else {
            -code / 2
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A Galaxy's HEIC `hvcC`: its VPS, SPS and PPS, emulation prevention bytes and all.
    const GALAXY_HVCC: &[u8] = &[
        0x01, 0x03, 0x10, 0x00, 0x00, 0x00, 0xb0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x96, 0xf0, 0x00,
        0xfc, 0xfd, 0xf8, 0xf8, 0x00, 0x00, 0x03, 0x03, 0x20, 0x00, 0x01, 0x00, 0x17, 0x40, 0x01,
        0x0c, 0x01, 0xff, 0xff, 0x03, 0x10, 0x00, 0x00, 0x03, 0x00, 0xb0, 0x00, 0x00, 0x03, 0x00,
        0x00, 0x03, 0x00, 0x96, 0xf0, 0x24, 0x21, 0x00, 0x01, 0x00, 0x24, 0x42, 0x01, 0x01, 0x03,
        0x10, 0x00, 0x00, 0x03, 0x00, 0xb0, 0x00, 0x00, 0x03, 0x00, 0x00, 0x03, 0x00, 0x96, 0xa0,
        0x04, 0x02, 0x00, 0x80, 0x59, 0x7e, 0xe4, 0xc9, 0x6a, 0x6e, 0x0a, 0x0c, 0x0a, 0x05, 0xda,
        0x14, 0x25, 0x22, 0x00, 0x01, 0x00, 0x08, 0x44, 0x01, 0xc1, 0xe3, 0x0f, 0x03, 0xb0, 0x84,
    ];

    /// What ffprobe reports for the same file: `yuvj420p(pc, bt470bg/bt470bg/smpte170m)`.
    #[test]
    fn a_galaxys_bitstream_states_full_range_bt601() {
        let signal = of_hvcc(GALAXY_HVCC).expect("a video signal type");
        assert!(signal.full_range);
        assert_eq!(
            (signal.primaries, signal.transfer, signal.matrix),
            (5, 6, 5)
        );
    }

    #[test]
    fn a_containers_own_signal_wins_over_the_bitstreams() {
        let stated = Nclx {
            primaries: 1,
            transfer: 13,
            matrix: 1,
            full_range: false,
        };
        let picture = crate::Picture {
            codec: crate::Codec::Hevc,
            width: 1,
            height: 1,
            depth: 8,
            config: GALAXY_HVCC.to_vec(),
            tiles: Vec::new(),
            grid: (1, 1),
            tile: (1, 1),
            nclx: Some(stated),
            icc: None,
            turn: crate::Orientation::Normal,
            unhandled: None,
        };
        assert_eq!(crate::signal_of(&picture), Some(stated));
        let bare = crate::Picture {
            nclx: None,
            ..picture
        };
        assert_eq!(crate::signal_of(&bare).map(|it| it.matrix), Some(5));
        let av1 = crate::Picture {
            codec: crate::Codec::Av1,
            ..bare
        };
        assert_eq!(crate::signal_of(&av1), None);
    }

    #[test]
    fn a_record_with_no_sps_states_nothing() {
        // The Galaxy record's VPS and PPS arrays, its SPS array left out.
        let mut record = GALAXY_HVCC[..22].to_vec();
        record.push(2);
        record.extend_from_slice(&GALAXY_HVCC[23..51]);
        record.extend_from_slice(&GALAXY_HVCC[92..]);
        assert!(sps_payload(&record).is_none());
        assert!(of_hvcc(&record).is_none());
        assert!(of_hvcc(&[]).is_none());
    }

    #[test]
    fn the_start_code_escape_is_removed_only_after_two_zeros() {
        assert_eq!(
            unescaped(&[0, 0, 3, 1, 0, 3, 0, 0, 3]),
            vec![0, 0, 1, 0, 3, 0, 0]
        );
    }

    #[test]
    fn exp_golomb_reads_the_codes_the_standard_tabulates() {
        // 1, 010, 011, 00100: 0, 1, 2, 3.
        let mut bits = Bits::new(&[0b1010_0110, 0b0100_0000]);
        assert_eq!(
            (bits.ue(), bits.ue(), bits.ue(), bits.ue()),
            (Some(0), Some(1), Some(2), Some(3))
        );
    }
}
