import { afterEach, expect, test } from 'bun:test';
import type { Isolation, IsolationRectangle } from '../isolation';
import { registerDom } from '../../test_dom';

registerDom();
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const { Slider } = await import('../slider');
const { IsolationContext } = await import('../isolation');

afterEach(cleanup);

function pointer(
  element: HTMLElement,
  type: string,
  options: {
    id?: number;
    primary?: boolean;
    button?: number;
    touch?: boolean;
    x?: number;
    y?: number;
  } = {},
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    button: options.button ?? 0,
    buttons: type === 'pointerdown' ? 1 : 0,
    clientX: options.x ?? 0,
    clientY: options.y ?? 0,
  });
  Object.defineProperties(event, {
    pointerId: { value: options.id ?? 7 },
    isPrimary: { value: options.primary ?? true },
    pointerType: { value: options.touch === true ? 'touch' : 'mouse' },
  });
  fireEvent(element, event);
}

function fixture(): {
  isolation: Isolation;
  starts: IsolationRectangle[];
  ends: string[];
  content: (value?: number, disabled?: boolean) => JSX.Element;
  changes: number[];
} {
  const starts: IsolationRectangle[] = [];
  const changes: number[] = [];
  const ends: string[] = [];
  const isolation: Isolation = {
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
    changes,
    content: (value = 50, disabled = false) => (
      <IsolationContext.Provider value={{ ...isolation }}>
        <Slider
          label="Exposure"
          value={value}
          min={0}
          max={100}
          step={1}
          onChange={(at) => changes.push(at)}
          valueText={(at) => `${at}%`}
          disabled={disabled}
        />
      </IsolationContext.Provider>
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

test("a touch never reaches the control's own touch handling", () => {
  render(fixture().content());
  const range = screen.getByRole('slider', { name: 'Exposure' });
  let reached = false;
  range.addEventListener('touchstart', () => {
    reached = true;
  });
  range.dispatchEvent(new Event('touchstart', { bubbles: true }));
  expect(reached).toBe(false);
});

test('a touch swiping down the slider leaves it to scroll, and one dragging sideways moves it', () => {
  const state = fixture();
  render(state.content());
  const range = screen.getByRole('slider', { name: 'Exposure' });
  pointer(range, 'pointerdown', { touch: true, x: 100, y: 10 });
  pointer(range, 'pointermove', { touch: true, x: 102, y: 40 });
  pointer(range, 'pointercancel', { touch: true });
  expect(state.starts).toEqual([]);
  expect(state.changes).toEqual([]);

  pointer(range, 'pointerdown', { touch: true, x: 100, y: 10 });
  pointer(range, 'pointermove', { touch: true, x: 130, y: 12 });
  expect(state.starts).toHaveLength(1);
  expect(state.changes).toEqual([65]);
  pointer(range, 'pointerup', { touch: true, x: 130, y: 12 });
  expect(state.ends).toHaveLength(1);
});
