import { afterEach, expect, test } from 'bun:test';
import type { SliderIsolation, SliderIsolationRectangle } from '../slider_isolation';
import { registerDom } from '../../test_dom';

registerDom();
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const { Slider } = await import('../slider');
const { SliderIsolationContext } = await import('../slider_isolation');

afterEach(cleanup);

function pointer(element: HTMLElement, type: string, options: { id?: number; primary?: boolean; button?: number } = {}): void {
  const event = new MouseEvent(type, { bubbles: true, button: options.button ?? 0, buttons: type === 'pointerdown' ? 1 : 0 });
  Object.defineProperties(event, {
    pointerId: { value: options.id ?? 7 },
    isPrimary: { value: options.primary ?? true },
    pointerType: { value: 'mouse' },
  });
  fireEvent(element, event);
}

function fixture(): {
  isolation: SliderIsolation;
  starts: SliderIsolationRectangle[];
  ends: string[];
  content: (value?: number, disabled?: boolean) => JSX.Element;
} {
  const starts: SliderIsolationRectangle[] = [];
  const ends: string[] = [];
  const isolation: SliderIsolation = {
    active: null,
    begin: (id, rectangle) => {
      starts.push(rectangle);
      isolation.active = { id, rectangle };
    },
    end: (id) => {
      ends.push(id);
      if (isolation.active?.id === id) isolation.active = null;
    },
  };
  return {
    isolation,
    starts,
    ends,
    content: (value = 50, disabled = false) => (
      <SliderIsolationContext.Provider value={{ ...isolation }}>
        <Slider label="Exposure" value={value} min={0} max={100} step={1} onChange={() => {}}
          valueText={(at) => `${at}%`} disabled={disabled} />
      </SliderIsolationContext.Provider>
    ),
  };
}

test('isolation leaves the original range mounted and shows a live noninteractive copy', () => {
  const state = fixture();
  const view = render(state.content());
  const range = screen.getByRole('slider', { name: 'Exposure' });
  const parent = range.parentElement;
  pointer(range, 'pointerdown');
  expect(state.starts).toEqual([{ left: 0, top: 0, width: 200, height: 20 }]);
  view.rerender(state.content(73));
  const floating = screen.getByRole('region', { name: 'Adjusting Exposure' });
  expect(floating.parentElement).toBe(document.body);
  expect(floating.style.width).toBe('200px');
  expect(screen.getByText('73%')).toBeTruthy();
  expect(screen.getAllByRole('slider')).toHaveLength(1);
  expect(screen.getByRole('slider', { name: 'Exposure' })).toBe(range);
  expect(range.parentElement).toBe(parent);
  expect(state.ends).toEqual([]);
  pointer(range, 'pointerup', { id: 8, primary: false });
  expect(state.ends).toEqual([]);
  pointer(range, 'pointerup');
  view.rerender(state.content(73));
  expect(screen.queryByRole('region', { name: 'Adjusting Exposure' })).toBeNull();
  expect(state.ends).toHaveLength(1);
});

for (const event of ['pointercancel', 'lostpointercapture']) {
  test(`${event} ends isolation`, () => {
    const state = fixture();
    render(state.content());
    const range = screen.getByRole('slider', { name: 'Exposure' });
    pointer(range, 'pointerdown');
    pointer(range, event);
    expect(state.isolation.active).toBeNull();
    expect(state.ends).toHaveLength(1);
  });
}

test('unmount ends isolation and disabled or secondary presses never begin it', () => {
  const state = fixture();
  const view = render(state.content());
  const range = screen.getByRole('slider', { name: 'Exposure' });
  pointer(range, 'pointerdown', { primary: false });
  pointer(range, 'pointerdown', { button: 2 });
  view.rerender(state.content(50, true));
  pointer(range, 'pointerdown');
  expect(state.starts).toEqual([]);
  view.rerender(state.content());
  pointer(range, 'pointerdown');
  expect(state.starts).toHaveLength(1);
  view.unmount();
  expect(state.isolation.active).toBeNull();
});
