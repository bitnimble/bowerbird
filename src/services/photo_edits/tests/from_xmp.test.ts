import { describe, expect, it } from 'bun:test';
import { parseXmp } from '../../processing/xmp/xmp';
import type { XmpSettings } from '../../processing/xmp/xmp_schema';
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

/** `children` for the properties Camera Raw writes as elements rather than attributes. */
function parse(attrs: string, children = ''): XmpSettings {
  const settings = parseXmp(`<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" ${NS} ${attrs}>${children}</rdf:Description>
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

  it('takes the crop only where the file says it has one', () => {
    const edges = 'crs:CropTop="0.1" crs:CropLeft="0.2" crs:CropBottom="0.8" crs:CropRight="0.9" crs:CropAngle="3"';

    const cropped = editsFromXmp(parse(`${CURRENT} crs:Exposure2012="0.5" crs:HasCrop="True" ${edges}`));
    expect(cropped.doc).toMatchObject({
      cropTop: 0.1,
      cropLeft: 0.2,
      cropBottom: 0.8,
      cropRight: 0.9,
      cropAngle: 3,
    });

    // `crs:HasCrop` is authoritative and the edges are stale without it: a crop the reader
    // undid routinely leaves non-default values behind, so importing them would re-crop a
    // photo they had uncropped. The straighten goes with them for the same reason.
    const undone = editsFromXmp(parse(`${CURRENT} crs:Exposure2012="0.5" ${edges}`));
    expect(undone.doc).toMatchObject({ cropTop: 0, cropLeft: 0, cropBottom: 1, cropRight: 1, cropAngle: 0 });
  });

  it('takes the era-independent half of a pre-2012 file whose tone was never touched', () => {
    // What every legacy sidecar in a 470-file library actually looked like: an old
    // catalogue, a crop, and tone controls nobody moved. Refusing the lot threw away a
    // crop that means the same fractions in 2010 as now, and explained itself by naming
    // a process version the reader never chose.
    const { doc, reasons } = editsFromXmp(
      parse('crs:HasCrop="True" crs:CropTop="0.1" crs:CropLeft="0.2" crs:CropBottom="0.9" crs:CropRight="0.8"'),
    );

    expect(doc).toMatchObject({ cropTop: 0.1, cropLeft: 0.2, cropBottom: 0.9, cropRight: 0.8 });
    // Said rather than done silently: the file is still old, and the reader should know
    // which half of it arrived.
    expect(reasons.join(' ')).toMatch(/tone controls are untouched/);
  });

  it('still declines a pre-2012 file that curved its tone, whatever else it holds', () => {
    // A custom curve leaves `crs:ToneCurveName` behind - it reads "Custom" or stays
    // "Linear" depending on the writer - so the points are what says it moved. Without
    // that, a curved legacy file would import as a crop and lose its whole grade.
    const { doc, reasons } = editsFromXmp(
      parse(
        'crs:HasCrop="True" crs:CropRight="0.8"',
        '<crs:ToneCurve><rdf:Seq><rdf:li>0, 0</rdf:li><rdf:li>128, 200</rdf:li>' +
          '<rdf:li>255, 255</rdf:li></rdf:Seq></crs:ToneCurve>',
      ),
    );

    expect(doc).toBeNull();
    expect(reasons.join(' ')).toMatch(/predates process version 2012/);
  });

  it('declines a crop stated in absolute units rather than guessing at the frame', () => {
    const { doc, reasons } = editsFromXmp(
      parse(`${CURRENT} crs:Exposure2012="0.5" crs:HasCrop="True" crs:CropRight="0.5" crs:CropUnits="1"`),
    );

    // Inches or centimetres mean the fractions are not the whole story, and converting
    // needs dimensions neither this layer nor the parser has.
    expect(doc?.cropRight).toBe(1);
    expect(reasons.join(' ')).toMatch(/absolute units/);
  });

  it('leaves everything it does not set at neutral', () => {
    const { doc } = editsFromXmp(parse(`${CURRENT} crs:Exposure2012="2.0"`));

    const { exposure, ...rest } = doc!;
    const { exposure: _neutralExposure, ...neutralRest } = neutralEdits();
    expect(exposure).toBe(2.0);
    expect(rest).toEqual(neutralRest);
  });
});
