import { describe, expect, it } from 'bun:test';
import { parseXmp } from '../xmp';
import type { XmpSettings } from '../xmp_schema';

const NS = [
  'xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"',
  'xmlns:tiff="http://ns.adobe.com/tiff/1.0/"',
  'xmlns:xmp="http://ns.adobe.com/xap/1.0/"',
  'xmlns:dc="http://purl.org/dc/elements/1.1/"',
  'xmlns:lr="http://ns.adobe.com/lightroom/1.0/"',
  'xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"',
  'xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/"',
].join(' ');

function packet(body: string): string {
  return `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="bowerbird test">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
${body}
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

function description(attrs: string, children = ''): string {
  return `<rdf:Description rdf:about="" ${NS} ${attrs}>${children}</rdf:Description>`;
}

// Every test asserts against a parsed struct, so a null here is a failure of the
// fixture, not a case under test.
function parse(body: string): XmpSettings {
  const settings = parseXmp(packet(body));
  if (settings == null) throw new Error('fixture did not parse');
  return settings;
}

function parseAttrs(attrs: string, children = ''): XmpSettings {
  return parse(description(attrs, children));
}

const CURRENT = 'crs:ProcessVersion="6.7" crs:Version="13.2"';

describe('parseXmp: container and namespaces', () => {
  it('reads scalars written as attributes and as elements identically', () => {
    // One document written both ways, across every block that holds a scalar,
    // compared whole: a form handled for one type and not another is the way
    // this fails in the wild.
    const scalars: [string, string][] = [
      ['crs:ProcessVersion', '6.7'], ['crs:Version', '13.2'], ['crs:HasSettings', 'True'],
      ['crs:Exposure2012', '+0.35'], ['crs:Contrast2012', '12'], ['crs:ToneCurveName2012', 'Medium Contrast'],
      ['crs:WhiteBalance', 'Cloudy'], ['crs:Temperature', '6500'], ['crs:Dehaze', '+7.5'],
      ['crs:ConvertToGrayscale', 'True'], ['crs:GrayMixerAqua', '-14'], ['crs:Sharpness', '55'],
      ['crs:SplitToningShadowHue', '215'], ['crs:LensProfileName', 'Canon EF 35mm'], ['crs:GrainAmount', '12'],
      ['crs:BlueHue', '-6'], ['tiff:Orientation', '6'], ['crs:HasCrop', 'True'], ['crs:CropRight', '0.8'],
      ['crs:PerspectiveUpright', '3'], ['crs:CameraProfile', 'Adobe Color'], ['xmp:Rating', '4'],
      ['xmp:CreateDate', '2025-11-02T17:41:09+11:00'], ['crs:RawFileName', 'IMG_1234.CR2'],
    ];
    const asAttributes = parseAttrs(scalars.map(([tag, value]) => `${tag}="${value}"`).join(' '));
    const asElements = parseAttrs('', scalars.map(([tag, value]) => `<${tag}>${value}</${tag}>`).join(''));
    expect(asAttributes.tone.exposure).toBe(0.35);
    expect(asAttributes.metadata.rating).toBe(4);
    expect(asElements).toEqual(asAttributes);
  });

  it('reads a structure as a nested rdf:Description and as parseType="Resource" identically', () => {
    const nested = parseAttrs(
      CURRENT,
      '<crs:Look><rdf:Description crs:Name="Adobe Color" crs:Amount="1" crs:UUID="abc"/></crs:Look>',
    );
    const shorthand = parseAttrs(
      CURRENT,
      '<crs:Look rdf:parseType="Resource"><crs:Name>Adobe Color</crs:Name><crs:Amount>1</crs:Amount><crs:UUID>abc</crs:UUID></crs:Look>',
    );
    expect(nested.look).toEqual({
      name: 'Adobe Color',
      amount: 1,
      uuid: 'abc',
      group: null,
      cluster: null,
      copyright: null,
      supportsAmount: null,
      supportsMonochrome: null,
      supportsOutputReferred: null,
    });
    expect(shorthand.look).toEqual(nested.look);
  });

  it('binds by namespace URI rather than by prefix', () => {
    const renamed = parse(
      `<rdf:Description rdf:about="" xmlns:foo="http://ns.adobe.com/camera-raw-settings/1.0/" foo:ProcessVersion="6.7" foo:Exposure2012="+1.5"/>`,
    );
    expect(renamed.tone.exposure).toBe(1.5);
    expect(renamed.legacy).toBe(false);

    const impostor = parse(
      `<rdf:Description rdf:about="" xmlns:crs="http://example.com/not-camera-raw/" crs:Exposure2012="+1.5"/>`,
    );
    expect(impostor.tone.exposure).toBe(0);
    expect(impostor.unsupported).toEqual([]);
  });

  it('tolerates the crs URI written without its trailing slash', () => {
    const settings = parse(
      `<rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0" crs:ProcessVersion="6.7" crs:Blacks2012="-20"/>`,
    );
    expect(settings.tone.blacks).toBe(-20);
  });

  it('merges several rdf:Description elements, last value winning', () => {
    const settings = parse(
      `${description(`${CURRENT} crs:Exposure2012="+0.25"`)}\n${description('crs:Contrast2012="30" crs:Exposure2012="+0.75"')}`,
    );
    expect(settings.tone.exposure).toBe(0.75);
    expect(settings.tone.contrast).toBe(30);
    expect(settings.issues).toEqual([{ tag: 'crs:Exposure2012', reason: 'duplicate', value: '+0.25' }]);
  });

  it('parses a leading BOM and hundreds of bytes of xpacket padding', () => {
    const padded = `﻿${packet(description(`${CURRENT} crs:Whites2012="10"`))}\n${' '.repeat(800)}`;
    expect(parseXmp(padded)?.tone.whites).toBe(10);
  });

  it('yields an array for a one-element rdf:Bag', () => {
    const one = parseAttrs('', '<dc:subject><rdf:Bag><rdf:li>owl</rdf:li></rdf:Bag></dc:subject>');
    expect(one.metadata.subject).toEqual(['owl']);
    const two = parseAttrs('', '<dc:subject><rdf:Bag><rdf:li>owl</rdf:li><rdf:li>tree</rdf:li></rdf:Bag></dc:subject>');
    expect(two.metadata.subject).toEqual(['owl', 'tree']);
  });

  it('takes the x-default alternative out of an rdf:Alt', () => {
    const settings = parseAttrs(
      '',
      '<dc:title><rdf:Alt><rdf:li xml:lang="fr">Hibou</rdf:li><rdf:li xml:lang="x-default">Owl</rdf:li><rdf:li xml:lang="de">Eule</rdf:li></rdf:Alt></dc:title>',
    );
    expect(settings.metadata.title).toBe('Owl');
  });

  it('matches x-default whatever case it is written in, and falls back to the first', () => {
    const cased = parseAttrs('', '<dc:title><rdf:Alt><rdf:li xml:lang="fr">Hibou</rdf:li><rdf:li xml:lang="X-Default">Owl</rdf:li></rdf:Alt></dc:title>');
    expect(cased.metadata.title).toBe('Owl');
    const unmarked = parseAttrs('', '<dc:title><rdf:Alt><rdf:li xml:lang="fr">Hibou</rdf:li><rdf:li xml:lang="de">Eule</rdf:li></rdf:Alt></dc:title>');
    expect(unmarked.metadata.title).toBe('Hibou');
  });

  it('tolerates a doubled trailing slash on a namespace URI', () => {
    const settings = parse(
      '<rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0//" crs:ProcessVersion="6.7" crs:Whites2012="7"/>',
    );
    expect(settings.tone.whites).toBe(7);
  });

  it('finds an rdf:RDF nested below the depth a packet usually puts it', () => {
    const nested = parseXmp(
      `<wrapper xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><outer><inner><x:xmpmeta xmlns:x="adobe:ns:meta/">`
        + `<rdf:RDF>${description(`${CURRENT} crs:Whites2012="3"`)}</rdf:RDF></x:xmpmeta></inner></outer></wrapper>`,
    );
    expect(nested?.tone.whites).toBe(3);
  });

  it('returns null rather than a struct of defaults for input that is not XMP', () => {
    expect(parseXmp('<x:xmpmeta><rdf:RDF><rdf:Description crs:Exposure2012="1"')).toBeNull();
    expect(parseXmp('not xml at all')).toBeNull();
    expect(parseXmp('')).toBeNull();
    expect(parseXmp('<html><body>hello</body></html>')).toBeNull();
  });

  it('decodes numeric character references, not just named entities', () => {
    const settings = parseAttrs(
      `${CURRENT} crs:LensProfileName="Sigma 50mm f/1.4 &#188; stop"`,
      '<dc:subject><rdf:Bag><rdf:li>Bj&#246;rk</rdf:li><rdf:li>caf&#xE9;</rdf:li></rdf:Bag></dc:subject>'
        + '<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Salt &amp; Pepper</rdf:li></rdf:Alt></dc:title>',
    );
    expect(settings.metadata.subject).toEqual(['Björk', 'café']);
    expect(settings.metadata.title).toBe('Salt & Pepper');
    expect(settings.lens.lensProfileName).toBe('Sigma 50mm f/1.4 ¼ stop');
  });

  it('keeps the space between text runs split by a CDATA section', () => {
    const settings = parseAttrs('', '<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Hello <![CDATA[World]]></rdf:li></rdf:Alt></dc:title>');
    expect(settings.metadata.title).toBe('Hello World');
  });

  it('reports a collision between two structured values, not just two scalars', () => {
    const settings = parse(
      `${description(CURRENT, '<dc:subject><rdf:Bag><rdf:li>owl</rdf:li></rdf:Bag></dc:subject>')}\n`
        + `${description('', '<dc:subject><rdf:Bag><rdf:li>heron</rdf:li></rdf:Bag></dc:subject>')}`,
    );
    expect(settings.metadata.subject).toEqual(['heron']);
    expect(settings.issues).toEqual([{ tag: 'dc:subject', reason: 'duplicate', value: '' }]);
  });

  it('does not report the same value written twice', () => {
    const settings = parse(
      `${description(`${CURRENT} crs:Texture="20"`)}\n${description('crs:Texture="20"')}`,
    );
    expect(settings.presence.texture).toBe(20);
    expect(settings.issues).toEqual([]);
  });

  it('resolves a prefix that collides with an Object property name', () => {
    const settings = parse(
      '<rdf:Description rdf:about="" xmlns:__proto__="http://ns.adobe.com/camera-raw-settings/1.0/"'
        + ' __proto__:ProcessVersion="6.7" __proto__:Whites2012="9"/>',
    );
    expect(settings.tone.whites).toBe(9);
    expect(settings.processVersion).toEqual({ generation: 3, raw: '6.7' });
  });

  it('drops a property whose prefix was never declared', () => {
    const settings = parse(`<rdf:Description rdf:about="" ${NS} nope:Exposure2012="+2.0" crs:ProcessVersion="6.7"/>`);
    expect(settings.tone.exposure).toBe(0);
    expect(settings.unsupported).toEqual([]);
  });

  it('returns null for well-formed XML carrying no rdf:RDF', () => {
    expect(parseXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"><something/></x:xmpmeta>')).toBeNull();
  });

  it('reads rdf:RDF at the root, and past an XML declaration', () => {
    const bare = parseXmp(
      `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">${description(`${CURRENT} crs:Blacks2012="-5"`)}</rdf:RDF>`,
    );
    expect(bare?.tone.blacks).toBe(-5);
    expect(parseXmp(`<?xml version="1.0" encoding="UTF-8"?>\n${packet(description(`${CURRENT} crs:Blacks2012="-5"`))}`)?.tone.blacks).toBe(-5);
  });

  it('reads a structure whose nested rdf:Description holds its fields as elements', () => {
    const settings = parseAttrs(CURRENT, '<crs:Look><rdf:Description><crs:Name>Adobe Vivid</crs:Name><crs:Amount>0.5</crs:Amount></rdf:Description></crs:Look>');
    expect(settings.look).toEqual({
      name: 'Adobe Vivid',
      amount: 0.5,
      uuid: null,
      group: null,
      cluster: null,
      copyright: null,
      supportsAmount: null,
      supportsMonochrome: null,
      supportsOutputReferred: null,
    });
  });
});
