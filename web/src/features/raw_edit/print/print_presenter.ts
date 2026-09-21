import { action } from 'mobx';
import { DEFAULT_PRINT_SCENE, PAPER_MATERIALS, PrintSceneSchema, type Paper, type PrintControl } from './print_scene';
import { browserPrintMotion, PrintMotion, type PrintMotionEnvironment } from './print_motion';
import type { PrintStore } from './print_store';

type Drag = {
  pointerId: number;
  x: number;
  y: number;
  span: number;
  yaw: number;
  pitch: number;
};

export class PrintPresenter {
  private drag: Drag | null = null;
  private desktopRotation = { yawDegrees: DEFAULT_PRINT_SCENE.yawDegrees, pitchDegrees: DEFAULT_PRINT_SCENE.pitchDegrees };
  private readonly tilt = new PrintMotion();
  private watching = false;
  private listening = false;
  private permission: 'unknown' | 'granted' | 'denied' = 'unknown';
  private permissionEpoch = 0;
  private awaitingPermission = false;
  private waitingTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly store: PrintStore,
    private readonly redraw: () => void,
    private readonly motion: PrintMotionEnvironment | null = browserPrintMotion(),
  ) {}

  @action.bound
  setOpen = (open: boolean): void => {
    this.endDrag();
    this.store.open = open;
    this.syncTilt();
    this.redraw();
  };

  @action.bound
  setSurface = (surface: boolean): void => {
    if (surface === this.store.surface) return;
    this.endDrag();
    this.stopTilt();
    if (surface) {
      this.desktopRotation = { yawDegrees: this.store.scene.yawDegrees, pitchDegrees: this.store.scene.pitchDegrees };
    }
    this.store.scene = {
      ...this.store.scene,
      presentation: surface ? 'surface' : 'scene',
      ...(surface ? { yawDegrees: 0, pitchDegrees: 0 } : this.desktopRotation),
    };
    this.syncTilt();
    this.redraw();
  };

  @action.bound
  enableTilt = async (): Promise<void> => {
    if (!this.store.open || !this.store.surface || this.motion == null || this.motion.visibility.hidden || this.awaitingPermission) return;
    if (this.motion.requestPermission == null || this.permission === 'granted') {
      this.startListening();
      return;
    }
    const epoch = ++this.permissionEpoch;
    this.awaitingPermission = true;
    this.store.tiltStatus = 'waiting';
    try {
      this.permissionResult(epoch, await this.motion.requestPermission());
    } catch {
      this.permissionResult(epoch, 'denied');
    }
  };

  @action.bound
  private permissionResult = (epoch: number, permission: unknown): void => {
    if (epoch !== this.permissionEpoch) return;
    this.awaitingPermission = false;
    this.permission = permission === 'granted' ? 'granted' : 'denied';
    this.syncTilt();
  };

  @action.bound
  resetTilt = (): void => {
    if (!this.store.open || !this.store.surface || this.motion?.visibility.hidden) return;
    this.tilt.reset();
    this.rotate(0, 0);
    if (this.listening) this.waitForTilt();
  };

  @action.bound
  close = (): void => {
    this.endDrag();
    this.store.open = false;
    this.stopTilt();
  };

  @action.bound
  private syncTilt = (): void => {
    if (!this.store.open || !this.store.surface || this.motion == null) {
      this.stopTilt();
      return;
    }
    if (!this.watching) {
      this.motion.visibility.addEventListener('visibilitychange', this.syncTilt);
      this.motion.events.addEventListener('orientationchange', this.resetTilt);
      this.motion.screenEvents?.addEventListener('change', this.resetTilt);
      this.watching = true;
    }
    if (this.motion.visibility.hidden) {
      this.stopListening();
      return;
    }
    if (this.motion.requestPermission != null && this.permission !== 'granted') {
      this.store.tiltStatus = this.permission === 'denied' ? 'denied' : 'permission';
      return;
    }
    this.startListening();
  };

  private startListening(): void {
    if (this.listening || this.motion == null) return;
    this.listening = true;
    this.tilt.reset();
    this.rotate(0, 0);
    this.motion.events.addEventListener('deviceorientation', this.receiveTilt);
    this.waitForTilt();
  }

  private waitForTilt(): void {
    this.clearWaitingTimer();
    this.store.tiltStatus = 'waiting';
    this.waitingTimer = setTimeout(this.tiltUnavailable, 2500);
  }

  @action.bound
  private tiltUnavailable = (): void => {
    this.waitingTimer = null;
    if (this.listening && this.store.tiltStatus === 'waiting') this.store.tiltStatus = 'unavailable';
  };

  @action.bound
  private receiveTilt = (event: Event): void => {
    if (!this.listening || this.motion == null || this.motion.visibility.hidden) return;
    const tilt = this.tilt.read(event, this.motion.screenAngle());
    if (tilt == null) return;
    this.clearWaitingTimer();
    this.store.tiltStatus = 'active';
    if (Math.abs(tilt.yaw - this.store.scene.yawDegrees) < 0.08 && Math.abs(tilt.pitch - this.store.scene.pitchDegrees) < 0.08) return;
    this.rotate(tilt.yaw, tilt.pitch);
  };

  private stopTilt(): void {
    this.permissionEpoch += 1;
    this.awaitingPermission = false;
    this.stopListening();
    if (this.watching && this.motion != null) {
      this.motion.visibility.removeEventListener('visibilitychange', this.syncTilt);
      this.motion.events.removeEventListener('orientationchange', this.resetTilt);
      this.motion.screenEvents?.removeEventListener('change', this.resetTilt);
    }
    this.watching = false;
    this.store.tiltStatus = 'unavailable';
  }

  private stopListening(): void {
    this.motion?.events.removeEventListener('deviceorientation', this.receiveTilt);
    this.listening = false;
    this.tilt.reset();
    this.clearWaitingTimer();
    if (this.store.tiltStatus === 'active' || this.store.tiltStatus === 'waiting') this.store.tiltStatus = 'waiting';
  }

  private clearWaitingTimer(): void {
    if (this.waitingTimer != null) clearTimeout(this.waitingTimer);
    this.waitingTimer = null;
  }

  @action.bound
  setPaper = (paper: Paper): void => {
    this.store.scene = { ...this.store.scene, paper, ...PAPER_MATERIALS[paper] };
    this.redraw();
  };

  @action.bound
  setControl = (key: PrintControl, value: number): void => {
    if (this.store.surface && (key === 'yawDegrees' || key === 'pitchDegrees')) return;
    const parsed = PrintSceneSchema.safeParse({ ...this.store.scene, [key]: value });
    if (!parsed.success) return;
    this.store.scene = parsed.data;
    this.redraw();
  };

  @action.bound
  resetRotation = (): void => {
    if (this.store.surface) return;
    this.endDrag();
    this.store.scene = {
      ...this.store.scene,
      yawDegrees: DEFAULT_PRINT_SCENE.yawDegrees,
      pitchDegrees: DEFAULT_PRINT_SCENE.pitchDegrees,
    };
    this.redraw();
  };

  @action.bound
  beginDrag = (pointerId: number, x: number, y: number, span: number): void => {
    if (!this.store.open || this.store.surface || this.drag != null || span <= 0) return;
    this.drag = { pointerId, x, y, span, yaw: this.store.scene.yawDegrees, pitch: this.store.scene.pitchDegrees };
    this.store.dragging = true;
  };

  @action.bound
  moveDrag = (pointerId: number, x: number, y: number): void => {
    const drag = this.drag;
    if (drag == null || drag.pointerId !== pointerId) return;
    this.rotate(drag.yaw + ((x - drag.x) / drag.span) * 180, drag.pitch + ((y - drag.y) / drag.span) * 180);
  };

  @action.bound
  rotateBy = (yaw: number, pitch: number): void => {
    if (this.store.surface) return;
    this.rotate(this.store.scene.yawDegrees + yaw, this.store.scene.pitchDegrees + pitch);
  };

  @action.bound
  endDrag = (pointerId?: number): void => {
    if (pointerId != null && this.drag?.pointerId !== pointerId) return;
    this.drag = null;
    this.store.dragging = false;
  };

  private rotate(yaw: number, pitch: number): void {
    this.store.scene = {
      ...this.store.scene,
      yawDegrees: ((yaw + 180) % 360 + 360) % 360 - 180,
      pitchDegrees: Math.max(-85, Math.min(85, pitch)),
    };
    this.redraw();
  }
}
