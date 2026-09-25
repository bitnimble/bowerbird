import { afterEach, expect, test } from 'bun:test';
import { reading, typedValue } from '../edit_sliders';
import { registerDom } from '../../../test_dom';

registerDom();
const { act, cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const { EditControl } = await import('../edit_control');

afterEach(cleanup);

const EXPOSURE = { min: -5, max: 5, step: 0.01 };
const CONTRAST = { min: -100, max: 100, step: 1 };

test('a typed number is read through its units and sign', () => {
  expect(typedValue('+1.337 EV', EXPOSURE)).toBe(1.337);
  expect(typedValue('−0.5', EXPOSURE)).toBe(-0.5);
  expect(typedValue('5,500 K', { min: 2000, max: 50000, step: 1 })).toBe(5500);
});

test('a typed number is held to the range, and to a whole number where the field stores one', () => {
  expect(typedValue('9', EXPOSURE)).toBe(5);
  expect(typedValue('-250', CONTRAST)).toBe(-100);
  expect(typedValue('12.6', CONTRAST)).toBe(13);
});

test('a percentage is stored as the fraction it shows', () => {
  expect(typedValue('45%', { min: 0, max: 1, step: 0.01, scale: 100 })).toBe(0.45);
});

test('text with no number in it is refused', () => {
  expect(typedValue('bright', EXPOSURE)).toBeNull();
});

test('a value finer than the step reads at its own precision', () => {
  expect(reading(1.337, EXPOSURE)).toBe('+1.337');
  expect(reading(1.3, EXPOSURE)).toBe('+1.30');
});

function open(set: (value: number) => void): HTMLInputElement {
  render(
    <EditControl label="Exposure" value="+0.50 EV" reset={null} typing={{ ...EXPOSURE, set }}>
      {null}
    </EditControl>,
  );
  return screen.getByRole('textbox', { name: 'Exposure value' }) as HTMLInputElement;
}

test('Enter sets the typed value', () => {
  const set: number[] = [];
  const field = open((value) => set.push(value));
  act(() => field.focus());
  fireEvent.change(field, { target: { value: '1.337' } });
  fireEvent.keyDown(field, { key: 'Enter' });
  expect(set).toEqual([1.337]);
  expect(document.activeElement).not.toBe(field);
});

test('Escape leaves the value alone', () => {
  const set: number[] = [];
  const field = open((value) => set.push(value));
  act(() => field.focus());
  fireEvent.change(field, { target: { value: '3' } });
  fireEvent.keyDown(field, { key: 'Escape' });
  expect(set).toEqual([]);
  expect(document.activeElement).not.toBe(field);
  expect(field.value).toBe('+0.50 EV');
});

test('passing through the field without typing sets nothing', () => {
  const set: number[] = [];
  const field = open((value) => set.push(value));
  act(() => field.focus());
  act(() => field.blur());
  expect(set).toEqual([]);
});

test('a shut control shows its value as text', () => {
  render(
    <EditControl label="Exposure" value="+0.50 EV" reset={null} typing={null}>
      {null}
    </EditControl>,
  );
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.getByText('+0.50 EV')).toBeTruthy();
});
