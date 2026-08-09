import { describe, expect, it } from 'bun:test';
import { parseXmp } from '../../processing/xmp';
import type { XmpSettings } from '../../processing/xmp_schema';
import { editsFromXmp } from '../from_xmp';
import { neutralEdits } from '../../../schemas/photo_edits';

// A real sidecar through the real parser: this mapping's whole claim is that it is
// a pick rather than a conversion, and constructing the struct by hand would let a
// name drift on the parser's side without anything here noticing.
const NS = [
  'xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"',
  'xmlns:tiff="http://ns.adobe.com/tiff/1.0/"',
  'xmlns:xmp="http://ns.adobe.com/xap/1.0/"',
].join(' ');

// As Camera Raw writes it: `crs:HasSettings` defaults to false when absent, so a
// realistic fixture states it.
const CURRENT = 'crs:ProcessVersion="6.7" crs:Version="13.2" crs:HasSettings="True"';

function parse(attrs: string): XmpSettings {
  const settings = parseXmp(`<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" ${NS} ${attrs}></rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`);
  if (settings == null) throw new Error('fixture did not parse');
  return settings;
}

describe('editsFromXmp', () => {
  it('carries the tone and presence sliders across at the values the file states', () => {
    const { doc, reasons } = editsFromXmp(
      parse(
        `${CURRENT} crs:Exposure2012="1.35" crs:Contrast2012="20" crs:Highlights2012="-40"
         crs:Shadows2012="15" crs:Whites2012="8" crs:Blacks2012="-12"
         crs:Texture="10" crs:Clarity2012="5" crs:Dehaze="25" crs:Vibrance="30" crs:Saturation="-5"`,
      ),
    );

    // No arithmetic anywhere: the ranges are shared, so a wrong constant has
    // nowhere to hide. This is the property the schema exists to have.
    expect(doc).toMatchObject({
      exposure: 1.35,
      contrast: 20,
      highlights: -40,
      shadows: 15,
      whites: 8,
      blacks: -12,
      texture: 10,
      clarity: 5,
      dehaze: 25,
      vibrance: 30,
      saturation: -5,
    });
    expect(reasons).toEqual([]);
  });

  it('takes a custom white balance as the pair, and leaves as-shot null', () => {
    const custom = editsFromXmp(
      parse(`${CURRENT} crs:WhiteBalance="Custom" crs:Temperature="5400" crs:Tint="12"`),
    );
    expect(custom.doc).toMatchObject({ whiteBalanceMode: 'Custom', temperature: 5400, tint: 12 });

    const asShot = editsFromXmp(parse(`${CURRENT} crs:WhiteBalance="As Shot"`));
    // Null rather than a number this layer invents: the right value is the neutral
    // the body recorded, which nothing here can see.
    expect(asShot.doc).toMatchObject({ whiteBalanceMode: 'As Shot', temperature: null, tint: null });
  });

  it('refuses half a white balance rather than importing a colour cast', () => {
    const { doc, reasons } = editsFromXmp(
      parse(`${CURRENT} crs:WhiteBalance="Custom" crs:Temperature="5400"`),
    );

    expect(doc?.temperature).toBeNull();
    expect(doc?.tint).toBeNull();
    expect(reasons.join(' ')).toMatch(/only one of temperature and tint/);
  });

  it('says so when the white balance is the relative kind written for a JPEG', () => {
    const { doc, reasons } = editsFromXmp(
      parse(`${CURRENT} crs:IncrementalTemperature="20" crs:IncrementalTint="-5"`),
    );

    expect(doc).not.toBeNull();
    expect(reasons.join(' ')).toMatch(/non-raw sources/);
  });

  it('declines a sidecar carrying no develop settings', () => {
    const { doc, reasons } = editsFromXmp(parse('xmp:Rating="4"'));

    expect(doc).toBeNull();
    expect(reasons.join(' ')).toMatch(/no develop settings/);
  });

  it('declines settings already baked into the pixels', () => {
    const { doc, reasons } = editsFromXmp(
      parse(`${CURRENT} crs:Exposure2012="1.0" crs:AlreadyApplied="True"`),
    );

    // Applying them again double-processes the picture, which is a worse outcome
    // than importing nothing.
    expect(doc).toBeNull();
    expect(reasons.join(' ')).toMatch(/double-process/);
  });

  it('declines a pre-2012 file rather than approximating its controls', () => {
    const { doc, reasons } = editsFromXmp(
      parse(
        'crs:ProcessVersion="5.7" crs:Version="6.0" crs:HasSettings="True" crs:Exposure="0.75" crs:Brightness="50"',
      ),
    );

    // `Brightness` and `FillLight` have no 2012 equivalent, and `xmp_schema.ts`
    // keeps `legacyTone` out of `tone` precisely so this layer can tell and refuse.
    expect(doc).toBeNull();
    expect(reasons.join(' ')).toMatch(/predates process version 2012/);
  });

  it('names what it read and could not carry', () => {
    const { doc, unsupported } = editsFromXmp(
      parse(`${CURRENT} crs:Exposure2012="0.5" crs:ParametricShadows="15" crs:ToneCurveName="Strong Contrast"`),
    );

    expect(doc?.exposure).toBe(0.5);
    // A reader who imported a heavily graded frame and got only its sliders is
    // owed the list of what did not come with them. The curve name arrives from
    // the parser's own tally; the parametric curve is one this layer has to add,
    // because the parser *did* read it and only we know it has nowhere to land.
    expect(unsupported.join(' ')).toMatch(/parametric curve/);
    expect(unsupported.join(' ')).toMatch(/crs:ToneCurveName/);
  });

  it('leaves everything it does not set at neutral', () => {
    const { doc } = editsFromXmp(parse(`${CURRENT} crs:Exposure2012="2.0"`));

    const { exposure, ...rest } = doc!;
    const { exposure: _neutralExposure, ...neutralRest } = neutralEdits();
    expect(exposure).toBe(2.0);
    expect(rest).toEqual(neutralRest);
  });
});
