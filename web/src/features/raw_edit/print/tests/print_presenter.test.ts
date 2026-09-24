import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { drawnBy, GRADE, openEditor, openedWith, type Editor } from '../../stage/tests/raw_edit_harness';
import { REWINDOW_QUIET_MS } from '../../stage/raw_edit_presenter';
import { regionOf } from '../../../photos/viewer/zoom_pan';
import { DEFAULT_PRINT_SCENE, printDisplaySize, PrintSceneSchema } from '../print_scene';

let editor: Editor;
beforeEach(() => { editor = openEditor(); });
afterEach(() => editor.presenter.close());

describe('print viewing', () => {
  test('framed display sizes match the native uniform-border fixture', async () => {
    const table = await Bun.file(new URL('../../../../../../test/fixtures/tables/print-frame-size.txt', import.meta.url).pathname).text();
    const rows = table.trim().split('\n');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const [width = 0, height = 0, framedWidth = 0, framedHeight = 0] = row.trim().split(/\s+/).map(Number);
      const photo = { width, height };
      expect(printDisplaySize(photo, true)).toEqual({ width: framedWidth, height: framedHeight });
      expect(printDisplaySize(photo, false)).toEqual(photo);
    }
  });

  test('surface framing fits its outer dimensions and zooms in outer-frame coordinates', async () => {
    editor.presenter.print.setTouch(true);
    editor.presenter.print.setFramed(true);
    editor.presenter.setSoftProof('print3d');
    await drawnBy(editor);
    expect(editor.presenter.displaySize).toEqual({ width: 4750, height: 3750 });
    expect(editor.decoder.frames.at(-1)?.region).toEqual({ x: 0, y: 0, width: 4750, height: 3750 });
    expect(editor.decoder.stage.width / editor.decoder.stage.height).toBeCloseTo(4750 / 3750, 2);
    expect(editor.decoder.frames.at(-1)?.output).toEqual({ width: 4000, height: 3000 });

    const zoom = regionOf({ scale: 2, x: 0, y: 0 }, { width: 1000, height: 750 }, editor.presenter.displaySize);
    editor.presenter.showRegion(zoom);
    await drawnBy(editor);
    expect(editor.decoder.frames.at(-1)?.region).toEqual({ x: 1125, y: 937.5, width: 2500, height: 1875 });

    editor.presenter.showRegion({ x: 9000, y: 9000, width: 1000, height: 750 });
    await drawnBy(editor);
    expect(editor.decoder.frames.at(-1)?.region).toEqual({ x: 3750, y: 3000, width: 1000, height: 750 });
    editor.presenter.print.setControl('keyLux', 2000);
    editor.presenter.print.resetTilt();
    await drawnBy(editor);
    expect(editor.decoder.frames.at(-1)?.region).toEqual({ x: 3750, y: 3000, width: 1000, height: 750 });

    editor.presenter.print.setFramed(false);
    await drawnBy(editor);
    expect(editor.presenter.displaySize).toEqual({ width: 4000, height: 3000 });
    expect(editor.decoder.frames.at(-1)?.region).toEqual({ x: 0, y: 0, width: 4000, height: 3000 });
    expect(editor.decoder.stage.width / editor.decoder.stage.height).toBeCloseTo(4 / 3, 2);
  });

  test('surface framing follows crop and rotation, and leaving Print restores photo dimensions', async () => {
    editor.presenter.print.setTouch(true);
    editor.presenter.setSoftProof('print3d');
    editor.presenter.print.setFramed(true);
    editor.presenter.preview({ cropRight: 0.5 });
    await drawnBy(editor);
    expect(editor.presenter.displaySize).toEqual({ width: 2500, height: 3500 });
    expect(editor.decoder.frames.at(-1)?.region).toEqual({ x: 0, y: 0, width: 2500, height: 3500 });
    expect(editor.decoder.stage.width / editor.decoder.stage.height).toBeCloseTo(2500 / 3500, 2);
    expect(editor.decoder.geometry?.crop).toEqual([0, 0, 0.5, 1]);

    editor.presenter.preview({ rotate: 90 });
    await drawnBy(editor);
    expect(editor.presenter.displaySize).toEqual({ width: 3500, height: 2500 });
    expect(editor.decoder.frames.at(-1)?.region).toEqual({ x: 0, y: 0, width: 3500, height: 2500 });

    editor.presenter.setSoftProof('hdr');
    await drawnBy(editor);
    expect(editor.presenter.displaySize).toEqual({ width: 3000, height: 2000 });
    expect(editor.decoder.frames.at(-1)?.region).toEqual({ x: 0, y: 0, width: 3000, height: 2000 });
    expect(editor.decoder.stage.width / editor.decoder.stage.height).toBeCloseTo(3 / 2, 2);

    editor.presenter.setSoftProof('print3d');
    await drawnBy(editor);
    expect(editor.presenter.displaySize).toEqual({ width: 3500, height: 2500 });
    editor.presenter.print.setTouch(false);
    await drawnBy(editor);
    expect(editor.presenter.displaySize).toEqual({ width: 3000, height: 2000 });
    expect(editor.decoder.frames.at(-1)?.region).toEqual({ x: 0, y: 0, width: 3000, height: 2000 });
    expect(editor.decoder.stage.width / editor.decoder.stage.height).toBeCloseTo(4 / 3, 2);
  });

  test('frame choice redraws and survives paper and presentation changes', async () => {
    editor.presenter.setSoftProof('print3d');
    await drawnBy(editor);
    expect(editor.decoder.print?.framed).toBe(false);

    editor.presenter.print.setFramed(true);
    await drawnBy(editor);
    expect(editor.decoder.print?.framed).toBe(true);

    editor.presenter.print.setPaper('gloss');
    editor.presenter.print.setTouch(true);
    await drawnBy(editor);
    expect(editor.decoder.print).toMatchObject({ paper: 'gloss', presentation: 'surface', framed: true });

    editor.presenter.print.setTouch(false);
    editor.presenter.setSoftProof('hdr');
    editor.presenter.setSoftProof('print3d');
    await drawnBy(editor);
    expect(editor.decoder.print).toMatchObject({ presentation: 'scene', framed: true });

    editor.presenter.print.setFramed(false);
    await drawnBy(editor);
    expect(editor.decoder.print?.framed).toBe(false);
  });

  test('a reset puts a control back where the chosen paper keeps it, or the default scene for the rest', () => {
    editor.presenter.setSoftProof('print3d');
    editor.presenter.print.setPaper('gloss');
    editor.presenter.print.setControl('roughness', 0.4);
    editor.presenter.print.setControl('keyLux', 2500);
    editor.presenter.print.setControl('lightForward', 4);
    editor.presenter.print.resetControl('roughness');
    editor.presenter.print.resetControl('keyLux');
    editor.presenter.print.resetControl('lightForward');
    expect(editor.print.scene).toMatchObject({ paper: 'gloss', roughness: 0.16, keyLux: 1000, lightForward: 1.7 });
  });

  test('choosing a paper replaces every material control a reader moved, and leaves the rest', () => {
    editor.presenter.setSoftProof('print3d');
    editor.presenter.print.setControl('refractiveIndex', 1.8);
    editor.presenter.print.setControl('surfaceTexture', 0.9);
    editor.presenter.print.setControl('keyLux', 2500);
    editor.presenter.print.setPaper('matte');
    expect(editor.print.scene).toMatchObject({
      paper: 'matte', refractiveIndex: 1.5, surfaceTexture: 0, roughness: 0.84, keyLux: 2500,
    });
  });

  test('the lamp never comes nearer the sheet than a print length', () => {
    editor.presenter.setSoftProof('print3d');
    editor.presenter.print.setControl('lightHeight', 0.5);
    editor.presenter.print.setControl('lightForward', 0.5);
    expect(editor.print.scene).toMatchObject({ lightHeight: 0.5, lightForward: 1.7 });
  });

  test('print framing defaults off and rejects non-boolean values', () => {
    expect(PrintSceneSchema.parse({ ...DEFAULT_PRINT_SCENE, framed: undefined }).framed).toBe(false);
    expect(PrintSceneSchema.safeParse({ ...DEFAULT_PRINT_SCENE, framed: 1 }).success).toBe(false);
  });

  test('backend print requests coverage only when effective surface framing changes', async () => {
    openedWith(editor, { local: { decoder: editor.decoder, open: { longEdge: 0, grade: GRADE, defringe: 0.5 }, onTheBackend: true } });
    editor.stage.preparedElsewhere = true;
    const coverage: boolean[] = [];
    editor.presenter.rewindow = async () => {
      coverage.push(editor.decoder.print?.presentation === 'surface' && editor.decoder.print.framed);
    };
    const settled = async (): Promise<void> => {
      await drawnBy(editor);
      await new Promise((resolve) => setTimeout(resolve, REWINDOW_QUIET_MS + 30));
    };

    editor.presenter.print.setTouch(true);
    editor.presenter.setSoftProof('print3d');
    await settled();
    expect(coverage).toEqual([]);

    editor.presenter.print.setFramed(true);
    await settled();
    expect(coverage).toEqual([true]);

    editor.presenter.print.setPaper('gloss');
    editor.presenter.print.setControl('keyLux', 3000);
    editor.presenter.print.setControl('fillLux', 600);
    editor.presenter.print.setFramed(true);
    editor.presenter.print.resetTilt();
    editor.presenter.print.resetTilt();
    await settled();
    expect(coverage).toEqual([true]);

    editor.presenter.setSoftProof('hdr');
    await settled();
    expect(coverage).toEqual([true, false]);

    editor.presenter.setSoftProof('print3d');
    await settled();
    expect(coverage).toEqual([true, false, true]);

    editor.presenter.print.setTouch(false);
    await settled();
    expect(coverage).toEqual([true, false, true, false]);
  });

  test('backend print waits for a queued framing change to land before requesting coverage', async () => {
    openedWith(editor, { local: { decoder: editor.decoder, open: { longEdge: 0, grade: GRADE, defringe: 0.5 }, onTheBackend: true } });
    editor.stage.preparedElsewhere = true;
    const coverage: boolean[] = [];
    editor.presenter.rewindow = async () => {
      coverage.push(editor.decoder.print?.presentation === 'surface' && editor.decoder.print.framed);
    };
    let release = (): void => { throw new Error('no pending draw'); };
    const pending = new Promise<void>((resolve) => { release = resolve; });
    editor.decoder.landed = () => pending;
    editor.presenter.print.setTouch(true);
    editor.presenter.setSoftProof('print3d');
    await drawnBy(editor);

    editor.presenter.print.setFramed(true);
    await drawnBy(editor);
    await new Promise((resolve) => setTimeout(resolve, REWINDOW_QUIET_MS + 30));
    expect(editor.decoder.print?.framed).toBe(false);
    expect(coverage).toEqual([]);

    editor.decoder.landed = () => Promise.resolve();
    release();
    await Promise.resolve();
    await drawnBy(editor);
    expect(editor.decoder.print?.framed).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, REWINDOW_QUIET_MS + 30));
    expect(coverage).toEqual([true]);
  });

  test('draws a print of the edited crop without changing the photo document', async () => {
    editor.presenter.preview({ exposure: 1.25, cropLeft: 0.2, rotate: 90 });
    const doc = JSON.stringify(editor.edit.doc);
    editor.presenter.setSoftProof('print3d');
    await drawnBy(editor);
    expect(editor.decoder.print).toEqual(DEFAULT_PRINT_SCENE);
    expect(editor.stage.renderedMode).toBe('print');
    expect(editor.decoder.exposure).toBe(1.25);
    expect(editor.decoder.geometry?.crop[0]).toBe(0.2);
    expect(editor.decoder.geometry?.rotate).toBe(90);
    expect(JSON.stringify(editor.edit.doc)).toBe(doc);

    editor.presenter.print.setPaper('matte');
    editor.presenter.print.setControl('keyLux', 2340);
    editor.presenter.print.setControl('refractiveIndex', 1.46);
    editor.presenter.print.setControl('lightForward', 2.5);
    editor.presenter.print.setControl('paperLongEdgeMm', 420);
    editor.presenter.print.setControl('lightTemperatureKelvin', 2700);
    await drawnBy(editor);
    expect(editor.decoder.print).toMatchObject({
      paper: 'matte', roughness: 0.84, keyLux: 2340, refractiveIndex: 1.46,
      lightForward: 2.5, paperLongEdgeMm: 420, surfaceTexture: 0, lightTemperatureKelvin: 2700,
    });
    expect(JSON.stringify(editor.edit.doc)).toBe(doc);
  });

  test('uses the viewport aspect for the 3D scene and restores photo framing', async () => {
    editor.presenter.preview({ cropRight: 0.25 });
    await drawnBy(editor);
    const photo = { ...editor.decoder.stage };
    editor.presenter.setSoftProof('print3d');
    await drawnBy(editor);
    expect(editor.decoder.stage.width / editor.decoder.stage.height).toBeCloseTo(800 / 600, 2);
    editor.presenter.setSoftProof('hdr');
    await drawnBy(editor);
    expect(editor.decoder.print).toBeNull();
    expect(editor.stage.renderedMode).toBe('photo');
    expect(editor.decoder.stage).toEqual(photo);
  });

  test('surface print keeps the normal editor framing and ignores drag rotation', async () => {
    editor.presenter.preview({ cropRight: 0.25 });
    await drawnBy(editor);
    const photo = { ...editor.decoder.stage };
    editor.presenter.print.setTouch(true);
    editor.presenter.setSoftProof('print3d');
    await drawnBy(editor);
    expect(editor.decoder.stage).toEqual(photo);
    expect(editor.decoder.print).toMatchObject({ presentation: 'surface', yawDegrees: 0, pitchDegrees: 0 });
    editor.presenter.print.beginDrag(1, 100, 100, 200);
    editor.presenter.print.moveDrag(1, 200, 150);
    editor.presenter.print.rotateBy(20, 30);
    expect(editor.print.dragging).toBe(false);
    expect(editor.print.scene).toMatchObject({ yawDegrees: 0, pitchDegrees: 0 });
    editor.presenter.setSoftProof('hdr');
    await drawnBy(editor);
    expect(editor.decoder.stage).toEqual(photo);
  });

  test('rotates with the captured pointer, clamps pitch, wraps yaw, and lies flat for a tool', async () => {
    editor.presenter.setSoftProof('print3d');
    editor.presenter.print.beginDrag(1, 100, 100, 200);
    editor.presenter.print.moveDrag(2, 200, 200);
    expect(editor.print.scene.yawDegrees).toBe(-12);
    editor.presenter.print.moveDrag(1, 200, 400);
    await drawnBy(editor);
    expect(editor.decoder.print).toMatchObject({ yawDegrees: 78, pitchDegrees: 85 });
    editor.presenter.print.rotateBy(720, -180);
    expect(editor.print.scene).toMatchObject({ yawDegrees: 78, pitchDegrees: -85 });
    editor.presenter.setTool('crop');
    expect(editor.stage.softProof).toBe('print');
    expect(editor.print.hanging).toBe(false);
    expect(editor.print.dragging).toBe(false);
    editor.presenter.print.moveDrag(1, 0, 0);
    await drawnBy(editor);
    expect(editor.decoder.print?.presentation).toBe('flat');

    editor.presenter.setSoftProof('print3d');
    expect(editor.print.scene).toMatchObject({ presentation: 'scene', yawDegrees: 78, pitchDegrees: -85 });
    expect(editor.crop.cropping).toBe(false);
  });

  test('a flat print is the stage as it is, with the paper under the pigment and no room around it', async () => {
    editor.presenter.preview({ cropRight: 0.25 });
    await drawnBy(editor);
    const photo = { ...editor.decoder.stage };
    editor.presenter.setSoftProof('print');
    await drawnBy(editor);
    expect(editor.decoder.print?.presentation).toBe('flat');
    expect(editor.decoder.proof).toEqual({ output: 'hdr', intent: 'perceptual', displayHdr: false });
    expect(editor.decoder.stage).toEqual(photo);
    editor.presenter.print.beginDrag(1, 100, 100, 200);
    expect(editor.print.dragging).toBe(false);
    editor.presenter.setTool('crop');
    expect(editor.stage.softProof).toBe('print');
  });

  test('an edit opens under the proof it was left under, and a proof the viewer asked for is not one', () => {
    editor.presenter.setSoftProof('print3d');
    editor.presenter.restoreSoftProof();
    expect(editor.stage.softProof).toBe('hdr');
    expect(editor.print.open).toBe(false);
    editor.presenter.setSoftProof('print');
    editor.presenter.setSoftProof('hdr');
    editor.presenter.setSoftProof('srgb');
    editor.presenter.restoreSoftProof();
    expect(editor.stage.softProof).toBe('srgb');
  });

  test('an sRGB proof carries its rendering intent, and no print', async () => {
    editor.presenter.setSoftProof('srgb');
    editor.presenter.print.setRenderingIntent('relativeColorimetric');
    await drawnBy(editor);
    expect(editor.decoder.proof).toEqual({ output: 'srgb', intent: 'relativeColorimetric', displayHdr: false });
    expect(editor.decoder.print).toBeNull();
  });

  test('rejects invalid material and lighting values and resets rotation alone', () => {
    editor.presenter.setSoftProof('print3d');
    editor.presenter.print.setControl('keyLux', Number.NaN);
    editor.presenter.print.setControl('roughness', 0);
    editor.presenter.print.setControl('whiteReflectance', 2);
    editor.presenter.print.setControl('refractiveIndex', 0.9);
    editor.presenter.print.setControl('lightForward', 11);
    editor.presenter.print.setControl('paperLongEdgeMm', 0);
    editor.presenter.print.setControl('surfaceTexture', 2);
    editor.presenter.print.setControl('lightTemperatureKelvin', 1000);
    expect(editor.print.scene).toEqual(DEFAULT_PRINT_SCENE);
    editor.presenter.print.setPaper('gloss');
    editor.presenter.print.setControl('fillLux', 40);
    editor.presenter.print.rotateBy(30, 20);
    editor.presenter.print.zoomAt(3, { x: 0.2, y: -0.1 });
    editor.presenter.print.panBy(0.1, 0.05);
    editor.presenter.print.resetView();
    expect(editor.print.scene).toMatchObject({
      paper: 'gloss', roughness: 0.16, fillLux: 40, yawDegrees: -12, pitchDegrees: 8,
      zoom: 1, panX: 0, panY: 0,
    });
  });

  test('a wheel zoom holds the scene under the pointer and a pan runs to the edge and stops', () => {
    editor.presenter.setSoftProof('print3d');
    const at = { x: 0.3, y: -0.2 };
    editor.presenter.print.zoomAt(4, at);
    const { zoom, panX, panY } = editor.print.scene;
    expect(zoom).toBeGreaterThan(2);
    // The ray through `at` is `(at - pan) / focal`, so holding it still across a change of focal
    // is what makes the point under the pointer the one the zoom is about.
    expect((at.x - panX) / zoom).toBeCloseTo(at.x, 10);
    expect((at.y - panY) / zoom).toBeCloseTo(at.y, 10);

    editor.presenter.print.panBy(5, -5);
    expect(editor.print.scene).toMatchObject({ panX: 1, panY: -1 });
  });

  test('zoom and pan stay out of the surface presentation, which has the editor own its view', () => {
    editor.presenter.setSoftProof('print3d');
    editor.presenter.print.setTouch(true);
    editor.presenter.print.zoomAt(4, { x: 0.3, y: -0.2 });
    editor.presenter.print.panBy(0.5, 0.5);
    expect(editor.print.scene).toMatchObject({ zoom: 1, panX: 0, panY: 0 });
  });
});

describe('the printer', () => {
  test('opening a print lists the printer profiles, and a chosen one reaches the module once', async () => {
    editor.presenter.setSoftProof('print');
    await Promise.resolve();
    expect(editor.print.printerProfiles).toEqual(['Satin PRO-200.icc']);

    await editor.presenter.print.setPrinterProfile('Satin PRO-200.icc');
    await drawnBy(editor);
    expect(new TextDecoder().decode(editor.decoder.printerProfile ?? new Uint8Array())).toBe('Satin PRO-200.icc');
    editor.presenter.print.setRenderingIntent('perceptual');
    editor.presenter.print.setBlackPointCompensation(false);
    await drawnBy(editor);
    expect(editor.decoder.printerProfileSends).toBe(1);
    expect(editor.decoder.print).toMatchObject({ renderingIntent: 'perceptual', blackPointCompensation: false });

    await editor.presenter.print.setPrinterProfile(null);
    await drawnBy(editor);
    expect(editor.decoder.printerProfile).toBeNull();
    expect(editor.decoder.printerProfileSends).toBe(2);
  });

  test('a profile chosen and then replaced before it arrived is not the one kept', async () => {
    const first = editor.presenter.print.setPrinterProfile('Satin PRO-200.icc');
    await editor.presenter.print.setPrinterProfile(null);
    await first;
    expect(editor.print.printerProfile).toBeNull();
  });

  test('an ink spreads by the paper it lands on, and the printer resolution is its own', () => {
    editor.presenter.setSoftProof('print');
    editor.presenter.print.setControl('printResolutionPpi', 300);
    editor.presenter.print.setInk('pigment');
    expect(editor.print.scene).toMatchObject({ ink: 'pigment', inkSpreadMicrons: 50, printResolutionPpi: 300 });
    editor.presenter.print.setPaper('matte');
    expect(editor.print.scene.inkSpreadMicrons).toBe(35);
    editor.presenter.print.setControl('inkSpreadMicrons', 60);
    editor.presenter.print.resetControl('inkSpreadMicrons');
    expect(editor.print.scene.inkSpreadMicrons).toBe(35);
    editor.presenter.print.setControl('inkSpreadMicrons', 500);
    expect(editor.print.scene.inkSpreadMicrons).toBe(35);
  });
});
