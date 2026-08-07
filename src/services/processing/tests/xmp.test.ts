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

describe('parseXmp: versions', () => {
  it('reads the *2012 tags at process version 6.7', () => {
    const settings = parseAttrs('crs:ProcessVersion="6.7" crs:Exposure2012="+0.5" crs:Shadows2012="40"');
    expect(settings.legacy).toBe(false);
    expect(settings.processVersion).toEqual({ generation: 3, raw: '6.7' });
    expect(settings.tone.exposure).toBe(0.5);
    expect(settings.tone.shadows).toBe(40);
    expect(settings.legacyTone).toBeNull();
  });

  it('compares process versions componentwise, not as strings', () => {
    expect(parseAttrs('crs:ProcessVersion="15.4"').processVersion.generation).toBe(6);
    expect(parseAttrs('crs:ProcessVersion="11"').processVersion.generation).toBe(5);
    expect(parseAttrs('crs:ProcessVersion="10.0"').processVersion.generation).toBe(4);
    expect(parseAttrs('crs:ProcessVersion="6.7.0.0"').processVersion.generation).toBe(3);
    expect(parseAttrs('crs:ProcessVersion="6.6"').processVersion.generation).toBe(3);
    expect(parseAttrs('crs:ProcessVersion="5.7"').processVersion.generation).toBeNull();
    expect(parseAttrs('').processVersion).toEqual({ generation: null, raw: null });
  });

  it('reports a version it cannot parse instead of reading it as absent', () => {
    const settings = parseAttrs('crs:ProcessVersion="banana" crs:Version="17.x" crs:Exposure2012="+1.0"');
    expect(settings.processVersion).toEqual({ generation: null, raw: 'banana' });
    expect(settings.issues).toEqual([
      { tag: 'crs:ProcessVersion', reason: 'unparseable', value: 'banana' },
      { tag: 'crs:Version', reason: 'unparseable', value: '17.x' },
    ]);
    // The tonal edit cannot be read at an unknown generation, but the fact that
    // it was in the file survives.
    expect(settings.tone.exposure).toBe(0);
    expect(settings.unsupported).toEqual(['crs:Exposure2012']);
  });

  it('treats an absent process version as legacy and says what it set aside', () => {
    const settings = parseAttrs('crs:Exposure2012="+1.0" crs:Contrast2012="20"');
    expect(settings.legacy).toBe(true);
    expect(settings.tone.exposure).toBe(0);
    expect(settings.legacyTone).not.toBeNull();
    expect(settings.unsupported).toEqual(['crs:Contrast2012', 'crs:Exposure2012']);
  });

  it('reads a pre-2012 file into legacyTone and leaves tone at its defaults', () => {
    const settings = parseAttrs(
      'crs:ProcessVersion="5.7" crs:Exposure="+0.80" crs:Brightness="60" crs:Contrast="30" crs:FillLight="12" crs:Clarity="15"'
        + ' crs:Temperature="5500" crs:Tint="+8" crs:HueAdjustmentAqua="-20" crs:Sharpness="70" crs:HasCrop="True" crs:CropRight="0.5"',
    );
    expect(settings.legacy).toBe(true);
    expect(settings.legacyTone).toMatchObject({
      exposure: 0.8,
      brightness: 60,
      contrast: 30,
      fillLight: 12,
      clarity: 15,
      curveName: null,
    });
    expect(settings.tone.exposure).toBe(0);
    expect(settings.tone.contrast).toBe(0);
    // Everything whose name and meaning did not change still imports.
    expect(settings.whiteBalance.temperature).toBe(5500);
    expect(settings.whiteBalance.tint).toBe(8);
    expect(settings.hsl.hue.aqua).toBe(-20);
    expect(settings.detail.sharpness).toBe(70);
    expect(settings.geometry.hasCrop).toBe(true);
    expect(settings.geometry.cropRight).toBe(0.5);
  });

  it('omits an unconfirmed legacy default rather than guessing a number', () => {
    const settings = parseAttrs('crs:ProcessVersion="5.7" crs:Exposure="+0.10"');
    expect(settings.legacyTone).toMatchObject({ brightness: null, contrast: null, shadows: null, curveName: null });
    expect(settings.legacyTone?.highlightRecovery).toBe(0);
  });

  it('prefers the suffixed tag on a current file and reports the legacy twin', () => {
    const settings = parseAttrs(`${CURRENT} crs:Contrast="25" crs:Contrast2012="-40"`);
    expect(settings.tone.contrast).toBe(-40);
    expect(settings.legacyTone).toBeNull();
    expect(settings.unsupported).toContain('crs:Contrast');
  });
});

describe('parseXmp: values and defaults', () => {
  it('populates every non-zero default when the file carries no settings', () => {
    const settings = parseAttrs('crs:ProcessVersion="11.0" crs:Version="9.0"');
    expect(settings.hasSettings).toBe(false);
    expect(settings.detail).toEqual({
      sharpness: 25,
      sharpenRadius: 1,
      sharpenDetail: 25,
      sharpenEdgeMasking: 0,
      luminanceSmoothing: 0,
      luminanceNoiseReductionDetail: 50,
      luminanceNoiseReductionContrast: 0,
      colorNoiseReduction: 25,
      colorNoiseReductionDetail: 50,
      colorNoiseReductionSmoothness: 50,
    });
    expect(settings.tone.parametricShadowSplit).toBe(25);
    expect(settings.tone.parametricMidtoneSplit).toBe(50);
    expect(settings.tone.parametricHighlightSplit).toBe(75);
    expect(settings.effects.vignetteMidpoint).toBe(50);
    expect(settings.effects.postCropVignetteMidpoint).toBe(50);
    expect(settings.effects.postCropVignetteFeather).toBe(50);
    expect(settings.effects.postCropVignetteStyle).toBe(1);
    expect(settings.effects.grainSize).toBe(25);
    expect(settings.effects.grainFrequency).toBe(50);
    expect(settings.geometry.perspectiveScale).toBe(100);
    // Exhaustively, like the detail block: the defringe hue bounds and the two
    // other profile scales are the values most likely to be edited by someone
    // confirming them against real files, and a spot check would not notice.
    expect(settings.lens).toEqual({
      lensProfileEnable: false,
      lensProfileSetup: 'LensDefaults',
      lensProfileName: null,
      lensProfileFilename: null,
      lensProfileDigest: null,
      lensProfileIsEmbedded: false,
      lensProfileDistortionScale: 100,
      lensProfileChromaticAberrationScale: 100,
      lensProfileVignettingScale: 100,
      lensManualDistortionAmount: 0,
      autoLateralCA: false,
      chromaticAberrationR: 0,
      chromaticAberrationB: 0,
      defringePurpleAmount: 0,
      defringePurpleHueLo: 30,
      defringePurpleHueHi: 70,
      defringeGreenAmount: 0,
      defringeGreenHueLo: 40,
      defringeGreenHueHi: 60,
    });
    expect(settings.colorGrading.colorGradeBlending).toBe(50);
    expect(settings.whiteBalance.mode).toBe('As Shot');
    expect(settings.tone.curveName).toBe('Linear');
    // And the blocks whose defaults are all zero are still fully populated:
    // absence of a tag is that tag's default, never a missing block.
    expect(settings.presence).toEqual({ texture: 0, clarity: 0, dehaze: 0, vibrance: 0, saturation: 0 });
    expect(settings.calibration).toEqual({
      shadowTint: 0,
      redHue: 0,
      redSaturation: 0,
      greenHue: 0,
      greenSaturation: 0,
      blueHue: 0,
      blueSaturation: 0,
    });
    expect(settings.hsl.hue).toEqual({ red: 0, orange: 0, yellow: 0, green: 0, aqua: 0, blue: 0, purple: 0, magenta: 0 });
    expect(settings.hsl.gray).toEqual(settings.hsl.hue);
    expect(settings.profile).toEqual({ cameraProfile: null, cameraProfileDigest: null });
    expect(settings.metadata.subject).toEqual([]);
    expect(settings.metadata.rating).toBeNull();
    expect(settings.look).toBeNull();
    expect(settings.issues).toEqual([]);
  });

  it('takes the sharpening default from the writer build', () => {
    expect(parseAttrs('crs:Version="10.2"').detail.sharpness).toBe(25);
    expect(parseAttrs('crs:Version="10.3"').detail.sharpness).toBe(40);
    expect(parseAttrs('crs:Version="17.0"').detail.sharpness).toBe(40);
    expect(parseAttrs('').detail.sharpness).toBe(25);
  });

  it('reads a colour grade from the split-toning tags it shares storage with', () => {
    const settings = parseAttrs(
      `${CURRENT} crs:SplitToningShadowHue="220" crs:SplitToningShadowSaturation="18"`
        + ' crs:SplitToningHighlightHue="45" crs:SplitToningHighlightSaturation="12" crs:SplitToningBalance="-10"'
        + ' crs:ColorGradeMidtoneHue="120" crs:ColorGradeMidtoneSat="8" crs:ColorGradeShadowLum="-5" crs:ColorGradeBlending="70"',
    );
    expect(settings.colorGrading).toEqual({
      splitToningShadowHue: 220,
      splitToningShadowSaturation: 18,
      splitToningHighlightHue: 45,
      splitToningHighlightSaturation: 12,
      splitToningBalance: -10,
      colorGradeShadowLuminance: -5,
      colorGradeMidtoneHue: 120,
      colorGradeMidtoneSaturation: 8,
      colorGradeMidtoneLuminance: 0,
      colorGradeHighlightLuminance: 0,
      colorGradeGlobalHue: 0,
      colorGradeGlobalSaturation: 0,
      colorGradeGlobalLuminance: 0,
      colorGradeBlending: 70,
    });
    expect(settings.unsupported).toEqual([]);
  });

  it('leaves temperature and tint null on an as-shot file and keeps them when present', () => {
    const asShot = parseAttrs(`${CURRENT} crs:WhiteBalance="As Shot"`);
    expect(asShot.whiteBalance.temperature).toBeNull();
    expect(asShot.whiteBalance.tint).toBeNull();

    const preset = parseAttrs(`${CURRENT} crs:WhiteBalance="Cloudy" crs:Temperature="6500" crs:Tint="-4"`);
    expect(preset.whiteBalance).toMatchObject({ mode: 'Cloudy', temperature: 6500, tint: -4 });
  });

  it('keeps the incremental white balance apart from the Kelvin pair', () => {
    const settings = parseAttrs(`${CURRENT} crs:IncrementalTemperature="-30" crs:IncrementalTint="+15"`);
    expect(settings.whiteBalance).toEqual({
      mode: 'As Shot',
      temperature: null,
      tint: null,
      incrementalTemperature: -30,
      incrementalTint: 15,
    });
  });

  it('clamps an out-of-range value and reports it', () => {
    const settings = parseAttrs(`${CURRENT} crs:Contrast2012="240" crs:Exposure2012="-9.5"`);
    expect(settings.tone.contrast).toBe(100);
    expect(settings.tone.exposure).toBe(-5);
    expect(settings.issues).toHaveLength(2);
    expect(settings.issues).toContainEqual({ tag: 'crs:Contrast2012', reason: 'clamped', value: '240' });
    expect(settings.issues).toContainEqual({ tag: 'crs:Exposure2012', reason: 'clamped', value: '-9.5' });
  });

  it('imports every other tag around an unparseable value', () => {
    const settings = parseAttrs(`${CURRENT} crs:Contrast2012="banana" crs:Whites2012="15" crs:Texture="20"`);
    expect(settings.tone.contrast).toBe(0);
    expect(settings.tone.whites).toBe(15);
    expect(settings.presence.texture).toBe(20);
    expect(settings.issues).toEqual([{ tag: 'crs:Contrast2012', reason: 'unparseable', value: 'banana' }]);
  });

  it('rounds a real written into an integer tag without complaint', () => {
    const settings = parseAttrs(`${CURRENT} crs:Vibrance="25.0" crs:Saturation="12.6"`);
    expect(settings.presence.vibrance).toBe(25);
    expect(settings.presence.saturation).toBe(13);
    expect(settings.issues).toEqual([]);
  });

  it('keeps an unrecognised enum value verbatim', () => {
    const settings = parseAttrs(`${CURRENT} crs:WhiteBalance="Underwater" crs:ToneCurveName2012="My Preset"`);
    expect(settings.whiteBalance.mode).toBe('Underwater');
    expect(settings.tone.curveName).toBe('My Preset');
    expect(settings.issues).toEqual([
      { tag: 'crs:WhiteBalance', reason: 'unconvertible', value: 'Underwater' },
      { tag: 'crs:ToneCurveName2012', reason: 'unconvertible', value: 'My Preset' },
    ]);
  });
});

describe('parseXmp: geometry', () => {
  it('treats crs:HasCrop as authoritative over stale edges', () => {
    const settings = parseAttrs(`${CURRENT} crs:HasCrop="False" crs:CropTop="0.2" crs:CropLeft="0.1" crs:CropBottom="0.8" crs:CropRight="0.7"`);
    expect(settings.geometry).toMatchObject({ hasCrop: false, cropTop: 0, cropLeft: 0, cropBottom: 1, cropRight: 1 });
  });

  it('refuses a degenerate crop rectangle', () => {
    const settings = parseAttrs(`${CURRENT} crs:HasCrop="True" crs:CropTop="0.9" crs:CropBottom="0.4"`);
    expect(settings.geometry.hasCrop).toBe(false);
    expect(settings.geometry.cropBottom).toBe(1);
    expect(settings.issues).toEqual([{ tag: 'crs:CropTop', reason: 'malformed', value: '0.9' }]);
  });

  it('refuses a horizontally degenerate rectangle too', () => {
    const settings = parseAttrs(`${CURRENT} crs:HasCrop="True" crs:CropLeft="0.8" crs:CropRight="0.3"`);
    expect(settings.geometry).toMatchObject({ hasCrop: false, cropLeft: 0, cropRight: 1 });
    expect(settings.issues).toEqual([{ tag: 'crs:CropLeft', reason: 'malformed', value: '0.8' }]);
  });

  it('names an edge the file actually wrote rather than one sitting on its default', () => {
    const settings = parseAttrs(`${CURRENT} crs:HasCrop="True" crs:CropBottom="0"`);
    expect(settings.geometry.hasCrop).toBe(false);
    expect(settings.issues).toEqual([{ tag: 'crs:CropBottom', reason: 'malformed', value: '0' }]);
  });

  it('drops the straighten angle along with the crop it belonged to', () => {
    const undone = parseAttrs(`${CURRENT} crs:HasCrop="False" crs:CropAngle="-12.5"`);
    expect(undone.geometry.cropAngle).toBe(0);
    const kept = parseAttrs(`${CURRENT} crs:HasCrop="True" crs:CropAngle="-12.5" crs:CropRight="0.9"`);
    expect(kept.geometry.cropAngle).toBe(-12.5);
  });

  it('falls back rather than clamping an unknown enumerated code', () => {
    const style = parseAttrs(`${CURRENT} crs:PostCropVignetteStyle="9"`);
    expect(style.effects.postCropVignetteStyle).toBe(1);
    expect(style.issues).toEqual([{ tag: 'crs:PostCropVignetteStyle', reason: 'unconvertible', value: '9' }]);

    const orientation = parseAttrs(`${CURRENT} tiff:Orientation="9"`);
    expect(orientation.geometry.orientation).toBeNull();
    expect(orientation.issues).toEqual([{ tag: 'tiff:Orientation', reason: 'unconvertible', value: '9' }]);

    const upright = parseAttrs(`${CURRENT} crs:PerspectiveUpright="7"`);
    expect(upright.geometry.perspectiveUpright).toBe(0);
    expect(upright.issues).toEqual([{ tag: 'crs:PerspectiveUpright', reason: 'unconvertible', value: '7' }]);
  });

  it('carries an absolute-unit crop through and says it cannot be read as fractions', () => {
    const settings = parseAttrs(`${CURRENT} crs:HasCrop="True" crs:CropUnits="1" crs:CropWidth="8" crs:CropHeight="10" crs:CropRight="0.6" crs:CropBottom="0.9"`);
    expect(settings.geometry).toMatchObject({ cropUnits: 1, cropWidth: 8, cropHeight: 10, cropRight: 0.6 });
    expect(settings.issues).toEqual([{ tag: 'crs:CropUnits', reason: 'unconvertible', value: '1' }]);
  });

  it('distinguishes an automatic upright correction from none', () => {
    expect(parseAttrs(`${CURRENT} crs:PerspectiveUpright="3"`).geometry.perspectiveUpright).toBe(3);
    expect(parseAttrs(`${CURRENT} crs:PerspectiveUpright="0"`).geometry.perspectiveUpright).toBe(0);
    expect(parseAttrs(CURRENT).geometry.perspectiveUpright).toBe(0);
  });

  it('records orientation as given and null when absent', () => {
    expect(parseAttrs(`${CURRENT} tiff:Orientation="6"`).geometry.orientation).toBe(6);
    expect(parseAttrs(CURRENT).geometry.orientation).toBeNull();
  });

  it('names the opaque upright payloads without decoding them', () => {
    const settings = parseAttrs(`${CURRENT} crs:PerspectiveUpright="2" crs:UprightVersion="151388160" crs:UprightPreview="False" crs:UprightTransform_0="1.0 0.0" crs:UprightFourSegments_0="0"`);
    expect(settings.geometry.uprightVersion).toBe(151388160);
    expect(settings.unsupported).toContain('crs:UprightTransform_0');
    expect(settings.unsupported).toContain('crs:UprightFourSegments_0');
    expect(settings.unsupported).toContain('crs:UprightPreview');
    expect(JSON.stringify(settings)).not.toContain('1.0 0.0');
  });
});

describe('parseXmp: curves, flags and metadata', () => {
  const IDENTITY = [{ x: 0, y: 0 }, { x: 255, y: 255 }];

  it('reads an identity curve the same however it is written', () => {
    const spaced = parseAttrs(CURRENT, '<crs:ToneCurvePV2012><rdf:Seq><rdf:li>0, 0</rdf:li><rdf:li>255, 255</rdf:li></rdf:Seq></crs:ToneCurvePV2012>');
    const tight = parseAttrs(CURRENT, '<crs:ToneCurvePV2012><rdf:Seq><rdf:li>0,0</rdf:li><rdf:li>255,255</rdf:li></rdf:Seq></crs:ToneCurvePV2012>');
    const absent = parseAttrs(CURRENT);
    expect(spaced.tone.curve).toEqual(IDENTITY);
    expect(tight.tone).toEqual(spaced.tone);
    expect(absent.tone).toEqual(spaced.tone);
  });

  it('parses curve points into numbers and drops malformed ones', () => {
    const settings = parseAttrs(
      CURRENT,
      '<crs:ToneCurvePV2012><rdf:Seq><rdf:li>0, 0</rdf:li><rdf:li>oops</rdf:li><rdf:li>128, 150</rdf:li><rdf:li>255, 255</rdf:li></rdf:Seq></crs:ToneCurvePV2012>',
    );
    expect(settings.tone.curve).toEqual([{ x: 0, y: 0 }, { x: 128, y: 150 }, { x: 255, y: 255 }]);
    expect(settings.issues).toEqual([{ tag: 'crs:ToneCurvePV2012', reason: 'malformed', value: 'oops' }]);
  });

  it('treats a half-written point as malformed rather than as zero', () => {
    const settings = parseAttrs(
      CURRENT,
      '<crs:ToneCurvePV2012Red><rdf:Seq><rdf:li>0,</rdf:li><rdf:li>64, 70</rdf:li><rdf:li>255, 255</rdf:li></rdf:Seq></crs:ToneCurvePV2012Red>',
    );
    expect(settings.tone.curveRed).toEqual([{ x: 64, y: 70 }, { x: 255, y: 255 }]);
    expect(settings.issues).toEqual([{ tag: 'crs:ToneCurvePV2012Red', reason: 'malformed', value: '0,' }]);
  });

  it('falls back to identity when too few points survive', () => {
    const settings = parseAttrs(CURRENT, '<crs:ToneCurvePV2012><rdf:Seq><rdf:li>junk</rdf:li></rdf:Seq></crs:ToneCurvePV2012>');
    expect(settings.tone.curve).toEqual(IDENTITY);
  });

  it('populates both the HSL and the gray mixer sets whatever the conversion flag says', () => {
    const body = 'crs:HueAdjustmentRed="10" crs:SaturationAdjustmentBlue="-20" crs:LuminanceAdjustmentGreen="5" crs:GrayMixerOrange="35"';
    const mono = parseAttrs(`${CURRENT} crs:ConvertToGrayscale="True" ${body}`);
    expect(mono.hsl.convertToGrayscale).toBe(true);
    expect(mono.hsl.hue.red).toBe(10);
    expect(mono.hsl.saturation.blue).toBe(-20);
    expect(mono.hsl.luminance.green).toBe(5);
    expect(mono.hsl.gray.orange).toBe(35);

    const colour = parseAttrs(`${CURRENT} crs:ConvertToGrayscale="False" ${body}`);
    expect(colour.hsl.convertToGrayscale).toBe(false);
    expect(colour.hsl.gray.orange).toBe(35);
    expect(colour.hsl.hue.red).toBe(10);
  });

  it('accepts either spelling of a flag', () => {
    expect(parseAttrs(`${CURRENT} crs:ConvertToGrayscale="true"`).hsl.convertToGrayscale).toBe(true);
    expect(parseAttrs(`${CURRENT} crs:ConvertToGrayscale="1"`).hsl.convertToGrayscale).toBe(true);
    expect(parseAttrs(`${CURRENT} crs:ConvertToGrayscale="0"`).hsl.convertToGrayscale).toBe(false);
    const bad = parseAttrs(`${CURRENT} crs:ConvertToGrayscale="maybe"`);
    expect(bad.hsl.convertToGrayscale).toBe(false);
    expect(bad.issues).toEqual([{ tag: 'crs:ConvertToGrayscale', reason: 'unparseable', value: 'maybe' }]);
  });

  it('imports every setting of an already-applied file and flags it', () => {
    const edit = 'crs:Exposure2012="+1.00" crs:Texture="30" crs:Temperature="5200" crs:GrainAmount="8"'
      + ' crs:HueAdjustmentRed="12" crs:Sharpness="60" crs:HasCrop="True" crs:CropRight="0.7" crs:ShadowTint="4"';
    const applied = parseAttrs(`${CURRENT} crs:HasSettings="True" crs:AlreadyApplied="True" ${edit}`);
    const pending = parseAttrs(`${CURRENT} crs:HasSettings="True" ${edit}`);
    expect(applied.alreadyApplied).toBe(true);
    expect(pending.alreadyApplied).toBe(false);
    // The flag is the only difference: the values still describe the file, and
    // dropping them would lose the description of how it was produced.
    expect({ ...applied, alreadyApplied: false }).toEqual(pending);
    expect(applied.tone.exposure).toBe(1);
  });

  it('keeps the wall clock of a zoneless date and normalises Z', () => {
    const settings = parseAttrs(`${CURRENT} xmp:CreateDate="2024-03-11T10:22:33" xmp:ModifyDate="2024-03-11T10:22:33+11:00" xmp:MetadataDate="2024-03-11T10:22:33Z"`);
    expect(settings.metadata.createDate).toEqual({ value: '2024-03-11T10:22:33', offset: null });
    expect(settings.metadata.modifyDate).toEqual({ value: '2024-03-11T10:22:33', offset: '+11:00' });
    expect(settings.metadata.metadataDate).toEqual({ value: '2024-03-11T10:22:33', offset: '+00:00' });
  });

  it('reports an unparseable date as null', () => {
    const settings = parseAttrs(`${CURRENT} xmp:CreateDate="last tuesday"`);
    expect(settings.metadata.createDate).toBeNull();
    expect(settings.issues).toEqual([{ tag: 'xmp:CreateDate', reason: 'unparseable', value: 'last tuesday' }]);
  });

  it('refuses a date whose digits are in range only as digits', () => {
    const settings = parseAttrs(`${CURRENT} xmp:CreateDate="2024-13-45T99:99" xmp:ModifyDate="2024-02"`);
    expect(settings.metadata.createDate).toBeNull();
    expect(settings.issues).toEqual([{ tag: 'xmp:CreateDate', reason: 'unparseable', value: '2024-13-45T99:99' }]);
    expect(settings.metadata.modifyDate).toEqual({ value: '2024-02', offset: null });
  });

  it('reads both keyword tags, the rating and the sidecar filenames', () => {
    const settings = parseAttrs(
      `${CURRENT} xmp:Rating="-1" xmp:Label="Red" photoshop:SidecarForExtension="CR2" crs:RawFileName="IMG_1234.CR2"`,
      '<dc:subject><rdf:Bag><rdf:li>owl</rdf:li><rdf:li>dusk</rdf:li></rdf:Bag></dc:subject>'
        + '<lr:hierarchicalSubject><rdf:Bag><rdf:li>Animals|Birds|Owl</rdf:li></rdf:Bag></lr:hierarchicalSubject>'
        + '<dc:creator><rdf:Seq><rdf:li>A Photographer</rdf:li></rdf:Seq></dc:creator>',
    );
    expect(settings.metadata.rating).toBe(-1);
    expect(settings.metadata.label).toBe('Red');
    expect(settings.metadata.subject).toEqual(['owl', 'dusk']);
    expect(settings.metadata.hierarchicalSubject).toEqual(['Animals|Birds|Owl']);
    expect(settings.metadata.creator).toEqual(['A Photographer']);
    expect(settings.metadata.sidecarForExtension).toBe('CR2');
    expect(settings.metadata.rawFileName).toBe('IMG_1234.CR2');
  });

  it('records a camera profile as a reference without resolving it', () => {
    const settings = parseAttrs(`${CURRENT} crs:CameraProfile="Camera Standard" crs:CameraProfileDigest="54650A341B5B5CCAE8442D0B43A92BCE"`);
    expect(settings.profile).toEqual({ cameraProfile: 'Camera Standard', cameraProfileDigest: '54650A341B5B5CCAE8442D0B43A92BCE' });
  });
});

describe('parseXmp: unsupported tags', () => {
  it('skips an unknown crs property, names it, and still imports the file', () => {
    const settings = parseAttrs(`${CURRENT} crs:Exposure2012="+0.20" crs:SomeFutureFeature="42"`);
    expect(settings.tone.exposure).toBe(0.2);
    expect(settings.unsupported).toEqual(['crs:SomeFutureFeature']);
  });

  it('names a mask group without storing any of its contents', () => {
    const settings = parseAttrs(
      `${CURRENT} crs:Exposure2012="+0.20"`,
      '<crs:MaskGroupBasedCorrections><rdf:Seq><rdf:li rdf:parseType="Resource">'
        + '<crs:CorrectionAmount>1</crs:CorrectionAmount><crs:LocalExposure2012>0.75</crs:LocalExposure2012>'
        + '</rdf:li></rdf:Seq></crs:MaskGroupBasedCorrections>',
    );
    expect(settings.tone.exposure).toBe(0.2);
    expect(settings.unsupported).toEqual(['crs:MaskGroupBasedCorrections']);
    expect(JSON.stringify(settings)).not.toContain('LocalExposure');
  });

  it('does not name properties outside the crs namespace', () => {
    const settings = parseAttrs(`${CURRENT} xmpMM:DocumentID="xmp.did:1234" exif:FNumber="4/1" xmp:Rating="3"`);
    expect(settings.unsupported).toEqual([]);
    expect(settings.metadata.rating).toBe(3);
  });

  it('names the parts of a Look it declines, and keeps LookName separate', () => {
    const settings = parseAttrs(
      `${CURRENT} crs:LookName="Adobe Landscape"`,
      '<crs:Look rdf:parseType="Resource"><crs:Name>Adobe Landscape</crs:Name><crs:Amount>1</crs:Amount>'
        + '<crs:Something>x</crs:Something>'
        + '<crs:Parameters rdf:parseType="Resource"><crs:Version>13.2</crs:Version><crs:LookTable>E1095149FDB39D7A057BAB208837E2E1</crs:LookTable></crs:Parameters>'
        + '</crs:Look>',
    );
    expect(settings.look?.name).toBe('Adobe Landscape');
    expect(settings.unsupported).toEqual(['crs:Look/crs:Parameters', 'crs:Look/crs:Something', 'crs:LookName']);
    expect(JSON.stringify(settings)).not.toContain('E1095149FDB39D7A057BAB208837E2E1');
  });

  it('sorts and deduplicates the names across merged descriptions', () => {
    const settings = parse(
      `${description(`${CURRENT} crs:RetouchAreas="a" crs:PointColors="b"`)}\n${description('crs:RetouchAreas="a" crs:HDREditMode="1"')}`,
    );
    expect(settings.unsupported).toEqual(['crs:HDREditMode', 'crs:PointColors', 'crs:RetouchAreas']);
  });

  it('has no look at all when the structure is absent', () => {
    expect(parseAttrs(CURRENT).look).toBeNull();
  });

  it('reports a Look written in a serialisation it cannot read rather than losing it', () => {
    // Neither `rdf:parseType="Resource"` nor a nested `rdf:Description`, so the
    // fields are unreachable - but the file still carries a look, and saying so
    // is the difference between an incomplete import and a silently wrong one.
    const loose = parseAttrs(CURRENT, '<crs:Look><crs:Name>Adobe Color</crs:Name></crs:Look>');
    expect(loose.look).toBeNull();
    expect(loose.unsupported).toEqual(['crs:Look']);

    const scalar = parseAttrs(`${CURRENT} crs:Look="Adobe Color"`);
    expect(scalar.look).toBeNull();
    expect(scalar.unsupported).toEqual(['crs:Look']);
  });
});

// A whole sidecar rather than one tag at a time: scalars as attributes, curves
// and keywords as elements, a Look, a mask group, and the properties split
// across two rdf:Description blocks the way a writer groups them by namespace.
describe('parseXmp: a whole sidecar', () => {
  const settings = parse(`${description(
    'crs:Version="15.1" crs:ProcessVersion="15.4" crs:HasSettings="True" crs:WhiteBalance="Custom"'
      + ' crs:Temperature="5850" crs:Tint="+12" crs:Exposure2012="+0.45" crs:Contrast2012="+8" crs:Highlights2012="-40"'
      + ' crs:Shadows2012="+35" crs:Whites2012="+10" crs:Blacks2012="-15" crs:Texture="+12" crs:Clarity2012="+6"'
      + ' crs:Dehaze="+7.5" crs:Vibrance="+18" crs:Saturation="-4" crs:ParametricShadows="+5" crs:ParametricHighlightSplit="80"'
      + ' crs:Sharpness="55" crs:SharpenRadius="1.2" crs:LuminanceSmoothing="18" crs:ColorNoiseReduction="30"'
      + ' crs:HueAdjustmentOrange="-8" crs:SaturationAdjustmentAqua="+14" crs:LuminanceAdjustmentBlue="-22"'
      + ' crs:SplitToningShadowHue="215" crs:SplitToningShadowSaturation="14" crs:ColorGradeMidtoneLum="-3"'
      + ' crs:LensProfileEnable="1" crs:LensProfileName="Canon EF 24-70mm f/2.8L II USM" crs:AutoLateralCA="True"'
      + ' crs:PostCropVignetteAmount="-18" crs:PostCropVignetteStyle="2" crs:GrainAmount="12"'
      + ' crs:ShadowTint="+3" crs:BlueHue="-6"'
      + ' crs:HasCrop="True" crs:CropTop="0.05" crs:CropLeft="0.02" crs:CropBottom="0.95" crs:CropRight="0.98"'
      + ' crs:CropAngle="-1.75" crs:PerspectiveVertical="-12" crs:PerspectiveUpright="1" crs:UprightVersion="151388160"'
      + ' crs:UprightTransform_0="0.998, 0.0" crs:CameraProfile="Adobe Color" crs:RawFileName="IMG_1234.CR2"',
    '<crs:ToneCurvePV2012><rdf:Seq><rdf:li>0, 0</rdf:li><rdf:li>64, 56</rdf:li><rdf:li>192, 200</rdf:li><rdf:li>255, 255</rdf:li></rdf:Seq></crs:ToneCurvePV2012>'
      + '<crs:Look rdf:parseType="Resource"><crs:Name>Adobe Color</crs:Name><crs:Amount>1</crs:Amount>'
      + '<crs:UUID>B952C231111CD8E0ECCF14B86BAA7077</crs:UUID>'
      + '<crs:Group><rdf:Alt><rdf:li xml:lang="x-default">Profiles</rdf:li></rdf:Alt></crs:Group></crs:Look>'
      + '<crs:MaskGroupBasedCorrections><rdf:Seq><rdf:li rdf:parseType="Resource"><crs:CorrectionAmount>1</crs:CorrectionAmount></rdf:li></rdf:Seq></crs:MaskGroupBasedCorrections>',
  )}
${description(
    'tiff:Orientation="1" xmp:Rating="4" xmp:Label="Green" xmp:CreateDate="2025-11-02T17:41:09+11:00"'
      + ' photoshop:DateCreated="2025-11-02T17:41:09+11:00" photoshop:SidecarForExtension="CR2"',
    '<dc:subject><rdf:Bag><rdf:li>owl</rdf:li><rdf:li>dusk</rdf:li></rdf:Bag></dc:subject>'
      + '<lr:hierarchicalSubject><rdf:Bag><rdf:li>Animals|Birds|Owl</rdf:li></rdf:Bag></lr:hierarchicalSubject>',
  )}`);

  it('resolves the versions', () => {
    expect(settings.processVersion).toEqual({ generation: 6, raw: '15.4' });
    expect(settings.crsVersion).toBe('15.1');
    expect(settings.legacy).toBe(false);
    expect(settings.legacyTone).toBeNull();
    expect(settings.hasSettings).toBe(true);
    expect(settings.alreadyApplied).toBe(false);
  });

  it('reads the develop settings', () => {
    expect(settings.whiteBalance).toEqual({ mode: 'Custom', temperature: 5850, tint: 12, incrementalTemperature: 0, incrementalTint: 0 });
    expect(settings.tone).toMatchObject({ exposure: 0.45, contrast: 8, highlights: -40, shadows: 35, whites: 10, blacks: -15 });
    expect(settings.tone.curve).toEqual([{ x: 0, y: 0 }, { x: 64, y: 56 }, { x: 192, y: 200 }, { x: 255, y: 255 }]);
    expect(settings.tone.parametricHighlightSplit).toBe(80);
    expect(settings.presence).toEqual({ texture: 12, clarity: 6, dehaze: 7.5, vibrance: 18, saturation: -4 });
    expect(settings.hsl.hue.orange).toBe(-8);
    expect(settings.hsl.saturation.aqua).toBe(14);
    expect(settings.hsl.luminance.blue).toBe(-22);
    expect(settings.detail).toMatchObject({ sharpness: 55, sharpenRadius: 1.2, luminanceSmoothing: 18, colorNoiseReduction: 30 });
    expect(settings.colorGrading).toMatchObject({ splitToningShadowHue: 215, splitToningShadowSaturation: 14, colorGradeMidtoneLuminance: -3 });
    expect(settings.lens).toMatchObject({ lensProfileEnable: true, lensProfileName: 'Canon EF 24-70mm f/2.8L II USM', autoLateralCA: true });
    expect(settings.effects).toMatchObject({ postCropVignetteAmount: -18, postCropVignetteStyle: 2, grainAmount: 12 });
    expect(settings.calibration).toMatchObject({ shadowTint: 3, blueHue: -6 });
    expect(settings.profile.cameraProfile).toBe('Adobe Color');
    expect(settings.look).toMatchObject({ name: 'Adobe Color', amount: 1, group: 'Profiles' });
  });

  it('reads the geometry and the metadata off both descriptions', () => {
    expect(settings.geometry).toMatchObject({
      orientation: 1,
      hasCrop: true,
      cropTop: 0.05,
      cropLeft: 0.02,
      cropBottom: 0.95,
      cropRight: 0.98,
      cropAngle: -1.75,
      perspectiveVertical: -12,
      perspectiveUpright: 1,
      uprightVersion: 151388160,
    });
    expect(settings.metadata).toMatchObject({
      rating: 4,
      label: 'Green',
      createDate: { value: '2025-11-02T17:41:09', offset: '+11:00' },
      subject: ['owl', 'dusk'],
      hierarchicalSubject: ['Animals|Birds|Owl'],
      sidecarForExtension: 'CR2',
      rawFileName: 'IMG_1234.CR2',
    });
  });

  it('names what it declined and reports nothing else', () => {
    expect(settings.unsupported).toEqual(['crs:MaskGroupBasedCorrections', 'crs:UprightTransform_0']);
    expect(settings.issues).toEqual([]);
  });
});
