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
    editor.presenter.print.setSurface(true);
    editor.presenter.print.setFramed(true);
    editor.presenter.setTool('print');
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
    editor.presenter.print.setSurface(true);
    editor.presenter.setTool('print');
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

    editor.presenter.setTool('cursor');
    await drawnBy(editor);
    expect(editor.presenter.displaySize).toEqual({ width: 3000, height: 2000 });
    expect(editor.decoder.frames.at(-1)?.region).toEqual({ x: 0, y: 0, width: 3000, height: 2000 });
    expect(editor.decoder.stage.width / editor.decoder.stage.height).toBeCloseTo(3 / 2, 2);

    editor.presenter.setTool('print');
    await drawnBy(editor);
    expect(editor.presenter.displaySize).toEqual({ width: 3500, height: 2500 });
    editor.presenter.print.setSurface(false);
    await drawnBy(editor);
    expect(editor.presenter.displaySize).toEqual({ width: 3000, height: 2000 });
    expect(editor.decoder.frames.at(-1)?.region).toEqual({ x: 0, y: 0, width: 3000, height: 2000 });
    expect(editor.decoder.stage.width / editor.decoder.stage.height).toBeCloseTo(4 / 3, 2);
  });

  test('frame choice redraws and survives paper and presentation changes', async () => {
    editor.presenter.setTool('print');
    await drawnBy(editor);
    expect(editor.decoder.print?.framed).toBe(false);

    editor.presenter.print.setFramed(true);
    await drawnBy(editor);
    expect(editor.decoder.print?.framed).toBe(true);

    editor.presenter.print.setPaper('gloss');
    editor.presenter.print.setSurface(true);
    await drawnBy(editor);
    expect(editor.decoder.print).toMatchObject({ paper: 'gloss', presentation: 'surface', framed: true });

    editor.presenter.print.setSurface(false);
    editor.presenter.setTool('cursor');
    editor.presenter.setTool('print');
    await drawnBy(editor);
    expect(editor.decoder.print).toMatchObject({ presentation: 'scene', framed: true });

    editor.presenter.print.setFramed(false);
    await drawnBy(editor);
    expect(editor.decoder.print?.framed).toBe(false);
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

    editor.presenter.print.setSurface(true);
    editor.presenter.setTool('print');
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

    editor.presenter.setTool('cursor');
    await settled();
    expect(coverage).toEqual([true, false]);

    editor.presenter.setTool('print');
    await settled();
    expect(coverage).toEqual([true, false, true]);

    editor.presenter.print.setSurface(false);
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
    editor.presenter.print.setSurface(true);
    editor.presenter.setTool('print');
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
    editor.presenter.setTool('print');
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
    editor.presenter.print.setControl('lightDistance', 2.5);
    editor.presenter.print.setControl('paperLongEdgeMm', 420);
    editor.presenter.print.setControl('lightTemperatureKelvin', 2700);
    await drawnBy(editor);
    expect(editor.decoder.print).toMatchObject({
      paper: 'matte', roughness: 0.65, keyLux: 2340, refractiveIndex: 1.46,
      lightDistance: 2.5, paperLongEdgeMm: 420, surfaceTexture: 0.85, lightTemperatureKelvin: 2700,
    });
    expect(JSON.stringify(editor.edit.doc)).toBe(doc);
  });

  test('uses the viewport aspect for the 3D scene and restores photo framing', async () => {
    editor.presenter.preview({ cropRight: 0.25 });
    await drawnBy(editor);
    const photo = { ...editor.decoder.stage };
    editor.presenter.setTool('print');
    await drawnBy(editor);
    expect(editor.decoder.stage.width / editor.decoder.stage.height).toBeCloseTo(800 / 600, 2);
    editor.presenter.setTool('cursor');
    await drawnBy(editor);
    expect(editor.decoder.print).toBeNull();
    expect(editor.stage.renderedMode).toBe('photo');
    expect(editor.decoder.stage).toEqual(photo);
  });

  test('surface print keeps the normal editor framing and ignores drag rotation', async () => {
    editor.presenter.preview({ cropRight: 0.25 });
    await drawnBy(editor);
    const photo = { ...editor.decoder.stage };
    editor.presenter.print.setSurface(true);
    editor.presenter.setTool('print');
    await drawnBy(editor);
    expect(editor.decoder.stage).toEqual(photo);
    expect(editor.decoder.print).toMatchObject({ presentation: 'surface', yawDegrees: 0, pitchDegrees: 0 });
    editor.presenter.print.beginDrag(1, 100, 100, 200);
    editor.presenter.print.moveDrag(1, 200, 150);
    editor.presenter.print.rotateBy(20, 30);
    expect(editor.print.dragging).toBe(false);
    expect(editor.print.scene).toMatchObject({ yawDegrees: 0, pitchDegrees: 0 });
    editor.presenter.setTool('cursor');
    await drawnBy(editor);
    expect(editor.decoder.stage).toEqual(photo);
  });

  test('rotates with the captured pointer, clamps pitch, wraps yaw and releases on tool change', async () => {
    editor.presenter.setTool('print');
    editor.presenter.print.beginDrag(1, 100, 100, 200);
    editor.presenter.print.moveDrag(2, 200, 200);
    expect(editor.print.scene.yawDegrees).toBe(-12);
    editor.presenter.print.moveDrag(1, 200, 400);
    await drawnBy(editor);
    expect(editor.decoder.print).toMatchObject({ yawDegrees: 78, pitchDegrees: 85 });
    editor.presenter.print.rotateBy(720, -180);
    expect(editor.print.scene).toMatchObject({ yawDegrees: 78, pitchDegrees: -85 });
    editor.presenter.setTool('crop');
    expect(editor.print.open).toBe(false);
    expect(editor.print.dragging).toBe(false);
    editor.presenter.print.moveDrag(1, 0, 0);
    expect(editor.print.scene.yawDegrees).toBe(78);
    await drawnBy(editor);
    expect(editor.decoder.print).toBeNull();
  });

  test('rejects invalid material and lighting values and resets rotation alone', () => {
    editor.presenter.setTool('print');
    editor.presenter.print.setControl('keyLux', Number.NaN);
    editor.presenter.print.setControl('roughness', 0);
    editor.presenter.print.setControl('whiteReflectance', 2);
    editor.presenter.print.setControl('refractiveIndex', 0.9);
    editor.presenter.print.setControl('lightDistance', 0.1);
    editor.presenter.print.setControl('paperLongEdgeMm', 0);
    editor.presenter.print.setControl('surfaceTexture', 2);
    editor.presenter.print.setControl('lightTemperatureKelvin', 1000);
    expect(editor.print.scene).toEqual(DEFAULT_PRINT_SCENE);
    editor.presenter.print.setPaper('gloss');
    editor.presenter.print.setControl('fillLux', 40);
    editor.presenter.print.rotateBy(30, 20);
    editor.presenter.print.resetRotation();
    expect(editor.print.scene).toMatchObject({ paper: 'gloss', roughness: 0.08, fillLux: 40, yawDegrees: -12, pitchDegrees: 8 });
  });
});
