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

test('mobile print requests motion access on opening and offers recentring', async () => {
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
  presenter.setTouch(true);
  await act(async () => presenter?.setView('sheet'));
  render(<PrintPanel store={store} presenter={presenter} disabled={false} section="orientation" />);
  expect(screen.queryByRole('slider', { name: 'Horizontal rotation' })).toBeNull();
  expect(screen.queryByRole('slider', { name: 'Vertical rotation' })).toBeNull();
  expect(requests).toBe(1);
  expect(screen.queryByRole('button', { name: 'Enable tilt' })).toBeNull();
  act(() => events.dispatchEvent(Object.assign(new window.Event('deviceorientation'), { alpha: 0, beta: 90, gamma: 0 })));
  expect(screen.getByText('Tilt your phone to move the reflections.')).toBeTruthy();
  act(() => screen.getByRole('button', { name: 'Recentre tilt' }).click());
  expect(store.tiltStatus).toBe('waiting');
  expect(store.scene).toMatchObject({ yawDegrees: 0, pitchDegrees: 0 });
});

test('desktop print retains its rotation controls', () => {
  const store = new PrintStore();
  presenter = new PrintPresenter(store, () => {}, null);
  presenter.setView('sheet');
  render(<PrintPanel store={store} presenter={presenter} disabled={false} section="orientation" />);
  expect(screen.getByRole('slider', { name: 'Horizontal rotation' })).toBeTruthy();
  expect(screen.getByRole('slider', { name: 'Vertical rotation' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Enable tilt' })).toBeNull();
});

test('light size slides in decades, so a pinpoint lamp gets as much track as a broad one', () => {
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

test('the rendering intent names the intent the print is drawn with', () => {
  const store = new PrintStore();
  let redraws = 0;
  presenter = new PrintPresenter(store, () => { redraws += 1; }, null);
  render(<PrintPanel store={store} presenter={presenter} disabled={false} section="printer" />);
  expect(screen.getByRole('combobox', { name: 'Rendering intent' }).textContent).toBe('Perceptual');
  act(() => presenter?.setRenderingIntent('absoluteColorimetric'));
  expect(store.scene.renderingIntent).toBe('absoluteColorimetric');
  expect(redraws).toBe(1);
  expect(screen.getByRole('combobox', { name: 'Rendering intent' }).textContent).toBe('Absolute colorimetric');
});

test('an sRGB proof offers the intents a file can be written with', () => {
  const store = new PrintStore();
  presenter = new PrintPresenter(store, () => {}, null);
  render(<PrintPanel store={store} presenter={presenter} disabled={false} section="srgb" />);
  expect(screen.getByRole('combobox', { name: 'Rendering intent' }).textContent).toBe('Perceptual');
});

test('a flat print offers the paper and the ink and nothing a surface needs light to show', () => {
  const store = new PrintStore();
  presenter = new PrintPresenter(store, () => {}, null);
  presenter.setView('flat');
  render(<PrintPanel store={store} presenter={presenter} disabled={false} section="paper" />);
  expect(screen.getByRole('combobox', { name: 'Paper' })).toBeTruthy();
  expect(screen.getByRole('slider', { name: 'Paper reflectance' })).toBeTruthy();
  expect(screen.getByRole('slider', { name: 'Black reflectance' })).toBeTruthy();
  expect(screen.queryByRole('slider', { name: 'Surface roughness' })).toBeNull();
  expect(screen.queryByRole('slider', { name: 'Paper texture' })).toBeNull();
  expect(screen.queryByRole('checkbox', { name: 'Add frame' })).toBeNull();
});

test('a printer profile takes over the paper white and black', async () => {
  const store = new PrintStore();
  const printer = new PrintPresenter(store, () => {}, null, {
    list: () => Promise.resolve(['Satin.icc']),
    bytes: () => Promise.resolve(new Uint8Array(4)),
  });
  presenter = printer;
  render(<>
    <PrintPanel store={store} presenter={printer} disabled={false} section="printer" />
    <PrintPanel store={store} presenter={printer} disabled={false} section="paper" />
  </>);
  expect(screen.getByRole('combobox', { name: 'Printer profile' }).textContent).toBe('Generic paper');
  expect(screen.getByRole<HTMLInputElement>('slider', { name: 'Paper reflectance' }).disabled).toBe(false);

  await act(() => printer.setPrinterProfile('Satin.icc'));
  expect(screen.getByRole('combobox', { name: 'Printer profile' }).textContent).toBe('Satin.icc');
  expect(screen.getByRole<HTMLInputElement>('slider', { name: 'Paper reflectance' }).disabled).toBe(true);
  expect(screen.getByText('The printer profile sets paper white and black.')).toBeTruthy();
});

test('black point compensation is offered only where relative colorimetric would clip the black', () => {
  const store = new PrintStore();
  presenter = new PrintPresenter(store, () => {}, null);
  render(<PrintPanel store={store} presenter={presenter} disabled={false} section="printer" />);
  expect(screen.queryByRole('checkbox', { name: 'Black point compensation' })).toBeNull();
  act(() => presenter?.setRenderingIntent('relativeColorimetric'));
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Black point compensation' }).checked).toBe(true);
  act(() => presenter?.setRenderingIntent('absoluteColorimetric'));
  expect(screen.queryByRole('checkbox', { name: 'Black point compensation' })).toBeNull();
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
