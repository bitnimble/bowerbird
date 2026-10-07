import { action, comparer, observable, reaction, type IReactionDisposer } from 'mobx';
import { adjustOf } from '../../../../../src/schemas/edit_adjust';
import { describe } from '../../../errors';
import { newId } from '../../../../../src/schemas/id';
import {
  COLOUR_NODES_MAX,
  type ColourNode,
  type EditDoc,
} from '../../../../../src/schemas/photo_edits';
import type { EditStore } from '../edit/edit_store';
import type { WheelDrawn } from '../local_decode/local_open';
import type { LocalSource } from '../local_decode/open_photo';
import type { StageStore } from '../stage/stage_store';
import {
  CHANNELS,
  type Channel,
  type Hued,
  type Reach,
  chromaReachTo,
  hueReachTo,
  hued,
  inChannel,
  lightnessOf,
  movedSource,
  movedTarget,
  nodeAt,
  steppedReach,
} from './colour_wheel';
import type { ColourWheelStore, Dot, FieldArrow } from './colour_wheel_store';

export interface ColourWheelHost {
  local: () => LocalSource | null;
  preview: (patch: Partial<EditDoc>) => void;
  settle: (patch: Partial<EditDoc>) => void;
  fail: (why: string) => void;
  /** `displayPeakNits`, which the wheel's edge is drawn against. */
  displayPeak: () => number | null;
}

/** Runs one piece of work at a time, and of what arrives meanwhile only the latest. */
class Latest {
  private busy = false;
  private next: (() => Promise<void>) | null = null;

  async run(work: () => Promise<void>): Promise<void> {
    if (this.busy) {
      this.next = work;
      return;
    }
    this.busy = true;
    try {
      await work();
    } finally {
      this.busy = false;
    }
    const next = this.next;
    this.next = null;
    if (next != null) await this.run(next);
  }
}

export type Handle = 'source' | 'target' | Reach;

export const WHEEL_SIDE = 512;
const FIELD_HUES = 36;
const FIELD_RINGS = [0.45, 0.65, 0.85];

export class ColourWheelPresenter {
  /** Keys the backdrop's canvas to this photo's open: a transferred canvas cannot be transferred again. */
  readonly key = newId();
  @observable.ref private accessor canvas: HTMLCanvasElement | null = null;
  @observable private accessor attached = false;
  private atDragStart: readonly ColourNode[] | null = null;
  private closed = false;
  private probesAsked = 0;
  private readonly shading = new Latest();
  private readonly probing = new Latest();
  private readonly disposers: IReactionDisposer[];

  constructor(
    private readonly store: ColourWheelStore,
    private readonly edit: EditStore,
    private readonly stage: StageStore,
    private readonly host: ColourWheelHost,
  ) {
    this.forgetPhoto();
    this.disposers = [
      reaction(
        () => (this.stage.live ? this.canvas : null),
        (canvas) => {
          if (canvas != null) this.unlessClosed(this.handOver(canvas));
        },
        { fireImmediately: true },
      ),
      reaction(
        () => (this.attached ? { channel: this.store.channel } : null),
        (drawing) => {
          if (drawing != null) this.unlessClosed(this.draw(drawing.channel));
        },
        { equals: comparer.structural },
      ),
      reaction(
        () =>
          this.attached && this.store.drawn != null ? { node: this.store.selectedNode } : null,
        (shading) => {
          if (shading != null) this.unlessClosed(this.shading.run(() => this.shade()));
        },
        { equals: comparer.structural },
      ),
      reaction(
        () => {
          const doc = this.edit.doc;
          const shown = this.store.showDots || this.store.showField;
          return shown && this.attached && this.store.drawn != null && !this.stage.repreparing
            ? JSON.stringify([
                doc?.colourProfile,
                doc?.temperature,
                doc?.tint,
                doc?.awaitsCameraMatch,
                this.store.drawn.chroma,
              ])
            : null;
        },
        (key) => {
          if (key != null) this.unlessClosed(this.probing.run(() => this.probe()));
        },
      ),
    ];
  }

  @action.bound
  attach(canvas: HTMLCanvasElement | null): void {
    if (canvas === this.canvas) return;
    this.canvas = canvas;
    this.attached = false;
  }

  @action.bound
  selectChannel(channel: Channel): void {
    this.store.channel = channel;
    const selected = this.store.selectedNode;
    if (selected == null || !inChannel(selected, channel)) this.store.selectedIndex = null;
  }

  @action.bound
  setShowDots(on: boolean): void {
    this.store.showDots = on;
    this.forgetUnshown();
  }

  @action.bound
  setShowField(on: boolean): void {
    this.store.showField = on;
    this.forgetUnshown();
  }

  @action.bound
  setShowEdge(on: boolean): void {
    this.store.showEdge = on;
  }

  @action.bound
  select(index: number | null): void {
    this.store.selectedIndex = index;
  }

  /** `at` null is a press off the wheel. */
  @action.bound
  press(at: Hued | null): void {
    const letGo = this.store.selectedNode != null;
    this.store.selectedIndex = null;
    if (!letGo && at != null) this.add(at);
  }

  @action.bound
  add(at: Hued): void {
    if (this.store.nodes.length >= COLOUR_NODES_MAX) return;
    const nodes = [...this.store.nodes, nodeAt(at, this.store.channel, this.rim)];
    this.host.settle({ colourNodes: nodes });
    this.store.selectedIndex = nodes.length - 1;
  }

  @action.bound
  remove(index: number): void {
    this.host.settle({ colourNodes: this.store.nodes.filter((_, at) => at !== index) });
    this.store.selectedIndex = null;
  }

  @action.bound
  removeAll(): void {
    this.host.settle({ colourNodes: [] });
    this.store.selectedIndex = null;
  }

  @action.bound
  previewNode(index: number, patch: Partial<ColourNode>): void {
    this.host.preview({ colourNodes: this.patched(index, patch) });
  }

  @action.bound
  settleNode(index: number, patch: Partial<ColourNode>): void {
    this.host.settle({ colourNodes: this.patched(index, patch) });
  }

  @action.bound
  stepReach(index: number, reach: Reach, by: number): void {
    const node = this.store.nodes[index];
    if (node == null) return;
    this.host.settle({
      colourNodes: this.patched(index, steppedReach(node, reach, by, this.rim)),
    });
  }

  @action.bound
  beginDrag(index: number): void {
    this.atDragStart = this.store.nodes;
    this.store.selectedIndex = index;
  }

  @action.bound
  drag(index: number, handle: Handle, at: Hued): void {
    const node = this.store.nodes[index];
    if (node == null || this.atDragStart == null) return;
    const moved: Record<Handle, () => ColourNode> = {
      source: () => movedSource(this.atDragStart?.[index] ?? node, at, this.rim),
      target: () => movedTarget(node, at),
      hueReach: () => ({ ...node, hueReach: hueReachTo(node, at) }),
      chromaReach: () => ({ ...node, chromaReach: chromaReachTo(node, at, this.rim) }),
    };
    this.host.preview({ colourNodes: this.patched(index, moved[handle]()) });
  }

  @action.bound
  endDrag(): void {
    const atDragStart = this.atDragStart;
    this.atDragStart = null;
    if (atDragStart != null && atDragStart !== this.store.nodes) {
      this.host.settle({ colourNodes: [...this.store.nodes] });
    }
  }

  @action.bound
  cancelDrag(): void {
    const atDragStart = this.atDragStart;
    this.atDragStart = null;
    if (atDragStart != null && atDragStart !== this.store.nodes) {
      this.host.preview({ colourNodes: [...atDragStart] });
    }
  }

  close(): void {
    this.closed = true;
    for (const dispose of this.disposers) dispose();
  }

  /** The wheel's rim, which nothing is held inside until the wheel is drawn. */
  private get rim(): number {
    return this.store.drawn?.chroma ?? Number.POSITIVE_INFINITY;
  }

  private patched(index: number, patch: Partial<ColourNode>): ColourNode[] {
    return this.store.nodes.map((node, at) => (at === index ? { ...node, ...patch } : node));
  }

  /** Closing the editor closes the decoder, which rejects whatever it was still asked. */
  private unlessClosed(work: Promise<void>): void {
    work.catch((error: unknown) => {
      if (!this.closed) this.host.fail(describe(error));
    });
  }

  private async handOver(canvas: HTMLCanvasElement): Promise<void> {
    const local = this.host.local();
    if (local == null || this.attached) return;
    canvas.width = WHEEL_SIDE;
    canvas.height = WHEEL_SIDE;
    await local.decoder.attachWheel(canvas.transferControlToOffscreen(), WHEEL_SIDE);
    if (!this.closed) this.setAttached();
  }

  private async draw(channel: Channel): Promise<void> {
    const drawn = await this.host.local()?.decoder.drawWheel({
      lightness: lightnessOf(channel),
      edgeAt: [...CHANNELS],
      displayPeak: this.host.displayPeak(),
      selected: this.store.selectedNode,
    });
    if (this.closed || drawn == null || this.store.channel !== channel) return;
    this.setDrawn(drawn);
  }

  private async shade(): Promise<void> {
    // One present a frame: a drag changes the edit far faster, and presenting the wheel's canvas
    // at that rate wedged Chrome on macOS inside the worker's `queue.submit`.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    if (this.closed) return;
    await this.host
      .local()
      ?.decoder.shadeWheel(lightnessOf(this.store.channel), this.store.selectedNode);
  }

  private async probe(): Promise<void> {
    const edges = this.store.drawn?.edges;
    const local = this.host.local();
    if (edges == null || local == null) return;
    this.probesAsked += 1;
    const asked = this.probesAsked;
    const places = CHANNELS.flatMap((lightness, channel) =>
      Array.from({ length: FIELD_HUES }, (_, step) => (360 * step) / FIELD_HUES).flatMap((hue) => {
        const edge = edges[channel]?.[Math.round(hue) % 360] ?? 0;
        if (edge <= 0) return [];
        const turn = (Math.PI * hue) / 180;
        return FIELD_RINGS.map((ring) => ({
          lightness,
          a: ring * edge * Math.cos(turn),
          b: ring * edge * Math.sin(turn),
        }));
      }),
    );
    const doc = this.edit.doc;
    if (doc == null) return;
    const answers = await local.decoder.probeWheel(
      places.flatMap(({ lightness, a, b }) => [lightness, a, b, 1]),
      adjustOf(doc),
    );
    if (this.closed || asked !== this.probesAsked) return;
    const word = (at: number): number => answers[at] ?? 0;
    const scattered = answers.length / 4 - places.length;
    const dots: Dot[] = [];
    for (let at = 0; at < scattered * 4; at += 4) {
      if (word(at + 3) > 0) dots.push({ lightness: word(at), ...hued(word(at + 1), word(at + 2)) });
    }
    const field: FieldArrow[] = places.map(({ lightness, a, b }, index) => {
      const at = (scattered + index) * 4;
      return { lightness, from: hued(a, b), to: hued(word(at + 1), word(at + 2)) };
    });
    this.setProbed(dots, field);
  }

  @action.bound
  private forgetPhoto(): void {
    this.store.selectedIndex = null;
    this.store.drawn = null;
    this.store.dots = [];
    this.store.field = [];
  }

  private forgetUnshown(): void {
    if (this.store.showDots || this.store.showField) return;
    // Hidden, the probe stops following the edits: what it read would come back stale.
    this.probesAsked += 1;
    this.store.dots = [];
    this.store.field = [];
  }

  @action.bound
  private setAttached(): void {
    this.attached = true;
  }

  @action.bound
  private setDrawn(drawn: WheelDrawn): void {
    this.store.drawn = drawn;
  }

  @action.bound
  private setProbed(dots: Dot[], field: FieldArrow[]): void {
    this.store.dots = dots;
    this.store.field = field;
  }
}
