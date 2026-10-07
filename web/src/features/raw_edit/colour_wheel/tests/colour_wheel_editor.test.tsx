import { afterEach, expect, test } from 'bun:test';
import { type ReactNode, useCallback, useState } from 'react';
import { registerDom } from '../../../../test_dom';
import type { Isolated, IsolationRectangle } from '../../../../ui/isolation';
import { WHEEL_RIM, openEditor, type Editor } from '../../stage/tests/raw_edit_harness';

registerDom();
const { act, cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const { ColourWheelEditor } = await import('../colour_wheel_editor');
const { IsolationContext } = await import('../../../../ui/isolation');

const canvas = Object.getPrototypeOf(document.createElement('canvas'));
const getContext = Object.getOwnPropertyDescriptor(canvas, 'getContext');

afterEach(() => {
  cleanup();
  delete canvas.transferControlToOffscreen;
  if (getContext != null) Object.defineProperty(canvas, 'getContext', getContext);
});

const SIDE = 200;

/** The phone's edit sheet, as far as a control dragged on its own sees it. */
function Isolating({ children }: { children: ReactNode }): JSX.Element {
  const [active, setActive] = useState<Isolated | null>(null);
  // Stable, as the sheet's presenter methods are: a control ends its isolation when `end` changes.
  const begin = useCallback((id: string, rectangle: IsolationRectangle) => {
    setActive({ id, rectangle });
  }, []);
  const end = useCallback((id: string) => {
    setActive((was) => (was?.id === id ? null : was));
  }, []);
  return (
    <IsolationContext.Provider value={{ active, begin, end }}>{children}</IsolationContext.Provider>
  );
}

async function open({ isolating = false } = {}): Promise<Editor> {
  Object.defineProperty(canvas, 'transferControlToOffscreen', {
    value: () => ({}),
    configurable: true,
  });
  Object.defineProperty(canvas, 'getContext', { value: () => null, configurable: true });
  const editor = openEditor();
  const wheelEditor = (
    <ColourWheelEditor
      store={editor.colourWheel}
      stage={editor.stage}
      presenter={editor.presenter.colourWheel}
    />
  );
  render(isolating ? <Isolating>{wheelEditor}</Isolating> : wheelEditor);
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

function at(hue: number, chroma: number): { clientX: number; clientY: number } {
  const turn = (hue * Math.PI) / 180;
  const r = (chroma / WHEEL_RIM) * (SIDE / 2);
  return { clientX: SIDE / 2 + r * Math.cos(turn), clientY: SIDE / 2 - r * Math.sin(turn) };
}

const press = { pointerId: 1, isPrimary: true, button: 0 };

function tap(svg: SVGSVGElement, where: { clientX: number; clientY: number }): void {
  fireEvent.pointerDown(svg, { ...press, ...where });
  fireEvent.pointerUp(svg, { ...press, ...where });
}

test('selecting the wheel adds a colour edit there, and its controls with it', async () => {
  const editor = await open();
  screen.getByRole('radio', { name: 'All', checked: true });

  tap(wheel(), at(120, 20));

  const [node] = editor.edit.doc?.colourNodes ?? [];
  expect(node?.hue).toBeCloseTo(120, 1);
  expect(node?.chroma).toBeCloseTo(20, 1);
  expect(node?.lightness).toBeNull();
  screen.getByRole('button', { name: 'Colour edit at hue 120°', pressed: true });
  screen.getByRole('slider', { name: 'Output hue' });
  expect(screen.queryByRole('slider', { name: 'Lightness range' })).toBeNull();
  expect(screen.getAllByRole('slider', { name: 'Hue range' })).toHaveLength(2);
});

test("the reach handles step from the keyboard, and a full circle's hue edges are one handle", async () => {
  const editor = await open();
  tap(wheel(), at(120, 20));
  const [hueEdge] = screen.getAllByRole('slider', { name: 'Hue range' });
  fireEvent.keyDown(hueEdge!, { key: 'ArrowUp', shiftKey: true });
  fireEvent.keyDown(screen.getByRole('slider', { name: 'Saturation range' }), { key: 'ArrowDown' });
  expect(editor.edit.doc?.colourNodes[0]).toMatchObject({ hueReach: 40, chromaReach: 5.5 });

  for (let step = 0; step < 15; step++) {
    fireEvent.keyDown(screen.getAllByRole('slider', { name: 'Hue range' })[0]!, {
      key: 'ArrowRight',
      shiftKey: true,
    });
  }
  expect(editor.edit.doc?.colourNodes[0]?.hueReach).toBe(180);
  expect(screen.getAllByRole('slider', { name: 'Hue range' })).toHaveLength(1);
});

test("the options menu shows the display gamut at first, and the photo's colours and the profile's arrows once asked", async () => {
  const editor = await open();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Colour wheel options' }));
  });
  const edge = screen.getByRole('menuitemcheckbox', { name: 'Show my display gamut' });
  const colours = screen.getByRole('menuitemcheckbox', { name: 'Show photo colours' });
  const arrows = screen.getByRole('menuitemcheckbox', { name: 'Show colour profile changes' });
  expect(edge.getAttribute('aria-checked')).toBe('true');
  expect(colours.getAttribute('aria-checked')).toBe('false');
  expect(arrows.getAttribute('aria-checked')).toBe('false');

  await act(async () => {
    fireEvent.click(colours);
  });
  expect(editor.colourWheel.showDots).toBe(true);
  expect(editor.colourWheel.showField).toBe(false);
  expect(editor.colourWheel.showEdge).toBe(true);
});

test('the options menu turns the display gamut off', async () => {
  const editor = await open();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Colour wheel options' }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Show my display gamut' }));
  });
  expect(editor.colourWheel.showEdge).toBe(false);
});

test('dragging an edit in the phone sheet leaves only it, its reach and its output on show', async () => {
  await open({ isolating: true });
  const svg = wheel();
  tap(svg, at(120, 20));
  tap(svg, at(300, 20));
  tap(svg, at(300, 20));
  expect(screen.getAllByRole('button', { name: /Colour edit at hue/ })).toHaveLength(2);

  fireEvent.pointerDown(screen.getByRole('img', { name: 'Output colour' }), {
    ...press,
    ...at(300, 20),
  });
  expect(screen.getAllByRole('button', { name: /Colour edit at hue/ })).toHaveLength(1);
  screen.getByRole('img', { name: 'Output colour' });
  expect(screen.getAllByRole('slider', { name: 'Hue range' })).toHaveLength(2);

  fireEvent.pointerUp(svg, press);
  expect(screen.getAllByRole('button', { name: /Colour edit at hue/ })).toHaveLength(2);
});

test('a tap outside the rim adds nothing', async () => {
  const editor = await open();
  tap(wheel(), { clientX: 2, clientY: 2 });
  expect(editor.edit.doc?.colourNodes).toEqual([]);
});

test('a drag across the wheel, or one the sheet takes to scroll, adds nothing', async () => {
  const editor = await open();
  const svg = wheel();
  fireEvent.pointerDown(svg, { ...press, ...at(120, 20) });
  fireEvent.pointerUp(svg, { ...press, ...at(120, 10) });
  fireEvent.pointerDown(svg, { ...press, ...at(120, 20) });
  fireEvent.pointerCancel(svg, press);
  fireEvent.pointerUp(svg, { ...press, ...at(120, 20) });
  expect(editor.edit.doc?.colourNodes).toEqual([]);
});

test('a tap elsewhere lets go of the selected edit rather than adding one', async () => {
  const editor = await open();
  const svg = wheel();
  tap(svg, at(120, 20));
  tap(svg, at(300, 20));
  expect(editor.edit.doc?.colourNodes).toHaveLength(1);
  expect(screen.queryByRole('slider', { name: 'Output hue' })).toBeNull();
});

test("a new edit's colour is dragged off its own node, which it is drawn over", async () => {
  const editor = await open();
  const svg = wheel();
  tap(svg, at(0, 20));
  const target = screen.getByRole('img', { name: 'Output colour' });
  const node = screen.getByRole('button', { name: /Colour edit at hue/ });
  expect(node.compareDocumentPosition(target) & node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

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
  tap(wheel(), at(200, 10));

  screen.getByRole('radio', { name: 'Lights (edited)', checked: true });
  fireEvent.click(screen.getByRole('radio', { name: 'Shadows' }));
  expect(screen.queryByRole('button', { name: /Colour edit at hue/ })).toBeNull();
  expect(editor.colourWheel.channel).toBe(10);
});

test('removing the colour edit takes it out of the document', async () => {
  const editor = await open();
  tap(wheel(), at(300, 15));
  fireEvent.click(screen.getByRole('button', { name: 'Remove colour edit' }));
  expect(editor.edit.doc?.colourNodes).toEqual([]);
  expect(screen.queryByRole('button', { name: /Colour edit at hue/ })).toBeNull();
});
