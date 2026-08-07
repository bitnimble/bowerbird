import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { BANDS, XmpSettingsSchema, type Issue, type XmpDate, type XmpSettings } from './xmp_schema';

// Camera Raw's develop settings, read out of an XMP packet: a sidecar next to a
// raw, or the packet embedded in a DNG or a JPEG. All three carry the same
// document, which is why this takes a string rather than a path.
//
// It never throws and returns null only for input that is not XMP at all: this
// sits on the library scan, where one unreadable file must not fail the scan,
// the same reason exif_zone.ts returns null.

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const XML = 'http://www.w3.org/XML/1998/namespace';

// Properties are bound by namespace URI, never by prefix: a file may declare the
// crs namespace as `foo:` and write `foo:Exposure2012`, and that is the same
// property. The canonical prefix is what a name is reported as, so `crs:Contrast`
// in an issue means the property in the crs URI however the file spelled it.
// Keys have any trailing `/` stripped, because some writers emit the crs URI
// without one.
const CANONICAL_PREFIX: Record<string, string> = {
  [RDF]: 'rdf',
  [XML]: 'xml',
  'adobe:ns:meta': 'x',
  'http://ns.adobe.com/camera-raw-settings/1.0': 'crs',
  'http://ns.adobe.com/xap/1.0': 'xmp',
  'http://purl.org/dc/elements/1.1': 'dc',
  'http://ns.adobe.com/tiff/1.0': 'tiff',
  'http://ns.adobe.com/exif/1.0': 'exif',
  'http://ns.adobe.com/photoshop/1.0': 'photoshop',
  'http://ns.adobe.com/lightroom/1.0': 'lr',
};

// Shipped as tabulated but never confirmed against a corpus of real sidecars,
// and still to be: the temperature and tint ranges, the luminance noise
// reduction detail default, every defringe hue bound, both vignette midpoints,
// the grain size, frequency and seed, the crop angle range, the crop unit
// codes, the perspective rotate range, and the Look field list, which is
// unlikely to be exhaustive. A wrong one here is a plausible value applied
// silently, so each is worth re-checking before anything leans on it.
//
// Not answerable here at all: which frame §6.2's crop coordinates sit in, and
// the sign and centre of the straighten rotation. Confirming those means
// applying the transform and looking at the result, so it is carried forward to
// whatever renders the geometry rather than treated as settled.

const ANY = Number.POSITIVE_INFINITY;
const CURVE_MAX = 255;

const WHITE_BALANCES = ['As Shot', 'Auto', 'Daylight', 'Cloudy', 'Shade', 'Tungsten', 'Fluorescent', 'Flash', 'Custom'];
const TONE_CURVE_NAMES = ['Linear', 'Medium Contrast', 'Strong Contrast', 'Custom'];
const LENS_PROFILE_SETUPS = ['LensDefaults', 'Auto', 'Custom'];

// preserveOrder keeps every element as its own node, which is what makes the
// namespace walk below possible: the merged form collapses repeated elements
// and drops the document order two `rdf:Description` blocks are merged in.
// Values are left as strings - a blanket numeric coercion turns
// `crs:WhiteBalance="Auto"` into NaN and `crs:CameraProfile="2"` into a number -
// and coerced per tag against the type each one is documented with.
const PARSER = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  ignoreDeclaration: true,
  ignorePiTags: true,
});

type Attrs = Record<string, string>;
type XmlNode = Record<string, XmlNode[] | Attrs | string>;
type NsMap = Readonly<Record<string, string>>;

interface Element {
  node: XmlNode;
  ns: NsMap;
  name: string | null;
}

const ATTRS = ':@';
const TEXT = '#text';

function tagOf(node: XmlNode): string {
  for (const key of Object.keys(node)) {
    if (key !== ATTRS) return key;
  }
  return '';
}

function childrenOf(node: XmlNode): XmlNode[] {
  const value = node[tagOf(node)];
  return Array.isArray(value) ? value : [];
}

function attrsOf(node: XmlNode): Attrs {
  const value = node[ATTRS];
  return value != null && !Array.isArray(value) && typeof value !== 'string' ? value : {};
}

function textOf(node: XmlNode): string {
  let out = '';
  for (const child of childrenOf(node)) {
    const value = child[TEXT];
    if (typeof value === 'string') out += value;
  }
  return out.trim();
}

function normaliseUri(uri: string): string {
  return uri.endsWith('/') ? uri.slice(0, -1) : uri;
}

function qualify(name: string, ns: NsMap, isAttribute: boolean): string | null {
  const colon = name.indexOf(':');
  // An unprefixed attribute is in no namespace at all, unlike an unprefixed
  // element, which takes the default one.
  if (colon < 0) return isAttribute ? null : qualified(ns[''] ?? '', name);
  const uri = ns[name.slice(0, colon)];
  return uri == null ? null : qualified(uri, name.slice(colon + 1));
}

function qualified(uri: string, local: string): string {
  if (uri === '') return local;
  const prefix = CANONICAL_PREFIX[uri];
  return prefix == null ? `{${uri}}${local}` : `${prefix}:${local}`;
}

// Declarations are commonly written on `rdf:Description` rather than the root,
// so every element inherits its ancestors' and may add its own.
function withNamespaces(ns: NsMap, attrs: Attrs): NsMap {
  let extended: Record<string, string> | null = null;
  for (const [name, value] of Object.entries(attrs)) {
    if (!isNamespaceDeclaration(name)) continue;
    extended ??= { ...ns };
    extended[name === '@_xmlns' ? '' : name.slice('@_xmlns:'.length)] = normaliseUri(String(value));
  }
  return extended ?? ns;
}

function isNamespaceDeclaration(name: string): boolean {
  return name === '@_xmlns' || name.startsWith('@_xmlns:');
}

function elements(children: XmlNode[], ns: NsMap): Element[] {
  const out: Element[] = [];
  for (const node of children) {
    const tag = tagOf(node);
    if (tag === TEXT || tag === '') continue;
    const inner = withNamespaces(ns, attrsOf(node));
    out.push({ node, ns: inner, name: qualify(tag, inner, false) });
  }
  return out;
}

function attributes(node: XmlNode, ns: NsMap): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, value] of Object.entries(attrsOf(node))) {
    if (isNamespaceDeclaration(name)) continue;
    const qualifiedName = qualify(name.slice('@_'.length), ns, true);
    if (qualifiedName != null) out.set(qualifiedName, String(value));
  }
  return out;
}

// Either serialisation of a scalar: an attribute on `rdf:Description`, or an
// element with the value as its text. Both forms turn up in real libraries, so a
// property is held as whichever it was written as and read the same way.
type Prop = { text: string } | { node: XmlNode; ns: NsMap };

interface Item {
  text: string;
  lang: string | null;
}

function rawText(prop: Prop): string {
  return 'text' in prop ? prop.text : textOf(prop.node);
}

function identityCurve(): { x: number; y: number }[] {
  return [{ x: 0, y: 0 }, { x: CURVE_MAX, y: CURVE_MAX }];
}

/**
 * One merged property set - every `rdf:Description` in the document, and the
 * fields of one structure - read by tag with the type, range and default each
 * tag is documented with. Out-of-range clamps, unparseable falls back to the
 * default, and either records an issue; nothing here rejects a file.
 *
 * Reading a tag also marks it consumed, which is what `unsupported()` inverts:
 * anything in the crs namespace nobody asked for is a feature this parser does
 * not support, without a list of them to keep in step.
 */
class Properties {
  private readonly props = new Map<string, Prop>();
  private readonly consumed = new Set<string>();

  constructor(
    private readonly issues: Issue[],
    private readonly prefix = '',
  ) {}

  collect(node: XmlNode, ns: NsMap): void {
    for (const [name, value] of attributes(node, ns)) {
      // rdf:about, rdf:parseType, xml:lang: the serialisation, not properties.
      if (name.startsWith('rdf:') || name.startsWith('xml:')) continue;
      this.add(name, { text: value.trim() });
    }
    for (const element of elements(childrenOf(node), ns)) {
      if (element.name == null || element.name.startsWith('rdf:')) continue;
      this.add(element.name, { node: element.node, ns: element.ns });
    }
  }

  record(tag: string, reason: Issue['reason'], value: string): void {
    this.issues.push({ tag: this.prefix + tag, reason, value });
  }

  /** The value as the file wrote it, without consuming the tag. */
  verbatim(tag: string): string {
    const prop = this.props.get(tag);
    return prop == null ? '' : rawText(prop);
  }

  text(tag: string): string | null {
    const prop = this.take(tag);
    if (prop == null) return null;
    const text = rawText(prop);
    return text === '' ? null : text;
  }

  /**
   * Open enums: an unrecognised value is kept verbatim rather than coerced,
   * because user preset names are legal in several of them.
   */
  enumeration(tag: string, known: readonly string[], fallback: string): string {
    const value = this.text(tag);
    if (value == null) return fallback;
    if (!known.includes(value)) this.record(tag, 'unconvertible', value);
    return value;
  }

  int(tag: string, min: number, max: number, fallback: number): number {
    return this.number(tag, min, max, true) ?? fallback;
  }

  intOrNull(tag: string, min: number, max: number): number | null {
    return this.number(tag, min, max, true);
  }

  real(tag: string, min: number, max: number, fallback: number): number {
    return this.number(tag, min, max, false) ?? fallback;
  }

  realOrNull(tag: string, min: number, max: number): number | null {
    return this.number(tag, min, max, false);
  }

  flag(tag: string, fallback: boolean): boolean {
    return this.flagOrNull(tag) ?? fallback;
  }

  /** `"True"`/`"False"` in any case, or the integer forms several tags use. */
  flagOrNull(tag: string): boolean | null {
    const value = this.text(tag);
    if (value == null) return null;
    const lower = value.toLowerCase();
    if (lower === 'true' || lower === '1') return true;
    if (lower === 'false' || lower === '0') return false;
    this.record(tag, 'unparseable', value);
    return null;
  }

  strings(tag: string): string[] {
    return (this.items(tag) ?? []).map((item) => item.text).filter((text) => text !== '');
  }

  /** The `x-default` alternative, or the first one when none is marked. */
  langAlt(tag: string): string | null {
    const items = this.items(tag);
    if (items == null || items.length === 0) return null;
    const chosen = items.find((item) => item.lang === 'x-default') ?? items[0]!;
    return chosen.text === '' ? null : chosen.text;
  }

  /**
   * A tone curve as points. Parsed numerically rather than compared as strings,
   * so `"0, 0"`, `"0,0"` and an absent tag all produce the same identity curve.
   */
  curve(tag: string): { x: number; y: number }[] {
    const items = this.items(tag);
    if (items == null) return identityCurve();
    const points: { x: number; y: number }[] = [];
    for (const item of items) {
      // Both halves have to be there: Number('') is 0, so an unguarded `"0,"`
      // would read as a point rather than as the malformed value it is.
      const parts = item.text.split(',').map((part) => part.trim());
      const x = Number(parts[0]);
      const y = Number(parts[1]);
      if (parts.length !== 2 || parts.some((part) => part === '') || !Number.isFinite(x) || !Number.isFinite(y)) {
        this.record(tag, 'malformed', item.text);
        continue;
      }
      const point = { x: clamp(Math.round(x), 0, CURVE_MAX), y: clamp(Math.round(y), 0, CURVE_MAX) };
      if (point.x !== Math.round(x) || point.y !== Math.round(y)) this.record(tag, 'clamped', item.text);
      points.push(point);
    }
    return points.length >= 2 ? points : identityCurve();
  }

  date(tag: string): XmpDate | null {
    const value = this.text(tag);
    if (value == null) return null;
    const parsed = parseDate(value);
    if (parsed == null) this.record(tag, 'unparseable', value);
    return parsed;
  }

  /** A structure in either serialisation, as its own property set. */
  struct(tag: string): Properties | null {
    const prop = this.take(tag);
    if (prop == null || 'text' in prop) return null;
    const fields = new Properties(this.issues, `${this.prefix}${tag}/`);
    if (attributes(prop.node, prop.ns).get('rdf:parseType') === 'Resource') {
      fields.collect(prop.node, prop.ns);
      return fields;
    }
    const nested = elements(childrenOf(prop.node), prop.ns).find((child) => child.name === 'rdf:Description');
    if (nested == null) return null;
    fields.collect(nested.node, nested.ns);
    return fields;
  }

  /** Every crs property present that nothing read, prefixed for nested sets. */
  unsupported(): string[] {
    return [...this.props.keys()]
      .filter((name) => name.startsWith('crs:') && !this.consumed.has(name))
      .map((name) => this.prefix + name);
  }

  private add(tag: string, prop: Prop): void {
    const existing = this.props.get(tag);
    // Last wins, whichever `rdf:Description` it came from. Structured values
    // compare by their text, which is enough to tell a genuine collision from
    // the same value written twice.
    if (existing != null && rawText(existing) !== rawText(prop)) {
      this.record(tag, 'duplicate', rawText(existing));
    }
    this.props.set(tag, prop);
  }

  private take(tag: string): Prop | null {
    this.consumed.add(tag);
    return this.props.get(tag) ?? null;
  }

  private number(tag: string, min: number, max: number, round: boolean): number | null {
    const text = this.text(tag);
    if (text == null) return null;
    const value = Number(text);
    if (!Number.isFinite(value)) {
      this.record(tag, 'unparseable', text);
      return null;
    }
    // A real in an integer-typed tag ("25.0", and occasionally "24.6") is common
    // and benign; it rounds and records nothing.
    const rounded = round ? Math.round(value) : value;
    const clamped = clamp(rounded, min, max);
    if (clamped !== rounded) this.record(tag, 'clamped', text);
    return clamped;
  }

  private items(tag: string): Item[] | null {
    const prop = this.take(tag);
    if (prop == null) return null;
    if ('text' in prop) return prop.text === '' ? [] : [{ text: prop.text, lang: null }];

    const children = elements(childrenOf(prop.node), prop.ns);
    const container = children.find((child) => child.name === 'rdf:Seq' || child.name === 'rdf:Bag' || child.name === 'rdf:Alt');
    if (container == null) {
      const text = textOf(prop.node);
      return text === '' ? [] : [{ text, lang: null }];
    }
    // Always an array, including for the single `rdf:li` a typical parser hands
    // back as a scalar: a one-keyword file must not take a different path from a
    // two-keyword one.
    return elements(childrenOf(container.node), container.ns)
      .filter((child) => child.name === 'rdf:li')
      .map((child) => ({ text: textOf(child.node), lang: attributes(child.node, child.ns).get('xml:lang') ?? null }));
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// Dotted numeric versions compare componentwise, never as strings: "15.4" is
// above "6.6" and a string compare gets that backwards. Two or more components,
// so "11" and "6.7.0.0" both parse.
const VERSION = /^\d+(\.\d+)*$/;

function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function atLeast(version: string | null, floor: string): boolean {
  const value = version?.trim() ?? '';
  return VERSION.test(value) && compareVersions(value, floor) >= 0;
}

// The `*2012` parameter set begins at process version 6.6, not at 11.0: every
// file written between 2012 and the generation-5 switch carries 6.6 or 6.7
// alongside a full set of `*2012` tags, and a gate at 11.0 would classify all of
// them as legacy and discard their tones. Later generations refine the rendering
// without renaming parameters, which is why one threshold covers them all.
function generationOf(raw: string | null): number | null {
  if (!atLeast(raw, '6.6')) return null;
  const version = raw!.trim();
  if (compareVersions(version, '15.4') >= 0) return 6;
  if (compareVersions(version, '11.0') >= 0) return 5;
  if (compareVersions(version, '10.0') >= 0) return 4;
  return 3;
}

const DATE = /^(\d{4}(?:-\d{2}(?:-\d{2})?)?(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?)(Z|[+-]\d{2}:\d{2})?$/;

function parseDate(value: string): XmpDate | null {
  const match = DATE.exec(value);
  if (match == null) return null;
  const offset = match[2] == null ? null : match[2] === 'Z' ? '+00:00' : match[2];
  return { value: match[1]!, offset };
}

function bands(read: (band: string) => number): Record<(typeof BANDS)[number], number> {
  const out = {} as Record<(typeof BANDS)[number], number>;
  for (const band of BANDS) out[band] = read(band[0]!.toUpperCase() + band.slice(1));
  return out;
}

function findRdf(children: XmlNode[], ns: NsMap, depth: number): Element | null {
  if (depth > 4) return null;
  for (const element of elements(children, ns)) {
    if (element.name === 'rdf:RDF') return element;
    const found = findRdf(childrenOf(element.node), element.ns, depth + 1);
    if (found != null) return found;
  }
  return null;
}

/**
 * @param xml an XMP packet: a sidecar's contents, or the packet lifted out of a
 * raw or a rendered file. Leading BOM and xpacket padding are tolerated.
 * @returns null when the input is not well-formed XML or carries no `rdf:RDF`.
 * Anything below that degrades: values clamp, unparseable ones fall back to
 * their defaults, and both are reported in `issues`.
 */
export function parseXmp(xml: string): XmpSettings | null {
  const issues: Issue[] = [];
  const properties = new Properties(issues);

  try {
    // A packet's `begin` attribute carries a BOM as its literal value, and the
    // string itself may start with one.
    const text = xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml;
    // Explicit, because the parser is lenient: it returns a partial tree for
    // truncated input, which reads as a file with almost every tag absent, which
    // in turn becomes a confident set of defaults. A corrupt file importing
    // silently as a neutral edit is the worst outcome available here.
    if (XMLValidator.validate(text) !== true) return null;
    const root = PARSER.parse(text) as XmlNode[];
    const rdf = findRdf(root, { xml: XML }, 0);
    if (rdf == null) return null;

    // Writers split properties across several `rdf:Description` elements grouped
    // by namespace, so all of them are merged rather than stopping at the first.
    for (const description of elements(childrenOf(rdf.node), rdf.ns)) {
      if (description.name === 'rdf:Description') properties.collect(description.node, description.ns);
    }
  } catch {
    return null;
  }

  return read(properties, issues);
}

function read(p: Properties, issues: Issue[]): XmpSettings {
  const processVersion = p.text('crs:ProcessVersion');
  const generation = generationOf(processVersion);
  const legacy = generation == null;
  const crsVersion = p.text('crs:Version');

  // On a legacy file the current-generation tags are read from an empty set, so
  // every one of them lands on its documented default rather than on a value
  // that meant something else two generations ago. Any that are present stay
  // unconsumed and are reported in `unsupported`, and vice versa for the legacy
  // tags on a current file.
  const current = legacy ? new Properties(issues) : p;

  // The one place the writer build decides how to read a value: the sharpening
  // default was raised from 25 to 40 at Camera Raw 10.3, and it is a visible
  // difference rather than a rounding one.
  const sharpnessDefault = atLeast(crsVersion, '10.3') ? 40 : 25;

  const hasCrop = p.flag('crs:HasCrop', false);
  const cropTop = p.real('crs:CropTop', 0, 1, 0);
  const cropLeft = p.real('crs:CropLeft', 0, 1, 0);
  const cropBottom = p.real('crs:CropBottom', 0, 1, 1);
  const cropRight = p.real('crs:CropRight', 0, 1, 1);
  const degenerate = cropTop >= cropBottom || cropLeft >= cropRight;
  if (hasCrop && degenerate) {
    const tag = cropTop >= cropBottom ? 'crs:CropBottom' : 'crs:CropRight';
    p.record(tag, 'malformed', p.verbatim(tag));
  }
  // `crs:HasCrop` is authoritative: stale edges from a crop the user undid are
  // routinely left behind non-default, so with no crop the edges read as the
  // whole frame rather than as whatever the file still holds.
  const cropped = hasCrop && !degenerate;
  const cropUnits = p.int('crs:CropUnits', 0, 2, 0);
  // Absolute units mean the fractions are not the whole story, and converting
  // needs frame dimensions this layer does not have.
  if (cropUnits !== 0) p.record('crs:CropUnits', 'unconvertible', p.verbatim('crs:CropUnits'));

  const lookFields = p.struct('crs:Look');

  const settings = {
    processVersion: generation == null
      ? { generation: null, raw: processVersion }
      : { generation, raw: processVersion! },
    crsVersion,
    legacy,
    hasSettings: p.flag('crs:HasSettings', false),
    alreadyApplied: p.flag('crs:AlreadyApplied', false),

    whiteBalance: {
      whiteBalance: p.enumeration('crs:WhiteBalance', WHITE_BALANCES, 'As Shot'),
      // Kept whatever the mode says, and null only on genuine absence: a named
      // preset with the pair omitted is not an error, and null is what tells the
      // mapping layer to resolve against the camera's own neutral.
      temperature: p.intOrNull('crs:Temperature', 2000, 50000),
      tint: p.intOrNull('crs:Tint', -150, 150),
      incrementalTemperature: p.int('crs:IncrementalTemperature', -100, 100, 0),
      incrementalTint: p.int('crs:IncrementalTint', -100, 100, 0),
    },

    tone: {
      exposure: current.real('crs:Exposure2012', -5, 5, 0),
      contrast: current.int('crs:Contrast2012', -100, 100, 0),
      highlights: current.int('crs:Highlights2012', -100, 100, 0),
      shadows: current.int('crs:Shadows2012', -100, 100, 0),
      whites: current.int('crs:Whites2012', -100, 100, 0),
      blacks: current.int('crs:Blacks2012', -100, 100, 0),
      curveName: current.enumeration('crs:ToneCurveName2012', TONE_CURVE_NAMES, 'Linear'),
      curve: current.curve('crs:ToneCurvePV2012'),
      curveRed: current.curve('crs:ToneCurvePV2012Red'),
      curveGreen: current.curve('crs:ToneCurvePV2012Green'),
      curveBlue: current.curve('crs:ToneCurvePV2012Blue'),
      parametricShadows: p.int('crs:ParametricShadows', -100, 100, 0),
      parametricDarks: p.int('crs:ParametricDarks', -100, 100, 0),
      parametricLights: p.int('crs:ParametricLights', -100, 100, 0),
      parametricHighlights: p.int('crs:ParametricHighlights', -100, 100, 0),
      parametricShadowSplit: p.int('crs:ParametricShadowSplit', 0, 100, 25),
      parametricMidtoneSplit: p.int('crs:ParametricMidtoneSplit', 0, 100, 50),
      parametricHighlightSplit: p.int('crs:ParametricHighlightSplit', 0, 100, 75),
    },

    presence: {
      texture: p.int('crs:Texture', -100, 100, 0),
      clarity: current.int('crs:Clarity2012', -100, 100, 0),
      // Did not exist before the current generation, so it is not read off a
      // legacy file even if something wrote one there.
      dehaze: current.real('crs:Dehaze', -100, 100, 0),
      vibrance: p.int('crs:Vibrance', -100, 100, 0),
      saturation: p.int('crs:Saturation', -100, 100, 0),
    },

    hsl: {
      hue: bands((band) => p.int(`crs:HueAdjustment${band}`, -100, 100, 0)),
      saturation: bands((band) => p.int(`crs:SaturationAdjustment${band}`, -100, 100, 0)),
      luminance: bands((band) => p.int(`crs:LuminanceAdjustment${band}`, -100, 100, 0)),
      gray: bands((band) => p.int(`crs:GrayMixer${band}`, -100, 100, 0)),
      convertToGrayscale: p.flag('crs:ConvertToGrayscale', false),
    },

    detail: {
      sharpness: p.int('crs:Sharpness', 0, 150, sharpnessDefault),
      sharpenRadius: p.real('crs:SharpenRadius', 0.5, 3, 1),
      sharpenDetail: p.int('crs:SharpenDetail', 0, 100, 25),
      sharpenEdgeMasking: p.int('crs:SharpenEdgeMasking', 0, 100, 0),
      luminanceSmoothing: p.int('crs:LuminanceSmoothing', 0, 100, 0),
      luminanceNoiseReductionDetail: p.int('crs:LuminanceNoiseReductionDetail', 0, 100, 50),
      luminanceNoiseReductionContrast: p.int('crs:LuminanceNoiseReductionContrast', 0, 100, 0),
      colorNoiseReduction: p.int('crs:ColorNoiseReduction', 0, 100, 25),
      colorNoiseReductionDetail: p.int('crs:ColorNoiseReductionDetail', 0, 100, 50),
      colorNoiseReductionSmoothness: p.int('crs:ColorNoiseReductionSmoothness', 0, 100, 50),
    },

    colorGrading: {
      splitToningShadowHue: p.int('crs:SplitToningShadowHue', 0, 360, 0),
      splitToningShadowSaturation: p.int('crs:SplitToningShadowSaturation', 0, 100, 0),
      splitToningHighlightHue: p.int('crs:SplitToningHighlightHue', 0, 360, 0),
      splitToningHighlightSaturation: p.int('crs:SplitToningHighlightSaturation', 0, 100, 0),
      splitToningBalance: p.int('crs:SplitToningBalance', -100, 100, 0),
      colorGradeShadowLuminance: p.int('crs:ColorGradeShadowLum', -100, 100, 0),
      colorGradeMidtoneHue: p.int('crs:ColorGradeMidtoneHue', 0, 360, 0),
      colorGradeMidtoneSaturation: p.int('crs:ColorGradeMidtoneSat', 0, 100, 0),
      colorGradeMidtoneLuminance: p.int('crs:ColorGradeMidtoneLum', -100, 100, 0),
      colorGradeHighlightLuminance: p.int('crs:ColorGradeHighlightLum', -100, 100, 0),
      colorGradeGlobalHue: p.int('crs:ColorGradeGlobalHue', 0, 360, 0),
      colorGradeGlobalSaturation: p.int('crs:ColorGradeGlobalSat', 0, 100, 0),
      colorGradeGlobalLuminance: p.int('crs:ColorGradeGlobalLum', -100, 100, 0),
      colorGradeBlending: p.int('crs:ColorGradeBlending', 0, 100, 50),
    },

    lens: {
      lensProfileEnable: p.flag('crs:LensProfileEnable', false),
      lensProfileSetup: p.enumeration('crs:LensProfileSetup', LENS_PROFILE_SETUPS, 'LensDefaults'),
      lensProfileName: p.text('crs:LensProfileName'),
      lensProfileFilename: p.text('crs:LensProfileFilename'),
      lensProfileDigest: p.text('crs:LensProfileDigest'),
      lensProfileIsEmbedded: p.flag('crs:LensProfileIsEmbedded', false),
      lensProfileDistortionScale: p.int('crs:LensProfileDistortionScale', 0, 200, 100),
      lensProfileChromaticAberrationScale: p.int('crs:LensProfileChromaticAberrationScale', 0, 200, 100),
      lensProfileVignettingScale: p.int('crs:LensProfileVignettingScale', 0, 200, 100),
      lensManualDistortionAmount: p.int('crs:LensManualDistortionAmount', -100, 100, 0),
      autoLateralCA: p.flag('crs:AutoLateralCA', false),
      chromaticAberrationR: p.int('crs:ChromaticAberrationR', -100, 100, 0),
      chromaticAberrationB: p.int('crs:ChromaticAberrationB', -100, 100, 0),
      defringePurpleAmount: p.int('crs:DefringePurpleAmount', 0, 20, 0),
      defringePurpleHueLo: p.int('crs:DefringePurpleHueLo', 0, 100, 30),
      defringePurpleHueHi: p.int('crs:DefringePurpleHueHi', 0, 100, 70),
      defringeGreenAmount: p.int('crs:DefringeGreenAmount', 0, 20, 0),
      defringeGreenHueLo: p.int('crs:DefringeGreenHueLo', 0, 100, 40),
      defringeGreenHueHi: p.int('crs:DefringeGreenHueHi', 0, 100, 60),
    },

    effects: {
      vignetteAmount: p.int('crs:VignetteAmount', -100, 100, 0),
      vignetteMidpoint: p.int('crs:VignetteMidpoint', 0, 100, 50),
      postCropVignetteAmount: p.int('crs:PostCropVignetteAmount', -100, 100, 0),
      postCropVignetteMidpoint: p.int('crs:PostCropVignetteMidpoint', 0, 100, 50),
      postCropVignetteFeather: p.int('crs:PostCropVignetteFeather', 0, 100, 50),
      postCropVignetteRoundness: p.int('crs:PostCropVignetteRoundness', -100, 100, 0),
      postCropVignetteStyle: p.int('crs:PostCropVignetteStyle', 1, 3, 1),
      postCropVignetteHighlightContrast: p.int('crs:PostCropVignetteHighlightContrast', 0, 100, 0),
      grainAmount: p.int('crs:GrainAmount', 0, 100, 0),
      grainSize: p.int('crs:GrainSize', 0, 100, 25),
      grainFrequency: p.int('crs:GrainFrequency', 0, 100, 50),
      grainSeed: p.int('crs:GrainSeed', -ANY, ANY, 0),
    },

    calibration: {
      shadowTint: p.int('crs:ShadowTint', -100, 100, 0),
      redHue: p.int('crs:RedHue', -100, 100, 0),
      redSaturation: p.int('crs:RedSaturation', -100, 100, 0),
      greenHue: p.int('crs:GreenHue', -100, 100, 0),
      greenSaturation: p.int('crs:GreenSaturation', -100, 100, 0),
      blueHue: p.int('crs:BlueHue', -100, 100, 0),
      blueSaturation: p.int('crs:BlueSaturation', -100, 100, 0),
    },

    geometry: {
      orientation: p.intOrNull('tiff:Orientation', 1, 8),
      hasCrop: cropped,
      cropTop: cropped ? cropTop : 0,
      cropLeft: cropped ? cropLeft : 0,
      cropBottom: cropped ? cropBottom : 1,
      cropRight: cropped ? cropRight : 1,
      cropAngle: p.real('crs:CropAngle', -45, 45, 0),
      cropWidth: p.realOrNull('crs:CropWidth', -ANY, ANY),
      cropHeight: p.realOrNull('crs:CropHeight', -ANY, ANY),
      cropUnits,
      cropConstrainToWarp: p.flag('crs:CropConstrainToWarp', false),
      perspectiveVertical: p.int('crs:PerspectiveVertical', -100, 100, 0),
      perspectiveHorizontal: p.int('crs:PerspectiveHorizontal', -100, 100, 0),
      perspectiveRotate: p.real('crs:PerspectiveRotate', -10, 10, 0),
      perspectiveScale: p.int('crs:PerspectiveScale', 50, 150, 100),
      perspectiveAspect: p.int('crs:PerspectiveAspect', -100, 100, 0),
      perspectiveX: p.real('crs:PerspectiveX', -100, 100, 0),
      perspectiveY: p.real('crs:PerspectiveY', -100, 100, 0),
      perspectiveUpright: p.int('crs:PerspectiveUpright', 0, 5, 0),
      uprightVersion: p.intOrNull('crs:UprightVersion', -ANY, ANY),
      uprightCenterMode: p.intOrNull('crs:UprightCenterMode', -ANY, ANY),
      uprightCenterNormX: p.realOrNull('crs:UprightCenterNormX', 0, 1),
      uprightCenterNormY: p.realOrNull('crs:UprightCenterNormY', 0, 1),
      uprightFocalMode: p.intOrNull('crs:UprightFocalMode', -ANY, ANY),
      uprightFocalLength35mm: p.realOrNull('crs:UprightFocalLength35mm', -ANY, ANY),
      uprightTransformCount: p.intOrNull('crs:UprightTransformCount', -ANY, ANY),
      uprightFourSegmentsCount: p.intOrNull('crs:UprightFourSegmentsCount', -ANY, ANY),
    },

    profile: {
      cameraProfile: p.text('crs:CameraProfile'),
      cameraProfileDigest: p.text('crs:CameraProfileDigest'),
    },

    // `crs:LookName`, which some writers emit alongside the structure, is a
    // different property at a different depth and is deliberately not merged
    // into this; it stays unread and is reported in `unsupported`.
    look: lookFields == null ? null : {
      name: lookFields.text('crs:Name'),
      amount: lookFields.realOrNull('crs:Amount', -ANY, ANY),
      uuid: lookFields.text('crs:UUID'),
      group: lookFields.langAlt('crs:Group'),
      cluster: lookFields.text('crs:Cluster'),
      copyright: lookFields.text('crs:Copyright'),
      supportsAmount: lookFields.flagOrNull('crs:SupportsAmount'),
      supportsMonochrome: lookFields.flagOrNull('crs:SupportsMonochrome'),
      supportsOutputReferred: lookFields.flagOrNull('crs:SupportsOutputReferred'),
      // `crs:Parameters` and its opaque `crs:LookTable` are left unread, which
      // names them in `unsupported`: a look's own parameter set is of no use
      // until looks are rendered, and the sidecar can be re-read then.
    },

    metadata: {
      rating: p.realOrNull('xmp:Rating', -1, 5),
      label: p.text('xmp:Label'),
      createDate: p.date('xmp:CreateDate'),
      modifyDate: p.date('xmp:ModifyDate'),
      metadataDate: p.date('xmp:MetadataDate'),
      subject: p.strings('dc:subject'),
      hierarchicalSubject: p.strings('lr:hierarchicalSubject'),
      title: p.langAlt('dc:title'),
      description: p.langAlt('dc:description'),
      creator: p.strings('dc:creator'),
      rights: p.langAlt('dc:rights'),
      dateCreated: p.date('photoshop:DateCreated'),
      sidecarForExtension: p.text('photoshop:SidecarForExtension'),
      rawFileName: p.text('crs:RawFileName'),
    },

    legacyTone: !legacy ? null : {
      exposure: p.real('crs:Exposure', -4, 4, 0),
      // Null rather than the tabulated default where that default is
      // unconfirmed: on these four an absent tag does not mean neutral, so a
      // wrong non-zero number would be applied as though it had been measured.
      brightness: p.intOrNull('crs:Brightness', 0, 150),
      contrast: p.intOrNull('crs:Contrast', -50, 100),
      shadows: p.intOrNull('crs:Shadows', 0, 100),
      highlightRecovery: p.int('crs:HighlightRecovery', 0, 100, 0),
      fillLight: p.int('crs:FillLight', 0, 100, 0),
      clarity: p.int('crs:Clarity', -100, 100, 0),
      curve: p.curve('crs:ToneCurve'),
      curveName: p.text('crs:ToneCurveName'),
      curveRed: p.curve('crs:ToneCurveRed'),
      curveGreen: p.curve('crs:ToneCurveGreen'),
      curveBlue: p.curve('crs:ToneCurveBlue'),
    },

    unsupported: [...new Set([...p.unsupported(), ...(lookFields?.unsupported() ?? [])])].sort(),
    issues,
  };

  return XmpSettingsSchema.parse(settings);
}
