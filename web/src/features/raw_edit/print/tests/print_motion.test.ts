import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import type { PrintMotionEnvironment } from '../print_motion';
import { PrintPresenter } from '../print_presenter';
import { PrintStore } from '../print_store';

class MotionEvents {
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (listener == null) return;
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (listener != null) this.listeners.get(type)?.delete(listener);
  }

  emit(event: Event): void {
    for (const listener of this.listeners.get(event.type) ?? []) {
      if (typeof listener === 'function') listener(event);
      else listener.handleEvent(event);
    }
  }

  count(type: string): number { return this.listeners.get(type)?.size ?? 0; }
}

class Visibility extends MotionEvents {
  hidden = false;

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    this.emit(new Event('visibilitychange'));
  }
}

class MotionHarness {
  readonly events = new MotionEvents();
  readonly visibility = new Visibility();
  readonly screenEvents = new MotionEvents();
  readonly store = new PrintStore();
  readonly redraw = jest.fn();
  readonly presenter: PrintPresenter;
  angle = 0;
  private time = 0;
  private readonly frames = new Map<number, FrameRequestCallback>();
  private nextFrame = 0;

  constructor(requestPermission: PrintMotionEnvironment['requestPermission'] = null) {
    this.presenter = new PrintPresenter(this.store, this.redraw, {
      events: this.events,
      visibility: this.visibility,
      screenEvents: this.screenEvents,
      screenAngle: () => this.angle,
      requestPermission,
      requestFrame: (callback) => {
        const id = ++this.nextFrame;
        this.frames.set(id, callback);
        return id;
      },
      cancelFrame: (id) => { this.frames.delete(id); },
      now: () => this.time,
    });
  }

  open(): void {
    this.presenter.setSurface(true);
    this.presenter.setOpen(true);
  }

  orient(alpha: number | null, beta: number | null, gamma: number | null, count = 1): void {
    for (let i = 0; i < count; i += 1) {
      this.sample(alpha, beta, gamma);
      this.frame(16);
    }
  }

  sample(alpha: number | null, beta: number | null, gamma: number | null): void {
    this.events.emit(Object.assign(new Event('deviceorientation'), { alpha, beta, gamma }));
  }

  frame(elapsed = 1000 / 120): void {
    this.time += elapsed;
    const pending = [...this.frames.values()];
    this.frames.clear();
    for (const callback of pending) callback(this.time);
  }

  get pendingFrames(): number { return this.frames.size; }
}

let harness: MotionHarness;
beforeEach(() => { jest.useFakeTimers(); harness = new MotionHarness(); });
afterEach(() => { harness.presenter.close(); jest.useRealTimers(); });

describe('print surface motion', () => {
  test('draws intermediate poses on a 120 Hz display from 60 Hz sensor samples', () => {
    harness.open();
    harness.sample(0, 90, 0);
    harness.redraw.mockClear();
    let previous = 0;
    for (let sample = 0; sample < 6; sample += 1) {
      const target = 20 + sample * 5;
      harness.sample(target, 90, 0);
      for (let frame = 0; frame < 2; frame += 1) {
        harness.frame();
        const yaw = harness.store.scene.yawDegrees;
        expect(yaw).toBeGreaterThan(previous);
        expect(yaw).toBeLessThan(target);
        previous = yaw;
      }
    }
    expect(harness.redraw).toHaveBeenCalledTimes(12);
    for (let frame = 0; frame < 120; frame += 1) harness.frame();
    expect(harness.store.scene.yawDegrees).toBeCloseTo(45, 6);
    expect(harness.pendingFrames).toBe(0);
    harness.redraw.mockClear();
    harness.sample(45, 90, 0);
    harness.frame();
    expect(harness.redraw).not.toHaveBeenCalled();
    expect(harness.pendingFrames).toBe(0);
  });

  test('cancels interpolated motion on recenter, hiding, mode changes and close', () => {
    const moving = (): void => {
      harness.sample(0, 90, 0);
      harness.sample(30, 90, 0);
      harness.frame();
      expect(harness.pendingFrames).toBe(1);
    };
    harness.open();
    moving();
    harness.presenter.resetTilt();
    expect(harness.pendingFrames).toBe(0);
    harness.frame();
    expect(harness.store.scene.yawDegrees).toBe(0);
    moving();
    harness.visibility.setHidden(true);
    expect(harness.pendingFrames).toBe(0);
    harness.visibility.setHidden(false);
    moving();
    harness.presenter.setSurface(false);
    expect(harness.pendingFrames).toBe(0);
    harness.presenter.setSurface(true);
    moving();
    harness.presenter.close();
    expect(harness.pendingFrames).toBe(0);
    const calls = harness.redraw.mock.calls.length;
    harness.frame();
    expect(harness.redraw.mock.calls.length).toBe(calls);
  });

  test('new heading and screen references cancel an unfinished tilt', () => {
    harness.open();
    harness.sample(null, 90, 0);
    harness.sample(null, 90, 20);
    harness.frame();
    expect(harness.pendingFrames).toBe(1);
    harness.sample(80, 90, 20);
    expect(harness.store.scene.yawDegrees).toBe(0);
    expect(harness.pendingFrames).toBe(0);
    harness.sample(90, 90, 20);
    harness.frame();
    expect(harness.pendingFrames).toBe(1);
    harness.angle = 90;
    harness.sample(90, 90, 20);
    expect(harness.pendingFrames).toBe(0);
    harness.frame();
    expect(harness.store.scene).toMatchObject({ yawDegrees: 0, pitchDegrees: 0 });
  });

  test('calibrates without jumping and maps upright-phone motion to the rendered pose', () => {
    harness.open();
    expect(harness.store.scene).toMatchObject({ presentation: 'surface', yawDegrees: 0, pitchDegrees: 0 });
    harness.orient(40, 90, 0);
    expect(harness.store.tiltStatus).toBe('active');
    expect(harness.store.scene.yawDegrees).toBe(0);
    harness.orient(60, 90, 0, 50);
    expect(Math.abs(harness.store.scene.yawDegrees - 20)).toBeLessThan(0.1);
    expect(harness.store.scene.pitchDegrees).toBeCloseTo(0, 1);
    expect(harness.redraw).toHaveBeenCalled();
    harness.presenter.resetTilt();
    harness.orient(60, 90, 0);
    harness.orient(60, 105, 0, 50);
    expect(harness.store.scene.yawDegrees).toBeCloseTo(0, 1);
    expect(Math.abs(harness.store.scene.pitchDegrees - 15)).toBeLessThan(0.1);
  });

  test('handles heading and beta wrap without large jumps', () => {
    harness.open();
    harness.orient(359, 90, 0);
    harness.orient(1, 90, 0, 50);
    expect(Math.abs(harness.store.scene.yawDegrees - 2)).toBeLessThan(0.1);
    harness.presenter.resetTilt();
    harness.orient(0, 179, 0);
    harness.orient(0, -179, 0, 50);
    expect(Math.abs(harness.store.scene.pitchDegrees - 2)).toBeLessThan(0.1);
  });

  test('remaps landscape axes and recenters after screen rotation', () => {
    harness.angle = 90;
    harness.open();
    harness.orient(0, 90, 0);
    harness.orient(20, 90, 0, 50);
    expect(harness.store.scene.yawDegrees).toBeCloseTo(0, 1);
    expect(Math.abs(harness.store.scene.pitchDegrees + 20)).toBeLessThan(0.1);
    harness.angle = 0;
    harness.screenEvents.emit(new Event('change'));
    expect(harness.store.scene.pitchDegrees).toBe(0);
    harness.orient(20, 90, 0);
    harness.orient(35, 90, 0, 50);
    expect(Math.abs(harness.store.scene.yawDegrees - 15)).toBeLessThan(0.1);
  });

  test('ignores malformed samples, smooths motion and suppresses sensor jitter', () => {
    harness.open();
    harness.orient(0, null, 0);
    harness.orient(0, Number.NaN, 0);
    harness.orient(0, 90, Number.POSITIVE_INFINITY);
    expect(harness.store.tiltStatus).toBe('waiting');
    harness.orient(0, 90, 0);
    harness.redraw.mockClear();
    harness.orient(0.02, 90, 0, 10);
    expect(harness.redraw).not.toHaveBeenCalled();
    harness.orient(30, 90, 0);
    expect(harness.store.scene.yawDegrees).toBeGreaterThan(0);
    expect(harness.store.scene.yawDegrees).toBeLessThan(15);
    harness.orient(89, 90, 0, 50);
    expect(Math.abs(harness.store.scene.yawDegrees - 70)).toBeLessThan(0.1);
  });

  test('uses heading-free tilt and recenters if heading becomes available', () => {
    harness.open();
    harness.orient(null, 90, 0);
    harness.orient(null, 90, 20, 50);
    expect(harness.store.tiltStatus).toBe('active');
    expect(Math.abs(harness.store.scene.yawDegrees - 20)).toBeLessThan(0.1);
    harness.orient(80, 90, 20);
    expect(harness.store.scene.yawDegrees).toBe(0);
  });

  test('surface controls preserve and restore desktop rotation', () => {
    harness.presenter.setOpen(true);
    harness.presenter.rotateBy(30, 20);
    const desktop = { yawDegrees: harness.store.scene.yawDegrees, pitchDegrees: harness.store.scene.pitchDegrees };
    harness.presenter.setSurface(true);
    harness.presenter.beginDrag(1, 0, 0, 100);
    harness.presenter.moveDrag(1, 60, 30);
    harness.presenter.rotateBy(45, 20);
    harness.presenter.resetRotation();
    harness.presenter.setControl('yawDegrees', 40);
    expect(harness.store.dragging).toBe(false);
    expect(harness.store.scene).toMatchObject({ yawDegrees: 0, pitchDegrees: 0 });
    harness.orient(0, 90, 0);
    harness.orient(20, 90, 0, 50);
    harness.presenter.setSurface(false);
    expect(harness.store.scene).toMatchObject({ presentation: 'scene', ...desktop });
    expect(harness.events.count('deviceorientation')).toBe(0);
    harness.orient(50, 90, 0, 50);
    expect(harness.store.scene).toMatchObject(desktop);
  });

  test('pauses hidden sensors and removes listeners and timers on close', () => {
    harness.open();
    expect(harness.events.count('deviceorientation')).toBe(1);
    harness.visibility.setHidden(true);
    expect(harness.events.count('deviceorientation')).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
    const hiddenCalls = harness.redraw.mock.calls.length;
    harness.orient(20, 90, 0);
    harness.screenEvents.emit(new Event('change'));
    harness.events.emit(new Event('orientationchange'));
    expect(harness.redraw.mock.calls.length).toBe(hiddenCalls);
    harness.visibility.setHidden(false);
    expect(harness.events.count('deviceorientation')).toBe(1);
    harness.orient(30, 90, 0);
    expect(harness.store.scene.yawDegrees).toBe(0);
    harness.presenter.resetTilt();
    expect(jest.getTimerCount()).toBe(1);
    harness.presenter.close();
    expect(jest.getTimerCount()).toBe(0);
    expect(harness.events.count('deviceorientation')).toBe(0);
    expect(harness.events.count('orientationchange')).toBe(0);
    expect(harness.visibility.count('visibilitychange')).toBe(0);
    expect(harness.screenEvents.count('change')).toBe(0);
    const calls = harness.redraw.mock.calls.length;
    jest.advanceTimersByTime(3000);
    harness.visibility.setHidden(true);
    harness.visibility.setHidden(false);
    harness.orient(50, 90, 0);
    expect(harness.redraw.mock.calls.length).toBe(calls);
    expect(harness.store.tiltStatus).toBe('unavailable');
  });

  test('leaves the full photo usable when no sensor samples arrive', () => {
    harness.open();
    jest.advanceTimersByTime(2500);
    expect(harness.store.tiltStatus).toBe('unavailable');
    expect(harness.store.scene).toMatchObject({ presentation: 'surface', yawDegrees: 0, pitchDegrees: 0 });
    harness.orient(0, 90, 0);
    expect(harness.store.tiltStatus).toBe('active');
  });

  test('keeps a static surface when the browser has no motion API', async () => {
    const store = new PrintStore();
    const presenter = new PrintPresenter(store, jest.fn(), null);
    presenter.setSurface(true);
    presenter.setOpen(true);
    await presenter.enableTilt();
    expect(store.tiltStatus).toBe('unavailable');
    expect(store.scene).toMatchObject({ presentation: 'surface', yawDegrees: 0, pitchDegrees: 0 });
    expect(jest.getTimerCount()).toBe(0);
    presenter.close();
  });

  test('requests tilt permission immediately on opening and remembers the grant', async () => {
    const permission = jest.fn(async () => 'granted');
    harness = new MotionHarness(permission);
    harness.open();
    expect(permission).toHaveBeenCalledTimes(1);
    expect(harness.store.tiltStatus).toBe('waiting');
    expect(harness.events.count('deviceorientation')).toBe(0);
    await Promise.resolve();
    expect(permission).toHaveBeenCalledTimes(1);
    harness.orient(0, 90, 0);
    harness.visibility.setHidden(true);
    harness.visibility.setHidden(false);
    expect(harness.events.count('deviceorientation')).toBe(1);
    expect(permission).toHaveBeenCalledTimes(1);
  });

  test('denial keeps a static surface and does not attach sensor listeners', async () => {
    harness = new MotionHarness(async () => 'denied');
    harness.open();
    await harness.presenter.enableTilt();
    expect(harness.store.tiltStatus).toBe('denied');
    expect(harness.events.count('deviceorientation')).toBe(0);
    expect(harness.store.scene).toMatchObject({ presentation: 'surface', yawDegrees: 0, pitchDegrees: 0 });
  });

  test('a browser requiring another gesture keeps the explicit tilt action available', async () => {
    harness = new MotionHarness(async () => { throw new Error('permission unavailable'); });
    harness.open();
    await harness.presenter.enableTilt();
    expect(harness.store.tiltStatus).toBe('permission');
    expect(harness.events.count('deviceorientation')).toBe(0);
    expect(harness.store.surface).toBe(true);
  });

  test('a permission grant arriving after close cannot resubscribe', async () => {
    let grant = (_state: string): void => {};
    const permission = new Promise<string>((resolve) => { grant = resolve; });
    harness = new MotionHarness(() => permission);
    harness.open();
    const enabling = harness.presenter.enableTilt();
    harness.presenter.close();
    grant('granted');
    await enabling;
    expect(harness.store.open).toBe(false);
    expect(harness.events.count('deviceorientation')).toBe(0);
    expect(harness.visibility.count('visibilitychange')).toBe(0);
    expect(harness.store.tiltStatus).toBe('unavailable');
  });

  test('switching to desktop cancels an outstanding permission request', async () => {
    let grant = (_state: string): void => {};
    const permission = new Promise<string>((resolve) => { grant = resolve; });
    harness = new MotionHarness(() => permission);
    harness.open();
    const enabling = harness.presenter.enableTilt();
    harness.presenter.setSurface(false);
    grant('granted');
    await enabling;
    expect(harness.events.count('deviceorientation')).toBe(0);
    expect(harness.store.scene).toMatchObject({ presentation: 'scene', yawDegrees: -12, pitchDegrees: 8 });
  });

  test('a grant received while hidden only starts sensors after the page returns', async () => {
    let grant = (_state: string): void => {};
    const permission = new Promise<string>((resolve) => { grant = resolve; });
    harness = new MotionHarness(() => permission);
    harness.open();
    const enabling = harness.presenter.enableTilt();
    harness.visibility.setHidden(true);
    grant('granted');
    await enabling;
    expect(harness.events.count('deviceorientation')).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
    harness.visibility.setHidden(false);
    expect(harness.events.count('deviceorientation')).toBe(1);
    expect(harness.store.tiltStatus).toBe('waiting');
  });
});
