const TOUCH_SLOP_PX = 10;
export const LONG_PRESS_MS = 250;

export interface TouchTrack {
  from: number;
  min: number;
  max: number;
  step: number;
  left: number;
  width: number;
  onThumb: boolean;
}

export interface TouchDragHost {
  start: () => void;
  change: (value: number) => void;
  commit: (value: number) => void;
}

interface Press {
  pointerId: number;
  x: number;
  y: number;
  track: TouchTrack;
  host: TouchDragHost;
  started: boolean;
  value: number | null;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Holds a touch on a slider until it moves sideways or rests on the thumb, so a swipe can scroll. */
export class TouchDrag {
  private press: Press | null = null;

  get dragging(): boolean {
    return this.press?.started === true;
  }

  down(pointerId: number, x: number, y: number, track: TouchTrack, host: TouchDragHost): void {
    this.forget();
    if (track.width <= 0) return;
    const press: Press = {
      pointerId,
      x,
      y,
      track,
      host,
      started: false,
      value: null,
      timer: null,
    };
    if (track.onThumb) press.timer = setTimeout(() => this.start(press), LONG_PRESS_MS);
    this.press = press;
  }

  move(pointerId: number, x: number, y: number): void {
    const press = this.press;
    if (press == null || press.pointerId !== pointerId) return;
    if (press.started) {
      this.follow(press, x);
      return;
    }
    const across = Math.abs(x - press.x);
    const down = Math.abs(y - press.y);
    if (down > TOUCH_SLOP_PX && down >= across) {
      this.forget();
      return;
    }
    if (across <= TOUCH_SLOP_PX || across <= down) return;
    this.start(press);
    this.follow(press, x);
  }

  end(pointerId: number): void {
    const press = this.press;
    if (press == null || press.pointerId !== pointerId) return;
    this.forget();
    if (press.value != null) press.host.commit(press.value);
  }

  forget(): void {
    if (this.press?.timer != null) clearTimeout(this.press.timer);
    this.press = null;
  }

  private start(press: Press): void {
    if (press.timer != null) clearTimeout(press.timer);
    press.timer = null;
    press.started = true;
    press.host.start();
  }

  private follow(press: Press, x: number): void {
    const { from, min, max, step, left, width, onThumb } = press.track;
    const span = max - min;
    const raw = onThumb ? from + ((x - press.x) / width) * span : min + ((x - left) / width) * span;
    const stepped = min + Math.round((raw - min) / step) * step;
    press.value = Number(Math.min(max, Math.max(min, stepped)).toFixed(10));
    press.host.change(press.value);
  }
}
