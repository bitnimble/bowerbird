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

test('mobile print replaces rotation controls with permission and recenter actions', async () => {
  let requests = 0;
  const events = new window.EventTarget();
  const motion: PrintMotionEnvironment = {
    events, visibility: Object.assign(new window.EventTarget(), { hidden: false }),
    screenEvents: null, screenAngle: () => 0,
    requestPermission: async () => { requests += 1; return 'granted'; },
  };
  const store = new PrintStore();
  presenter = new PrintPresenter(store, () => {}, motion);
  presenter.setSurface(true);
  presenter.setOpen(true);
  render(<PrintPanel store={store} presenter={presenter} disabled={false} />);
  expect(screen.queryByRole('slider', { name: 'Horizontal rotation' })).toBeNull();
  expect(screen.queryByRole('slider', { name: 'Vertical rotation' })).toBeNull();
  expect(requests).toBe(0);
  await act(async () => screen.getByRole('button', { name: 'Enable tilt' }).click());
  expect(requests).toBe(1);
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
