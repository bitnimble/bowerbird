import { afterEach, expect, test } from 'bun:test';
import { registerDom } from '../../../../test_dom';
import { openEditor, type Editor } from '../../stage/tests/raw_edit_harness';

registerDom();
const { act, cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const { ColourWheelEditor } = await import('../colour_wheel_editor');

afterEach(cleanup);

const SIDE = 200;
/** `Node.DOCUMENT_POSITION_FOLLOWING`: later in the document, so painted over. */
const FOLLOWS = 4;

async function open(): Promise<Editor> {
  const canvas = Object.getPrototypeOf(document.createElement('canvas'));
  Object.defineProperty(canvas, 'transferControlToOffscreen', {
    value: () => ({}),
    configurable: true,
  });
  Object.defineProperty(canvas, 'getContext', { value: () => null, configurable: true });
  const editor = openEditor();
  render(
    <ColourWheelEditor
      store={editor.colourWheel}
      stage={editor.stage}
      presenter={editor.presenter.colourWheel}
    />,
  );
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  return editor;
}

function wheel(): SVGSVGElement {
  const svg = screen.getByRole('group', { name: 'Colour wheel' }) as unknown as SVGSVGElement;
  Object.defineProperty(svg, 'getBoundingClientRect', {
    value: () => ({ left: 0, top: 0, width: SIDE, height: SIDE }),
  });
  return svg;
}

/** The fake decoder's rim is 40. */
function at(hue: number, chroma: number): { clientX: number; clientY: number } {
  const turn = (hue * Math.PI) / 180;
  const r = (chroma / 40) * (SIDE / 2);
  return { clientX: SIDE / 2 + r * Math.cos(turn), clientY: SIDE / 2 - r * Math.sin(turn) };
}

const press = { pointerId: 1, isPrimary: true, button: 0 };

test('selecting the wheel adds a colour edit there, and its controls with it', async () => {
  const editor = await open();
  expect(screen.getByText('Select a colour on the wheel to edit it.')).not.toBeNull();

  fireEvent.pointerDown(wheel(), { ...press, ...at(120, 20) });

  const [node] = editor.edit.doc?.colourNodes ?? [];
  expect(node?.hue).toBeCloseTo(120, 1);
  expect(node?.chroma).toBeCloseTo(20, 1);
  expect(node?.lightness).toBe(55);
  screen.getByRole('button', { name: 'Colour edit at hue 120°', pressed: true });
  screen.getByRole('slider', { name: 'Hue' });
  screen.getByRole('slider', { name: 'Lightness range' });
});

test('a press outside the rim adds nothing', async () => {
  const editor = await open();
  fireEvent.pointerDown(wheel(), { ...press, clientX: 2, clientY: 2 });
  expect(editor.edit.doc?.colourNodes).toEqual([]);
});

test("a new edit's colour is dragged off its own node, which it is drawn over", async () => {
  const editor = await open();
  const svg = wheel();
  fireEvent.pointerDown(svg, { ...press, ...at(0, 20) });
  const target = screen.getByRole('img', { name: 'New colour' });
  const node = screen.getByRole('button', { name: /Colour edit at hue/ });
  expect(node.compareDocumentPosition(target) & FOLLOWS).toBeTruthy();

  fireEvent.pointerDown(target, { ...press, ...at(0, 20) });
  fireEvent.pointerMove(svg, { ...press, ...at(90, 10) });
  fireEvent.pointerUp(svg, press);

  expect(editor.edit.doc?.colourNodes[0]).toMatchObject({
    hue: 0,
    targetHue: expect.closeTo(90, 0),
    targetChroma: expect.closeTo(10, 0),
  });
});

test('the channels say which hold edits, and each shows only its own', async () => {
  const editor = await open();
  fireEvent.click(screen.getByRole('radio', { name: 'Lights' }));
  fireEvent.pointerDown(wheel(), { ...press, ...at(200, 10) });

  screen.getByRole('radio', { name: 'Lights, edited', checked: true });
  fireEvent.click(screen.getByRole('radio', { name: 'Shadows' }));
  expect(screen.queryByRole('button', { name: /Colour edit at hue/ })).toBeNull();
  expect(editor.colourWheel.channel).toBe(10);
});

test('removing the colour edit takes it out of the document', async () => {
  const editor = await open();
  fireEvent.pointerDown(wheel(), { ...press, ...at(300, 15) });
  fireEvent.click(screen.getByRole('button', { name: 'Remove colour edit' }));
  expect(editor.edit.doc?.colourNodes).toEqual([]);
  expect(screen.queryByRole('button', { name: /Colour edit at hue/ })).toBeNull();
});
