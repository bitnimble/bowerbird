import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { Issue, XmpDate } from './xmp_schema';

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const XML = 'http://www.w3.org/XML/1998/namespace';
const ANY = Number.POSITIVE_INFINITY;
const CURVE_MAX = 255;

// Properties are bound by namespace URI, never by prefix: a file may declare the
// crs namespace as `foo:` and write `foo:Exposure2012`, and that is the same
// property. The canonical prefix is what a name is reported as, so `crs:Contrast`
// in an issue means the property in the crs URI however the file spelled it.
// Keys have any trailing `/` stripped, because some writers emit the crs URI
// without one.
// A Map rather than an object literal because the lookup key comes out of the
// document: `xmlns:constructor="..."` against a plain object would resolve to
// something off Object.prototype instead of missing.
const CANONICAL_PREFIX = new Map<string, string>([
  [RDF, 'rdf'],
  [XML, 'xml'],
  ['adobe:ns:meta', 'x'],
  ['http://ns.adobe.com/camera-raw-settings/1.0', 'crs'],
  ['http://ns.adobe.com/xap/1.0', 'xmp'],
  ['http://purl.org/dc/elements/1.1', 'dc'],
  ['http://ns.adobe.com/tiff/1.0', 'tiff'],
  ['http://ns.adobe.com/exif/1.0', 'exif'],
  ['http://ns.adobe.com/photoshop/1.0', 'photoshop'],
  ['http://ns.adobe.com/lightroom/1.0', 'lr'],
]);
// preserveOrder keeps every element as its own node, which is what makes the
// namespace walk below possible: the merged form collapses repeated elements
// and drops the document order two `rdf:Description` blocks are merged in.
// Values are left as strings - a blanket numeric coercion turns
// `crs:WhiteBalance="Auto"` into NaN and `crs:CameraProfile="2"` into a number -
// and coerced per tag against the type each one is documented with.
//
// htmlEntities is what decodes `&#246;` and `&#xE9;`; without it the named
// entities decode and the numeric ones survive as literal text, so a keyword
// written by a writer that escapes non-ASCII imports as `Bj&#246;rk`.
// trimValues is off because it trims each text run separately, and an element
// whose text is split by CDATA or a child then loses the space between the
// runs; the whole value is trimmed once instead, where it is read.
const PARSER = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  htmlEntities: true,
  ignoreDeclaration: true,
  ignorePiTags: true,
});

type Attrs = Record<string, string>;
type XmlNode = Record<string, XmlNode[] | Attrs | string>;
// Prefix to URI. A Map, not an object, for the reason CANONICAL_PREFIX is one:
// `xmlns:__proto__="..."` on a plain object writes nothing and reads back the
// prototype, which would make every property in that namespace disappear.
type NsMap = ReadonlyMap<string, string>;

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
  return uri.replace(/\/+$/, '');
}

function qualify(name: string, ns: NsMap, isAttribute: boolean): string | null {
  const colon = name.indexOf(':');
  // An unprefixed attribute is in no namespace at all, unlike an unprefixed
  // element, which takes the default one.
  if (colon < 0) return isAttribute ? null : qualified(ns.get('') ?? '', name);
  const uri = ns.get(name.slice(0, colon));
  return uri == null ? null : qualified(uri, name.slice(colon + 1));
}

function qualified(uri: string, local: string): string {
  if (uri === '') return local;
  const prefix = CANONICAL_PREFIX.get(uri);
  return prefix == null ? `{${uri}}${local}` : `${prefix}:${local}`;
}

// Declarations are commonly written on `rdf:Description` rather than the root,
// so every element inherits its ancestors' and may add its own.
function withNamespaces(ns: NsMap, attrs: Attrs): NsMap {
  let extended: Map<string, string> | null = null;
  for (const [name, value] of Object.entries(attrs)) {
    if (!isNamespaceDeclaration(name)) continue;
    extended ??= new Map(ns);
    extended.set(name === '@_xmlns' ? '' : name.slice('@_xmlns:'.length), normaliseUri(String(value)));
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

// Every text run and attribute value below a property, for comparing two
// spellings of the same property against each other. A container's own text is
// empty - its content is one level down, in the `rdf:li` elements - so
// comparing on `rawText` alone calls two different keyword bags identical.
function collisionKey(prop: Prop): string {
  return 'text' in prop ? prop.text : deepText(prop.node);
}

function deepText(node: XmlNode): string {
  let out = '';
  for (const value of Object.values(attrsOf(node))) out += String(value) + ' ';
  for (const child of childrenOf(node)) {
    const text = child[TEXT];
    out += typeof text === 'string' ? text : tagOf(child) + '(' + deepText(child) + ')';
  }
  return out;
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
export class Properties {
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
    return this.enumerationOrNull(tag, known) ?? fallback;
  }

  enumerationOrNull(tag: string, known: readonly string[]): string | null {
    const value = this.text(tag);
    if (value == null) return null;
    if (!known.includes(value)) this.record(tag, 'unconvertible', value);
    return value;
  }

  /**
   * A code standing for an operator or a mode rather than for a magnitude.
   * Unlike a slider it is not clamped: 9 is not "the strongest vignette style",
   * and rounding it down to 3 would assert an operator the file never named, so
   * an unknown code falls back to the default and is reported.
   */
  enumInt(tag: string, known: readonly number[], fallback: number): number {
    const value = this.number(tag, -ANY, ANY, true);
    if (value == null) return fallback;
    if (known.includes(value)) return value;
    this.record(tag, 'unconvertible', this.verbatim(tag));
    return fallback;
  }

  enumIntOrNull(tag: string, known: readonly number[]): number | null {
    const value = this.number(tag, -ANY, ANY, true);
    if (value == null || known.includes(value)) return value;
    this.record(tag, 'unconvertible', this.verbatim(tag));
    return null;
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
    // Language tags are case-insensitive, so `X-Default` selects too.
    const chosen = items.find((item) => item.lang?.toLowerCase() === 'x-default') ?? items[0]!;
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

  /**
   * A structure in either serialisation, as its own property set. A property
   * written as neither is left unconsumed rather than dropped, so it surfaces in
   * `unsupported`: a Look we could not read must not produce the same struct as
   * a file that carries no Look at all.
   */
  struct(tag: string): Properties | null {
    const prop = this.props.get(tag);
    if (prop == null || 'text' in prop) return null;
    const nested = attributes(prop.node, prop.ns).get('rdf:parseType') === 'Resource'
      ? prop
      : elements(childrenOf(prop.node), prop.ns).find((child) => child.name === 'rdf:Description');
    if (nested == null) return null;
    this.consumed.add(tag);
    const fields = new Properties(this.issues, `${this.prefix}${tag}/`);
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
    // Last wins, whichever `rdf:Description` it came from. The comparison goes
    // all the way down, so a collision between two containers or two structures
    // is reported rather than passing as the same value written twice.
    if (existing != null && collisionKey(existing) !== collisionKey(prop)) {
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

const DATE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?(Z|[+-]\d{2}:\d{2})?$/;

// Digit counts alone would accept 2024-13-45T99:99, which is not a date any
// consumer can use and is better reported than passed on typed as one.
const DATE_BOUNDS: [number, number][] = [[1, 12], [1, 31], [0, 23], [0, 59], [0, 60]];

function parseDate(value: string): XmpDate | null {
  const match = DATE.exec(value.trim());
  if (match == null) return null;
  for (const [index, [min, max]] of DATE_BOUNDS.entries()) {
    const part = match[index + 2];
    if (part != null && (Number(part) < min || Number(part) > max)) return null;
  }
  const zone = match[7];
  return {
    value: value.trim().slice(0, zone == null ? undefined : -zone.length),
    offset: zone == null ? null : zone === 'Z' ? '+00:00' : zone,
  };
}

function findRdf(children: XmlNode[], ns: NsMap): Element | null {
  for (const element of elements(children, ns)) {
    if (element.name === 'rdf:RDF') return element;
    const found = findRdf(childrenOf(element.node), element.ns);
    if (found != null) return found;
  }
  return null;
}

export interface ParsedXmpProperties {
  properties: Properties;
  issues: Issue[];
}

export function parseXmpProperties(xml: string): ParsedXmpProperties | null {
  const issues: Issue[] = [];
  const properties = new Properties(issues);

  try {
    const text = xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml;
    if (XMLValidator.validate(text) !== true) return null;
    const root = PARSER.parse(text) as XmlNode[];
    const rdf = findRdf(root, new Map([['xml', XML]]));
    if (rdf == null) return null;

    for (const description of elements(childrenOf(rdf.node), rdf.ns)) {
      if (description.name === 'rdf:Description') properties.collect(description.node, description.ns);
    }
    return { properties, issues };
  } catch {
    return null;
  }
}
