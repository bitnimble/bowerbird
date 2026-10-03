//! PWG 5100.7 for `media-col`, 5100.12 for IPP Everywhere's raster types.

use super::{JobState, JobStatus, Margins, Media, MediaType, Space, Transport};
use ipp::value::IppValue;
use std::collections::{BTreeMap, HashMap};

pub type Attributes = HashMap<String, IppValue>;

/// How far apart, in hundredths of a millimetre, two sizes may be and still be one size: a PPD
/// states sizes in points, so its A4 is 209.90 x 297.04.
const SAME_SIZE: i32 = 50;
const HUNDREDTHS_PER_INCH: f64 = 2540.0;

pub fn from_group(group: &ipp::attribute::IppAttributeGroup) -> Attributes {
    group
        .attributes()
        .iter()
        .map(|attribute| (attribute.name().to_string(), attribute.value().clone()))
        .collect()
}

pub fn values<'a>(attributes: &'a Attributes, name: &str) -> &'a [IppValue] {
    match attributes.get(name) {
        Some(IppValue::Array(values)) => values,
        Some(value) => std::slice::from_ref(value),
        None => &[],
    }
}

pub fn strings<'a>(attributes: &'a Attributes, name: &str) -> Vec<&'a str> {
    values(attributes, name).iter().filter_map(text).collect()
}

pub fn string<'a>(attributes: &'a Attributes, name: &str) -> Option<&'a str> {
    values(attributes, name).first().and_then(text)
}

pub fn integer(attributes: &Attributes, name: &str) -> Option<i32> {
    match values(attributes, name).first()? {
        IppValue::Integer(value) | IppValue::Enum(value) => Some(*value),
        _ => None,
    }
}

fn text(value: &IppValue) -> Option<&str> {
    match value {
        IppValue::Keyword(text)
        | IppValue::NameWithoutLanguage(text)
        | IppValue::MimeMediaType(text)
        | IppValue::NameWithLanguage { name: text, .. } => Some(text.as_str()),
        IppValue::Uri(text) | IppValue::UriScheme(text) => Some(text.as_str()),
        IppValue::TextWithoutLanguage(text) | IppValue::TextWithLanguage { text, .. } => {
            Some(text.as_ref())
        }
        _ => None,
    }
}

type Collection = BTreeMap<ipp::value::IppName, IppValue>;

fn member<'a>(collection: &'a Collection, name: &str) -> Option<&'a IppValue> {
    collection.get(name)
}

fn member_integer(collection: &Collection, name: &str) -> Option<i32> {
    match member(collection, name)? {
        IppValue::Integer(value) => Some(*value),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct MediaSize {
    pub key: String,
    pub width: i32,
    pub height: i32,
    /// Top, right, bottom, left: the smallest the printer allows short of borderless.
    pub margins: [i32; 4],
    pub borderless: bool,
}

impl MediaSize {
    pub fn media(&self) -> Media {
        let (width, height) = pwg_dimensions(&self.key).unwrap_or((self.width, self.height));
        let mm = |hundredths: i32| hundredths as f64 / 100.0;
        Media {
            key: self.key.clone(),
            name: None,
            width_mm: mm(width),
            height_mm: mm(height),
            margins: Margins {
                top: mm(self.margins[0]),
                right: mm(self.margins[1]),
                bottom: mm(self.margins[2]),
                left: mm(self.margins[3]),
            },
            borderless: self.borderless,
        }
    }

    fn holds(&self, width: i32, height: i32) -> bool {
        (self.width - width).abs() <= SAME_SIZE && (self.height - height).abs() <= SAME_SIZE
    }
}

struct Entry {
    width: i32,
    height: i32,
    margins: [i32; 4],
    name: Option<String>,
}

pub fn media_sizes(attributes: &Attributes) -> Vec<MediaSize> {
    let named: Vec<(&str, (i32, i32))> = strings(attributes, "media-supported")
        .into_iter()
        .filter_map(|name| Some((name, pwg_dimensions(name)?)))
        .collect();
    let mut entries: Vec<Entry> = values(attributes, "media-col-database")
        .iter()
        .filter_map(|value| entry(value.as_collection()?))
        .collect();
    if entries.is_empty() {
        entries = supported_entries(attributes, &named);
    }

    let mut sizes: Vec<(MediaSize, Option<String>)> = Vec::new();
    for entry in entries {
        let borderless = entry.margins == [0; 4];
        let index = match sizes
            .iter()
            .position(|(size, _)| size.holds(entry.width, entry.height))
        {
            Some(index) => index,
            None => {
                sizes.push((
                    MediaSize {
                        key: String::new(),
                        width: entry.width,
                        height: entry.height,
                        margins: entry.margins,
                        borderless,
                    },
                    None,
                ));
                sizes.len() - 1
            }
        };
        let (size, name) = &mut sizes[index];
        if borderless {
            size.borderless = true;
        } else if size.margins == [0; 4] {
            size.margins = entry.margins;
        } else {
            for (kept, offered) in size.margins.iter_mut().zip(entry.margins) {
                *kept = (*kept).min(offered);
            }
        }
        if let Some(offered) = entry.name
            && name
                .as_deref()
                .is_none_or(|held| says_borderless(held) && !says_borderless(&offered))
        {
            *name = Some(offered);
        }
    }

    sizes
        .into_iter()
        .map(|(mut size, name)| {
            let listed = |borderless_name: bool| {
                named
                    .iter()
                    .find(|(listed, (width, height))| {
                        says_borderless(listed) == borderless_name && size.holds(*width, *height)
                    })
                    .map(|(listed, _)| listed.to_string())
            };
            size.key = name
                .filter(|name| !says_borderless(name))
                .or_else(|| listed(false))
                .or_else(|| listed(true))
                .unwrap_or_else(|| custom_name(size.width, size.height));
            size
        })
        .collect()
}

fn entry(collection: &Collection) -> Option<Entry> {
    let size = member(collection, "media-size")?.as_collection()?;
    let margin =
        |edge: &str| member_integer(collection, &format!("media-{edge}-margin")).unwrap_or(0);
    Some(Entry {
        width: member_integer(size, "x-dimension")?,
        height: member_integer(size, "y-dimension")?,
        margins: [
            margin("top"),
            margin("right"),
            margin("bottom"),
            margin("left"),
        ],
        name: member(collection, "media-size-name")
            .and_then(text)
            .map(str::to_string),
    })
}

fn supported_entries(attributes: &Attributes, named: &[(&str, (i32, i32))]) -> Vec<Entry> {
    let supported = |edge: &str| -> Vec<i32> {
        values(attributes, &format!("media-{edge}-margin-supported"))
            .iter()
            .filter_map(|value| value.as_integer().copied())
            .collect()
    };
    let edges = ["top", "right", "bottom", "left"].map(supported);
    let bordered = edges.clone().map(|offered| {
        offered
            .into_iter()
            .filter(|&margin| margin > 0)
            .min()
            .unwrap_or(0)
    });
    let zero_everywhere = edges.iter().all(|offered| offered.contains(&0));
    named
        .iter()
        .flat_map(|&(name, (width, height))| {
            let entry = |margins| Entry {
                width,
                height,
                margins,
                name: Some(name.to_string()),
            };
            let mut entries = vec![entry(if says_borderless(name) {
                [0; 4]
            } else {
                bordered
            })];
            if zero_everywhere && !says_borderless(name) {
                entries.push(entry([0; 4]));
            }
            entries
        })
        .collect()
}

fn says_borderless(name: &str) -> bool {
    name.contains("borderless")
}

pub fn pwg_dimensions(name: &str) -> Option<(i32, i32)> {
    let size = name.rsplit('_').next()?;
    let (numbers, scale) = if let Some(numbers) = size.strip_suffix("mm") {
        (numbers, 100.0)
    } else {
        (size.strip_suffix("in")?, HUNDREDTHS_PER_INCH)
    };
    let (width, height) = numbers.split_once('x')?;
    let hundredths = |number: &str| -> Option<i32> {
        Some((number.parse::<f64>().ok()? * scale).round() as i32)
    };
    Some((hundredths(width)?, hundredths(height)?))
}

fn custom_name(width: i32, height: i32) -> String {
    let mm = |hundredths: i32| {
        let text = format!("{:.2}", hundredths as f64 / 100.0);
        text.trim_end_matches('0').trim_end_matches('.').to_string()
    };
    format!("custom_{}x{}mm", mm(width), mm(height))
}

pub fn default_media(attributes: &Attributes, sizes: &[MediaSize]) -> Option<String> {
    let from_collection = values(attributes, "media-col-default")
        .first()
        .and_then(IppValue::as_collection)
        .and_then(|collection| entry(collection))
        .map(|entry| (entry.width, entry.height));
    let dimensions =
        from_collection.or_else(|| pwg_dimensions(string(attributes, "media-default")?))?;
    sizes
        .iter()
        .find(|size| size.holds(dimensions.0, dimensions.1))
        .map(|size| size.key.clone())
}

pub fn media_types(attributes: &Attributes) -> Vec<MediaType> {
    strings(attributes, "media-type-supported")
        .into_iter()
        .map(|key| MediaType {
            key: key.to_string(),
            name: None,
        })
        .collect()
}

pub fn default_media_type(attributes: &Attributes) -> Option<String> {
    let collection = values(attributes, "media-col-default")
        .first()?
        .as_collection()?;
    member(collection, "media-type")
        .and_then(text)
        .map(str::to_string)
}

pub fn resolutions(attributes: &Attributes, name: &str) -> Vec<u32> {
    let mut dpi: Vec<u32> = values(attributes, name)
        .iter()
        .filter_map(|value| match *value {
            IppValue::Resolution {
                cross_feed,
                feed,
                units,
            } if cross_feed == feed && cross_feed > 0 => match units {
                3 => Some(cross_feed as u32),
                4 => Some((cross_feed as f64 * 2.54).round() as u32),
                _ => None,
            },
            _ => None,
        })
        .collect();
    dpi.sort_unstable();
    dpi.dedup();
    dpi
}

pub fn copies_max(attributes: &Attributes) -> u32 {
    match values(attributes, "copies-supported").first() {
        Some(IppValue::RangeOfInteger { max, .. }) if *max > 0 => *max as u32,
        _ => 1,
    }
}

pub fn raster_transports(attributes: &Attributes) -> Vec<Transport> {
    super::best_first(
        strings(attributes, "pwg-raster-document-type-supported")
            .into_iter()
            .filter_map(raster_transport)
            .collect(),
    )
}

fn raster_transport(keyword: &str) -> Option<Transport> {
    let (space, bits) = keyword.rsplit_once('_')?;
    let space = match space {
        "rgb" => Space::Device,
        "srgb" => Space::Srgb,
        "adobe-rgb" => Space::AdobeRgb,
        _ => return None,
    };
    let bits = match bits {
        "8" => 8,
        "16" => 16,
        _ => return None,
    };
    Some(Transport { space, bits })
}

pub fn raster_keyword(transport: Transport) -> String {
    let space = match transport.space {
        Space::Device => "rgb",
        Space::Srgb => "srgb",
        Space::AdobeRgb => "adobe-rgb",
    };
    format!("{space}_{}", transport.bits)
}

pub fn icc_profiles(attributes: &Attributes) -> Vec<(String, String)> {
    values(attributes, "printer-icc-profiles")
        .iter()
        .filter_map(|value| {
            let collection = value.as_collection()?;
            Some((
                member(collection, "profile-name")
                    .and_then(text)?
                    .to_string(),
                member(collection, "profile-url")
                    .and_then(text)?
                    .to_string(),
            ))
        })
        .collect()
}

pub fn job_status(attributes: &Attributes) -> Option<JobStatus> {
    let state = match integer(attributes, "job-state")? {
        3 => JobState::Pending,
        4 => JobState::Held,
        5 => JobState::Processing,
        6 => JobState::Stopped,
        7 => JobState::Canceled,
        8 => JobState::Aborted,
        9 => JobState::Completed,
        _ => return None,
    };
    let reasons = strings(attributes, "job-state-reasons")
        .into_iter()
        .filter(|reason| *reason != "none")
        .map(str::to_string)
        .collect();
    Some(JobStatus { state, reasons })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn keyword(value: &str) -> IppValue {
        IppValue::Keyword(value.try_into().unwrap())
    }

    fn collection(members: Vec<(&str, IppValue)>) -> IppValue {
        IppValue::Collection(
            members
                .into_iter()
                .map(|(name, value)| (name.try_into().unwrap(), value))
                .collect(),
        )
    }

    fn media_col(
        width: i32,
        height: i32,
        margins: [i32; 4],
        extra: Vec<(&str, IppValue)>,
    ) -> IppValue {
        let mut members = vec![
            (
                "media-size",
                collection(vec![
                    ("x-dimension", IppValue::Integer(width)),
                    ("y-dimension", IppValue::Integer(height)),
                ]),
            ),
            ("media-top-margin", IppValue::Integer(margins[0])),
            ("media-right-margin", IppValue::Integer(margins[1])),
            ("media-bottom-margin", IppValue::Integer(margins[2])),
            ("media-left-margin", IppValue::Integer(margins[3])),
        ];
        members.extend(extra);
        collection(members)
    }

    fn attributes(pairs: Vec<(&str, IppValue)>) -> Attributes {
        pairs
            .into_iter()
            .map(|(name, value)| (name.to_string(), value))
            .collect()
    }

    /// What the sandbox's IPP Everywhere printer answers, less what printshim does not read.
    pub(crate) fn photo_printer() -> Attributes {
        attributes(vec![
            (
                "media-supported",
                IppValue::Array(vec![
                    keyword("na_index-4x6_4x6in"),
                    keyword("om_a-4-borderless_210x297mm"),
                    keyword("iso_a4_210x297mm"),
                ]),
            ),
            (
                "media-col-database",
                IppValue::Array(vec![
                    media_col(21000, 29700, [0; 4], vec![]),
                    media_col(21000, 29700, [300, 300, 500, 300], vec![]),
                    media_col(21000, 29700, [500, 200, 500, 400], vec![]),
                    media_col(10160, 15240, [0; 4], vec![]),
                    media_col(5000, 8000, [100; 4], vec![]),
                ]),
            ),
            (
                "media-col-default",
                media_col(
                    21000,
                    29700,
                    [300, 300, 500, 300],
                    vec![("media-type", keyword("photographic-glossy"))],
                ),
            ),
            (
                "media-type-supported",
                IppValue::Array(vec![keyword("photographic-glossy"), keyword("stationery")]),
            ),
            (
                "pwg-raster-document-type-supported",
                IppValue::Array(
                    [
                        "sgray_8",
                        "srgb_8",
                        "adobe-rgb_16",
                        "rgb_16",
                        "black_1",
                        "rgb_8",
                    ]
                    .map(keyword)
                    .to_vec(),
                ),
            ),
            (
                "pwg-raster-document-resolution-supported",
                IppValue::Array(vec![
                    IppValue::Resolution {
                        cross_feed: 600,
                        feed: 600,
                        units: 3,
                    },
                    IppValue::Resolution {
                        cross_feed: 300,
                        feed: 300,
                        units: 3,
                    },
                    IppValue::Resolution {
                        cross_feed: 600,
                        feed: 1200,
                        units: 3,
                    },
                    IppValue::Resolution {
                        cross_feed: 236,
                        feed: 236,
                        units: 4,
                    },
                ]),
            ),
            (
                "copies-supported",
                IppValue::RangeOfInteger { min: 1, max: 99 },
            ),
            (
                "printer-icc-profiles",
                collection(vec![
                    (
                        "profile-name",
                        IppValue::NameWithoutLanguage("Glossy".try_into().unwrap()),
                    ),
                    (
                        "profile-url",
                        IppValue::Uri("http://printer.local/glossy.icc".try_into().unwrap()),
                    ),
                ]),
            ),
        ])
    }

    #[test]
    fn media_is_one_entry_a_size_with_the_smallest_bordered_margins() {
        let printer = photo_printer();
        let sizes = media_sizes(&printer);
        assert_eq!(
            sizes,
            vec![
                MediaSize {
                    key: "iso_a4_210x297mm".into(),
                    width: 21000,
                    height: 29700,
                    margins: [300, 200, 500, 300],
                    borderless: true,
                },
                MediaSize {
                    key: "na_index-4x6_4x6in".into(),
                    width: 10160,
                    height: 15240,
                    margins: [0; 4],
                    borderless: true,
                },
                MediaSize {
                    key: "custom_50x80mm".into(),
                    width: 5000,
                    height: 8000,
                    margins: [100; 4],
                    borderless: false,
                },
            ]
        );
        let a4 = sizes[0].media();
        assert_eq!((a4.width_mm, a4.height_mm), (210.0, 297.0));
        assert_eq!(a4.margins.right, 2.0);
        assert_eq!(
            default_media(&printer, &sizes).as_deref(),
            Some("iso_a4_210x297mm")
        );
        assert_eq!(
            default_media_type(&printer).as_deref(),
            Some("photographic-glossy")
        );
    }

    #[test]
    fn a_ppds_rounded_size_takes_the_pwg_name_beside_it() {
        let queue = attributes(vec![
            (
                "media-supported",
                IppValue::Array(vec![keyword("iso_a4_210x297mm")]),
            ),
            (
                "media-col-database",
                media_col(20990, 29704, [300; 4], vec![]),
            ),
        ]);
        let sizes = media_sizes(&queue);
        assert_eq!(sizes[0].key, "iso_a4_210x297mm");
        assert_eq!((sizes[0].width, sizes[0].height), (20990, 29704));
        assert_eq!(sizes[0].media().width_mm, 210.0);
        assert!(!sizes[0].borderless);
    }

    #[test]
    fn without_a_database_sizes_come_from_media_supported_and_the_margin_lists() {
        let printer = attributes(vec![
            (
                "media-supported",
                IppValue::Array(vec![
                    keyword("na_letter_8.5x11in"),
                    keyword("iso_a6_105x148mm"),
                ]),
            ),
            (
                "media-top-margin-supported",
                IppValue::Array(vec![IppValue::Integer(0), IppValue::Integer(423)]),
            ),
            (
                "media-right-margin-supported",
                IppValue::Array(vec![IppValue::Integer(0), IppValue::Integer(318)]),
            ),
            (
                "media-bottom-margin-supported",
                IppValue::Array(vec![IppValue::Integer(0), IppValue::Integer(423)]),
            ),
            ("media-left-margin-supported", IppValue::Integer(318)),
        ]);
        let sizes = media_sizes(&printer);
        assert_eq!(sizes.len(), 2);
        assert_eq!(
            (sizes[0].key.as_str(), sizes[0].width, sizes[0].height),
            ("na_letter_8.5x11in", 21590, 27940)
        );
        assert_eq!(sizes[0].margins, [423, 318, 423, 318]);
        assert!(!sizes[0].borderless, "the left edge never goes to zero");
    }

    #[test]
    fn transports_resolutions_copies_and_profiles() {
        let printer = photo_printer();
        let t = |space, bits| Transport { space, bits };
        assert_eq!(
            raster_transports(&printer),
            vec![
                t(Space::Device, 16),
                t(Space::Device, 8),
                t(Space::AdobeRgb, 16),
                t(Space::Srgb, 8)
            ]
        );
        assert_eq!(raster_keyword(t(Space::AdobeRgb, 16)), "adobe-rgb_16");
        assert_eq!(
            resolutions(&printer, "pwg-raster-document-resolution-supported"),
            vec![300, 599, 600]
        );
        assert_eq!(copies_max(&printer), 99);
        assert_eq!(
            icc_profiles(&printer),
            vec![(
                "Glossy".to_string(),
                "http://printer.local/glossy.icc".to_string()
            )]
        );
        assert_eq!(pwg_dimensions("oe_photo-l_3.5x5in"), Some((8890, 12700)));
        assert_eq!(pwg_dimensions("stationery"), None);
    }

    #[test]
    fn job_state_reads_the_enum_and_drops_none() {
        let job = attributes(vec![
            ("job-state", IppValue::Enum(6)),
            (
                "job-state-reasons",
                IppValue::Array(vec![keyword("media-empty"), keyword("job-printing")]),
            ),
        ]);
        assert_eq!(
            job_status(&job),
            Some(JobStatus {
                state: JobState::Stopped,
                reasons: vec!["media-empty".into(), "job-printing".into()]
            })
        );
        let done = attributes(vec![
            ("job-state", IppValue::Enum(9)),
            ("job-state-reasons", keyword("none")),
        ]);
        assert_eq!(job_status(&done).unwrap().reasons, Vec::<String>::new());
    }
}
