import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { drawnBy, openEditor, type Editor } from '../../stage/tests/raw_edit_harness';
import { DEFAULT_PRINT_SCENE } from '../print_scene';

let editor: Editor;
beforeEach(() => { editor = openEditor(); });
afterEach(() => editor.presenter.close());

describe('print viewing', () => {
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
