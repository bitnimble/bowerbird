import { beforeEach, describe, expect, test } from 'bun:test';
import { WHEEL_RIM, drawnBy, openEditor, type Editor } from '../../stage/tests/raw_edit_harness';

let editor: Editor;

beforeEach(() => {
  editor = openEditor();
});

const wheel = () => editor.presenter.colourWheel;
const settled = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

function fakeCanvas(): HTMLCanvasElement {
  return { width: 0, height: 0, transferControlToOffscreen: () => ({}) } as HTMLCanvasElement;
}

describe('the colour wheel', () => {
  test('adds a colour edit where the reader selects, in the channel, moving nothing yet', async () => {
    wheel().selectChannel(30);
    wheel().add({ hue: 200, chroma: 10 });
    await drawnBy(editor);
    expect(editor.decoder.adjust?.colourNodes).toEqual([
      {
        hue: 200,
        chroma: 10,
        lightness: 30,
        targetHue: 200,
        targetChroma: 10,
        targetLightness: 30,
        hueReach: 30,
        chromaReach: 6,
        lightnessReach: 20,
      },
    ]);
    expect(editor.colourWheel.selectedIndex).toBe(0);
  });

  test('previews a drag of the new colour and settles it once, or puts it back on cancel', async () => {
    wheel().add({ hue: 0, chroma: 10 });
    const before = editor.edit.doc?.colourNodes;

    wheel().beginDrag(0);
    wheel().drag(0, 'target', { hue: 90, chroma: 5 });
    wheel().drag(0, 'target', { hue: 120, chroma: 8 });
    await drawnBy(editor);
    expect(editor.decoder.adjust?.colourNodes[0]).toMatchObject({
      hue: 0,
      targetHue: 120,
      targetChroma: 8,
    });
    wheel().cancelDrag();
    expect(editor.edit.doc?.colourNodes).toEqual(before ?? []);

    wheel().beginDrag(0);
    wheel().drag(0, 'hueReach', { hue: 45, chroma: 10 });
    wheel().endDrag();
    expect(editor.edit.doc?.colourNodes[0]?.hueReach).toBe(45);
  });

  test('sets the new colour and the reach from the sliders', () => {
    wheel().add({ hue: 10, chroma: 4 });
    wheel().previewNode(0, { targetLightness: 70 });
    wheel().settleNode(0, { lightnessReach: 35 });
    expect(editor.edit.doc?.colourNodes[0]).toMatchObject({
      targetLightness: 70,
      lightnessReach: 35,
    });
    wheel().remove(0);
    expect(editor.edit.doc?.colourNodes).toEqual([]);
    expect(editor.colourWheel.selectedIndex).toBeNull();
  });

  test('adds no more edits than a document holds', () => {
    for (let at = 0; at < 40; at++) wheel().add({ hue: at * 9, chroma: 5 });
    expect(editor.edit.doc?.colourNodes).toHaveLength(32);
  });

  test('shows each channel its own edits, and marks the channels that hold one', () => {
    wheel().selectChannel(80);
    wheel().add({ hue: 10, chroma: 4 });
    wheel().selectChannel(null);
    wheel().add({ hue: 200, chroma: 4 });
    expect(editor.colourWheel.shown.map(({ index }) => index)).toEqual([1]);
    expect([...editor.colourWheel.edited]).toEqual([80, null]);
    wheel().selectChannel(80);
    expect(editor.colourWheel.selectedIndex).toBeNull();
    expect(editor.colourWheel.shown.map(({ index }) => index)).toEqual([0]);
  });

  test('a press lets go of the selected edit, and adds one only with none selected', () => {
    wheel().press({ hue: 40, chroma: 10 });
    expect(editor.edit.doc?.colourNodes).toHaveLength(1);
    expect(editor.colourWheel.selectedIndex).toBe(0);
    wheel().press({ hue: 200, chroma: 10 });
    expect(editor.edit.doc?.colourNodes).toHaveLength(1);
    expect(editor.colourWheel.selectedIndex).toBeNull();
    wheel().press(null);
    wheel().press({ hue: 200, chroma: 10 });
    expect(editor.edit.doc?.colourNodes).toHaveLength(2);
  });

  test("holds a dragged edit's outer saturation edge at the rim, and gives its range back", async () => {
    wheel().attach(fakeCanvas());
    await settled();
    await settled();
    wheel().add({ hue: 0, chroma: 10 });
    wheel().beginDrag(0);
    wheel().drag(0, 'source', { hue: 0, chroma: 45 });
    expect(editor.edit.doc?.colourNodes[0]).toMatchObject({ chroma: WHEEL_RIM, chromaReach: 0 });
    wheel().drag(0, 'source', { hue: 0, chroma: 20 });
    wheel().endDrag();
    expect(editor.edit.doc?.colourNodes[0]).toMatchObject({ chroma: 20, chromaReach: 6 });
  });

  test("draws the wheel's edge against this display's peak, and again when it changes", async () => {
    const original = globalThis.matchMedia;
    globalThis.matchMedia = ((query: string) => ({
      matches: query === '(dynamic-range: high)',
    })) as typeof matchMedia;
    try {
      editor.device.displayPeakNits = 1600;
      wheel().attach(fakeCanvas());
      await settled();
      editor.device.displayPeakNits = 1000;
      await settled();
    } finally {
      globalThis.matchMedia = original;
    }
    expect(editor.decoder.wheelPeaks).toEqual([1600, 1000]);
  });

  test('darkens the wheel around the selected edit, following it as it moves', async () => {
    wheel().attach(fakeCanvas());
    await settled();
    await settled();
    wheel().add({ hue: 120, chroma: 10 });
    await settled();
    expect(editor.decoder.wheelShadedBy.at(-1)).toMatchObject({ hue: 120, chroma: 10 });

    wheel().beginDrag(0);
    wheel().drag(0, 'hueReach', { hue: 160, chroma: 10 });
    await settled();
    expect(editor.decoder.wheelShadedBy.at(-1)).toMatchObject({ hue: 120, hueReach: 40 });

    wheel().endDrag();
    wheel().select(null);
    await settled();
    expect(editor.decoder.wheelShadedBy.at(-1)).toBeNull();
  });

  test('hands its canvas over once, draws at the channel, and reads the photograph and profile', async () => {
    // A profile that turns every colour a quarter clockwise, over three dots: one in the
    // midtones, one in the darks and one the probe weighted to nothing.
    editor.decoder.wheelMoves = ([lightness = 0, a = 0, b = 0]) => [lightness, b, -a, 1];
    editor.decoder.wheelDots = [55, 4, -3, 1, 30, 1, 1, 1, 56, 9, 9, 0];
    const canvas = fakeCanvas();
    wheel().attach(canvas);
    await settled();
    wheel().attach(canvas);
    await settled();
    expect(editor.decoder.wheelsAttached).toBe(1);
    expect(editor.decoder.wheelSide).toBe(512);
    expect(editor.colourWheel.channel).toBeNull();
    expect(editor.decoder.wheelDrawnAt).toEqual([55]);
    expect(editor.decoder.wheelEdgesAt).toEqual([[10, 30, 55, 80, 110]]);
    await settled();
    expect(editor.decoder.wheelProbes).toHaveLength(1);
    const midtone = { lightness: 55, hue: expect.closeTo(323.13, 1), chroma: expect.closeTo(5, 4) };
    expect(editor.colourWheel.channelDots).toEqual([
      midtone,
      { lightness: 30, hue: expect.closeTo(45, 1), chroma: expect.closeTo(Math.SQRT2, 4) },
    ]);

    wheel().selectChannel(55);
    await settled();
    expect(editor.decoder.wheelDrawnAt).toEqual([55, 55]);
    expect(editor.decoder.wheelEdgesAt.at(-1)).toEqual([55]);
    expect(editor.colourWheel.channelDots).toEqual([midtone]);
    const arrows = editor.colourWheel.channelField;
    expect(new Set(arrows.map(({ from }) => Math.floor(from.hue / 30))).size).toBe(12);
    for (const { lightness, from, to } of arrows) {
      expect(lightness).toBe(55);
      expect(from.chroma).toBeCloseTo(0.85 * WHEEL_RIM, 3);
      expect((from.hue - to.hue + 360) % 360).toBeCloseTo(90, 3);
    }

    wheel().selectChannel(80);
    await settled();
    expect(editor.decoder.wheelDrawnAt).toEqual([55, 55, 80]);
    expect(editor.colourWheel.channelDots).toEqual([]);
    expect(editor.colourWheel.channelField.every(({ lightness }) => lightness === 80)).toBe(true);

    wheel().attach(fakeCanvas());
    await settled();
    expect(editor.decoder.wheelsAttached).toBe(2);
    expect(editor.decoder.wheelDrawnAt).toEqual([55, 55, 80, 80]);
  });
});
