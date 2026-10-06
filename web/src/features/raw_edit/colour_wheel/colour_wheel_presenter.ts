import { action, observable, reaction, type IReactionDisposer } from 'mobx';
import { newId } from '../../../../../src/schemas/id';
import {
  COLOUR_NODES_MAX,
  type ColourNode,
  type EditDoc,
} from '../../../../../src/schemas/photo_edits';
import type { EditStore } from '../edit/edit_store';
import type { LocalSource } from '../local_decode/open_photo';
import type { StageStore } from '../stage/stage_store';
import {
  CHANNELS,
  type Channel,
  type Hued,
  chromaReachTo,
  hueReachTo,
  hued,
  lightnessOf,
  movedSource,
  movedTarget,
  nodeAt,
} from './colour_wheel';
import type { ColourWheelStore, Dot, FieldArrow } from './colour_wheel_store';

export interface ColourWheelHost {
  local: () => LocalSource | null;
  preview: (patch: Partial<EditDoc>) => void;
  settle: (patch: Partial<EditDoc>) => void;
}

export type Handle = 'source' | 'target' | 'hueReach' | 'chromaReach';

export const WHEEL_SIDE = 512;
const FIELD_HUES = 18;
const FIELD_RINGS = [0.3, 0.6, 0.9];

export class ColourWheelPresenter {
  /** Keys the backdrop's canvas to this photo's open: a transferred canvas cannot be transferred again. */
  readonly key = newId();
  @observable.ref private accessor canvas: HTMLCanvasElement | null = null;
  @observable private accessor attached = false;
  private atDragStart: readonly ColourNode[] | null = null;
  private closed = false;
  private probesAsked = 0;
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
        () => (this.attached ? lightnessOf(this.store.channel) : null),
        (lightness) => {
          if (lightness != null) this.unlessClosed(this.draw(lightness));
        },
      ),
      reaction(
        () => {
          const doc = this.edit.doc;
          return this.attached && this.store.drawn != null && !this.stage.repreparing
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
          if (key != null) this.unlessClosed(this.probe());
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
    if (this.store.selectedNode?.lightness !== channel) this.store.selectedIndex = null;
  }

  @action.bound
  select(index: number | null): void {
    this.store.selectedIndex = index;
  }

  @action.bound
  add(at: Hued): void {
    if (this.store.nodes.length >= COLOUR_NODES_MAX) return;
    const nodes = [...this.store.nodes, nodeAt(at, this.store.channel)];
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
  beginDrag(index: number): void {
    this.atDragStart = this.store.nodes;
    this.store.selectedIndex = index;
  }

  @action.bound
  drag(index: number, handle: Handle, at: Hued): void {
    const node = this.store.nodes[index];
    if (node == null || this.atDragStart == null) return;
    const moved: Record<Handle, () => ColourNode> = {
      source: () => movedSource(node, at),
      target: () => movedTarget(node, at),
      hueReach: () => ({ ...node, hueReach: hueReachTo(node, at) }),
      chromaReach: () => ({ ...node, chromaReach: chromaReachTo(node, at) }),
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

  private patched(index: number, patch: Partial<ColourNode>): ColourNode[] {
    return this.store.nodes.map((node, at) => (at === index ? { ...node, ...patch } : node));
  }

  /** Closing the editor closes the decoder, which rejects whatever it was still asked. */
  private unlessClosed(work: Promise<void>): void {
    work.catch((error: unknown) => {
      if (!this.closed) throw error;
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

  private async draw(lightness: number): Promise<void> {
    const drawn = await this.host.local()?.decoder.drawWheel(lightness);
    if (this.closed || drawn == null || lightnessOf(this.store.channel) !== lightness) return;
    this.setDrawn(drawn);
  }

  private async probe(): Promise<void> {
    const rim = this.store.drawn?.chroma;
    const local = this.host.local();
    if (rim == null || local == null) return;
    this.probesAsked += 1;
    const asked = this.probesAsked;
    const places = CHANNELS.flatMap((lightness) =>
      FIELD_RINGS.flatMap((ring) =>
        Array.from({ length: FIELD_HUES }, (_, step) => {
          const turn = (2 * Math.PI * step) / FIELD_HUES;
          return { lightness, a: ring * rim * Math.cos(turn), b: ring * rim * Math.sin(turn) };
        }),
      ),
    );
    const answers = await local.decoder.probeWheel(
      places.flatMap(({ lightness, a, b }) => [lightness, a, b, 1]),
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

  @action.bound
  private setAttached(): void {
    this.attached = true;
  }

  @action.bound
  private setDrawn(drawn: { chroma: number; edge: readonly number[] }): void {
    this.store.drawn = drawn;
  }

  @action.bound
  private setProbed(dots: Dot[], field: FieldArrow[]): void {
    this.store.dots = dots;
    this.store.field = field;
  }
}
