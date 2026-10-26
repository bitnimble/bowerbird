import { action, reaction, type IReactionDisposer } from 'mobx';
import type { EditDoc } from '../../../../../src/schemas/photo_edits';
import {
  MOST_REFLECTION_STROKES,
  STORED_LONG,
  storedPolyline,
  storedSize,
  type ReflectionStroke,
} from '../../../../../src/schemas/stored_grid';
import { describe } from '../../../errors';
import type { EditStore } from '../edit/edit_store';
import type { KeystoneStore } from '../keystone/keystone_store';
import type { LocalDecoder } from '../local_decode/local_decoder';
import type { StageStore } from '../stage/stage_store';
import {
  LEAST_BRUSH_SIZE,
  MOST_BRUSH_SIZE,
  type BrushMode,
  type ReflectionStore,
  type StrokeOutline,
} from './reflection_store';

/** How far a stroke may be simplified off the line drawn, as a share of its radius. */
const SIMPLIFY_SHARE_OF_RADIUS = 0.25;

type Point = { x: number; y: number };

/** What the reflection brush needs of the editor it works in. */
export interface ReflectionHost {
  local(): { decoder: LocalDecoder } | null;
  closed(): boolean;
  /** The document patched, drawn and saved as one step of the history. */
  settle(patch: Partial<EditDoc>): void;
  /**
   * Every tool closed, the loupe too, which would otherwise take the brush's drag, and a sheet
   * turned in a room laid flat, which the brush could not draw on.
   */
  putToolsAway(): void;
  fail(why: string): void;
}

/** The reflection removal's switch, and the brush that marks what it takes out and keeps. */
export class ReflectionPresenter {
  private readonly following: IReactionDisposer;

  constructor(
    private readonly stage: StageStore,
    private readonly edit: EditStore,
    private readonly keystone: KeystoneStore,
    private readonly store: ReflectionStore,
    private readonly host: ReflectionHost,
  ) {
    this.following = reaction(
      () => (this.store.painting ? this.outlinesKey() : null),
      (asked) => {
        if (asked != null) this.follow(asked);
      },
    );
  }

  @action.bound
  begin = (): void => {
    this.store.brushing = false;
    this.store.outlines = [];
    this.outlinesOf = null;
  };

  @action.bound
  setEnabled = (on: boolean): void => {
    if (!on) this.store.brushing = false;
    this.host.settle({ reflectionRemoval: on });
  };

  @action.bound
  setBrushing = (on: boolean): void => {
    if (on) this.host.putToolsAway();
    this.store.brushing = on;
  };

  @action.bound
  setMode = (mode: BrushMode): void => {
    this.store.mode = mode;
  };

  @action.bound
  setSize = (size: number): void => {
    this.store.size = Math.min(Math.max(size, LEAST_BRUSH_SIZE), MOST_BRUSH_SIZE);
  };

  @action.bound
  clear = (): void => {
    this.host.settle({ reflectionStrokes: [] });
  };

  /**
   * A stroke the reader drew, as fractions of the output on the stage, taken onto the photo through
   * the geometry the stage is drawn with and kept in the document.
   */
  paint = async (shown: readonly Point[]): Promise<void> => {
    const local = this.host.local();
    if (local == null || !this.store.painting || shown.length === 0) return;
    const kind = this.store.mode;
    const radius = Math.max(1, Math.round(this.store.size * STORED_LONG));
    this.showDrawn({ kind, radius: this.store.brushRadius, points: [...shown] });
    let onPicture: [number, number][];
    try {
      onPicture = await local.decoder.pictureOfOutput(
        this.keystone.geometry,
        shown.map(({ x, y }) => [x, y]),
      );
    } catch (error) {
      if (this.host.closed()) return;
      this.host.fail(describe(error));
      this.refollow();
      return;
    }
    if (this.host.closed()) return;
    const strokes = this.edit.doc?.reflectionStrokes;
    const points = storedPolyline(
      onPicture.map(([x, y]) => ({ x, y })),
      { width: this.stage.width, height: this.stage.height },
      radius * SIMPLIFY_SHARE_OF_RADIUS,
    );
    if (strokes == null || points == null || strokes.length >= MOST_REFLECTION_STROKES) {
      this.refollow();
      return;
    }
    const stroke: ReflectionStroke = { kind, radius, points };
    this.host.settle({ reflectionStrokes: [...strokes, stroke] });
  };

  close(): void {
    this.following();
  }

  /** What `follow` last asked the module about, so an older answer landing late is dropped. */
  private outlinesOf: string | null = null;

  /** The strokes the overlay draws, onto the output the stage shows. */
  private follow(asked: string): void {
    const strokes = this.edit.doc?.reflectionStrokes ?? [];
    const local = this.host.local();
    if (asked === this.outlinesOf || local == null || this.stage.width === 0) return;
    this.outlinesOf = asked;
    if (strokes.length === 0) {
      this.setOutlines([]);
      return;
    }
    const grid = storedSize(this.stage.width, this.stage.height);
    const long = Math.max(this.stage.width, this.stage.height);
    const points = strokes.flatMap((stroke) =>
      stroke.points.map(([x, y]): [number, number] => [x / grid.width, y / grid.height]),
    );
    local.decoder.outputOfPicture(this.keystone.geometry, points).then(
      (mapped) => {
        if (this.host.closed() || this.outlinesOf !== asked) return;
        let at = 0;
        this.setOutlines(
          strokes.map((stroke) => ({
            kind: stroke.kind,
            radius: (stroke.radius / STORED_LONG) * long,
            points: stroke.points.map(() => {
              const [x = 0, y = 0] = mapped[at++] ?? [];
              return { x, y };
            }),
          })),
        );
      },
      (error: unknown) => {
        if (!this.host.closed()) this.host.fail(describe(error));
      },
    );
  }

  /** The strokes drawn again from the document, over a stroke shown that it never took. */
  private refollow(): void {
    this.outlinesOf = null;
    this.follow(this.outlinesKey());
  }

  private outlinesKey(): string {
    return JSON.stringify([this.keystone.geometry, this.edit.doc?.reflectionStrokes]);
  }

  /** A stroke just drawn, shown while the module maps it, so it does not blink out on release. */
  @action.bound
  private showDrawn = (outline: StrokeOutline): void => {
    this.store.outlines = [...this.store.outlines, outline];
  };

  @action.bound
  private setOutlines = (outlines: StrokeOutline[]): void => {
    this.store.outlines = outlines;
  };
}
