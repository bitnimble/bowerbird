import { afterEach, expect, test } from 'bun:test';
import { registerDom } from '../../../../test_dom';
import { PrintPresenter } from '../print_presenter';
import { PrintStore } from '../print_store';
import type { PrintMotionEnvironment } from '../print_motion';

registerDom();
const { act, cleanup, render, screen } = await import('@testing-library/react');
const { PrintPanel } = await import('../print_panel');
let presenter: PrintPresenter | null = null;
afterEach(() => { cleanup(); presenter?.close(); presenter = null; });

test('mobile print requests motion access on opening and offers recentering', async () => {
  let requests = 0;
  const events = new window.EventTarget();
  const motion: PrintMotionEnvironment = {
    events, visibility: Object.assign(new window.EventTarget(), { hidden: false }),
    screenEvents: null, screenAngle: () => 0,
    requestPermission: async () => { requests += 1; return 'granted'; },
    requestFrame: () => 0, cancelFrame: () => {}, now: () => 0,
  };
  const store = new PrintStore();
  presenter = new PrintPresenter(store, () => {}, motion);
  presenter.setSurface(true);
  await act(async () => presenter?.setOpen(true));
  render(<PrintPanel store={store} presenter={presenter} disabled={false} />);
  expect(screen.queryByRole('slider', { name: 'Horizontal rotation' })).toBeNull();
  expect(screen.queryByRole('slider', { name: 'Vertical rotation' })).toBeNull();
  expect(requests).toBe(1);
  expect(screen.queryByRole('button', { name: 'Enable tilt' })).toBeNull();
  act(() => events.dispatchEvent(Object.assign(new window.Event('deviceorientation'), { alpha: 0, beta: 90, gamma: 0 })));
  expect(screen.getByText('Tilt your phone to move the reflections.')).toBeTruthy();
  act(() => screen.getByRole('button', { name: 'Recenter tilt' }).click());
  expect(store.tiltStatus).toBe('waiting');
  expect(store.scene).toMatchObject({ yawDegrees: 0, pitchDegrees: 0 });
});

test('desktop print retains its rotation controls', () => {
  const store = new PrintStore();
  presenter = new PrintPresenter(store, () => {}, null);
  presenter.setOpen(true);
  render(<PrintPanel store={store} presenter={presenter} disabled={false} />);
  expect(screen.getByRole('slider', { name: 'Horizontal rotation' })).toBeTruthy();
  expect(screen.getByRole('slider', { name: 'Vertical rotation' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Enable tilt' })).toBeNull();
});

test('light size slides in decades, so a lamp gets as much track as a softbox', () => {
  const store = new PrintStore();
  presenter = new PrintPresenter(store, () => {}, null);
  render(<PrintPanel store={store} presenter={presenter} disabled={false} section="lighting" />);
  const size = screen.getByRole('slider', { name: 'Light size' });
  expect(size.getAttribute('min')).toBe('-1');
  expect(size.getAttribute('max')).toBe(String(Math.log10(90)));
  expect(size.getAttribute('aria-valuenow')).toBe('0');
  expect(size.getAttribute('aria-valuetext')).toBe('1.0°');
  // Halfway along the track is the geometric middle of the range, not 45°.
  act(() => presenter?.setControl('lightAngularDegrees', 10 ** ((-1 + Math.log10(90)) / 2)));
  expect(store.scene.lightAngularDegrees).toBeCloseTo(3, 5);
  expect(screen.getByRole('slider', { name: 'Light size' }).getAttribute('aria-valuetext')).toBe('3.0°');
});

test('a moved slider offers its way back, and a slider at rest does not', () => {
  const store = new PrintStore();
  presenter = new PrintPresenter(store, () => {}, null);
  render(<PrintPanel store={store} presenter={presenter} disabled={false} section="lighting" />);
  const reset = screen.getByRole<HTMLButtonElement>('button', { name: 'Reset Light forward' });
  expect(reset.disabled).toBe(true);
  act(() => presenter?.setControl('lightForward', 4));
  expect(reset.disabled).toBe(false);
  act(() => reset.click());
  expect(store.scene.lightForward).toBe(1.7);
  expect(reset.disabled).toBe(true);
});

test('the roll-off names the operator the print is drawn with', () => {
  const store = new PrintStore();
  let redraws = 0;
  presenter = new PrintPresenter(store, () => { redraws += 1; }, null);
  render(<PrintPanel store={store} presenter={presenter} disabled={false} section="paper" />);
  const roll = screen.getByRole('combobox', { name: 'Highlight roll-off' });
  expect(roll.textContent).toBe('Neutral');
  act(() => presenter?.setTonemap('channel'));
  expect(store.scene.tonemap).toBe('channel');
  expect(redraws).toBe(1);
  expect(screen.getByRole('combobox', { name: 'Highlight roll-off' }).textContent).toBe('Per channel');
});

test('paper settings toggle framing and disable it with the other controls', () => {
  const store = new PrintStore();
  let redraws = 0;
  presenter = new PrintPresenter(store, () => { redraws += 1; }, null);
  const { rerender } = render(<PrintPanel store={store} presenter={presenter} disabled={false} section="paper" />);
  const frame = screen.getByRole<HTMLInputElement>('checkbox', { name: 'Add frame' });
  expect(frame.checked).toBe(false);
  act(() => frame.click());
  expect(frame.checked).toBe(true);
  expect(store.scene.framed).toBe(true);
  expect(redraws).toBe(1);

  rerender(<PrintPanel store={store} presenter={presenter} disabled={true} section="paper" />);
  expect(frame.disabled).toBe(true);
  act(() => frame.click());
  expect(frame.checked).toBe(true);
  expect(redraws).toBe(1);

  rerender(<PrintPanel store={store} presenter={presenter} disabled={false} section="paper" />);
  act(() => frame.click());
  expect(frame.checked).toBe(false);
  expect(store.scene.framed).toBe(false);
  expect(redraws).toBe(2);
});
