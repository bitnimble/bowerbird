import { z } from 'zod';

type MotionEvents = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

export type PrintMotionEnvironment = {
  events: MotionEvents;
  visibility: MotionEvents & Pick<Document, 'hidden'>;
  screenEvents: MotionEvents | null;
  screenAngle: () => number;
  requestPermission: (() => Promise<unknown>) | null;
  requestFrame: (callback: FrameRequestCallback) => number;
  cancelFrame: (id: number) => void;
  now: () => number;
};

export function browserPrintMotion(): PrintMotionEnvironment | null {
  if (typeof window === 'undefined' || !window.isSecureContext || typeof window.DeviceOrientationEvent === 'undefined') return null;
  const orientation = window.DeviceOrientationEvent;
  const permission: unknown = Reflect.get(orientation, 'requestPermission');
  return {
    events: window,
    visibility: document,
    screenEvents: window.screen.orientation ?? null,
    screenAngle: () => {
      const legacy: unknown = Reflect.get(window, 'orientation');
      return window.screen.orientation?.angle ?? (typeof legacy === 'number' ? legacy : 0);
    },
    requestPermission: typeof permission === 'function' ? async () => permission.call(orientation) : null,
    requestFrame: (callback) => window.requestAnimationFrame(callback),
    cancelFrame: (id) => window.cancelAnimationFrame(id),
    now: () => performance.now(),
  };
}

const OrientationSchema = z.object({
  alpha: z.number().finite().nullable(),
  beta: z.number().finite(),
  gamma: z.number().finite(),
});

type Vector = readonly [number, number, number];
type Basis = readonly [Vector, Vector, Vector];
export type PrintTilt = { yaw: number; pitch: number };

export class PrintMotion {
  private baseline: Basis | null = null;
  private angle = 0;
  private hasHeading = false;

  reset(): void {
    this.baseline = null;
  }

  read(event: Event, screenAngle: number): PrintTilt | 'recenter' | null {
    const parsed = OrientationSchema.safeParse(event);
    if (!parsed.success || !Number.isFinite(screenAngle)) return null;
    const { alpha: heading, beta, gamma } = parsed.data;
    const alpha = heading ?? 0;
    const [sa, ca] = [Math.sin(alpha * Math.PI / 180), Math.cos(alpha * Math.PI / 180)];
    const [sb, cb] = [Math.sin(beta * Math.PI / 180), Math.cos(beta * Math.PI / 180)];
    const [sg, cg] = [Math.sin(gamma * Math.PI / 180), Math.cos(gamma * Math.PI / 180)];
    const right: Vector = [ca * cg - sa * sb * sg, sa * cg + ca * sb * sg, -cb * sg];
    const up: Vector = [-sa * cb, ca * cb, sb];
    const normal: Vector = [ca * sg + sa * sb * cg, sa * sg - ca * sb * cg, cb * cg];
    const angle = ((screenAngle % 360) + 360) % 360;
    if (this.baseline == null || angle !== this.angle || this.hasHeading !== (heading != null)) {
      const sine = Math.sin(angle * Math.PI / 180);
      const cosine = Math.cos(angle * Math.PI / 180);
      const screenRight: Vector = [right[0] * cosine - up[0] * sine, right[1] * cosine - up[1] * sine, right[2] * cosine - up[2] * sine];
      const screenUp: Vector = [right[0] * sine + up[0] * cosine, right[1] * sine + up[1] * cosine, right[2] * sine + up[2] * cosine];
      this.baseline = [screenRight, screenUp, normal];
      this.angle = angle;
      this.hasHeading = heading != null;
      return 'recenter';
    }
    const dot = (axis: Vector): number => axis[0] * normal[0] + axis[1] * normal[1] + axis[2] * normal[2];
    const x = dot(this.baseline[0]);
    const y = dot(this.baseline[1]);
    const z = dot(this.baseline[2]);
    const yaw = Math.max(-70, Math.min(70, Math.asin(Math.max(-1, Math.min(1, x))) * 180 / Math.PI));
    const pitch = Math.max(-70, Math.min(70, Math.atan2(-y, z) * 180 / Math.PI));
    return { yaw, pitch };
  }
}
