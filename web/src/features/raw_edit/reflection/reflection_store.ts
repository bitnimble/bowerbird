import { computed, observable } from 'mobx';
import {
  MOST_REFLECTION_STROKES,
  type ReflectionStroke,
} from '../../../../../src/schemas/stored_grid';
import type { EditStore } from '../edit/edit_store';
import type { StageStore } from '../stage/stage_store';

export type BrushMode = ReflectionStroke['kind'];

/** A stroke as the stage draws it: points in fractions of the output, the radius in its pixels. */
export type StrokeOutline = {
  kind: BrushMode;
  radius: number;
  points: { x: number; y: number }[];
};

export const DEFAULT_BRUSH_SIZE = 0.05;
export const LEAST_BRUSH_SIZE = 0.01;
export const MOST_BRUSH_SIZE = 0.2;

// Observables and computeds only. Every mutation is on ReflectionPresenter.
export class ReflectionStore {
  constructor(
    private readonly edit: EditStore,
    private readonly stage: StageStore,
  ) {}

  @observable accessor brushing = false;
  @observable accessor mode: BrushMode = 'remove';
  /** A share of the photo's long edge. */
  @observable accessor size = DEFAULT_BRUSH_SIZE;
  @observable.ref accessor outlines: StrokeOutline[] = [];

  @computed get enabled(): boolean {
    return this.edit.doc?.reflectionRemoval ?? false;
  }

  @computed get strokeCount(): number {
    return this.edit.doc?.reflectionStrokes.length ?? 0;
  }

  @computed get full(): boolean {
    return this.strokeCount >= MOST_REFLECTION_STROKES;
  }

  @computed get painting(): boolean {
    const flat = this.stage.softProof !== 'print3d';
    return this.brushing && this.enabled && !this.full && this.stage.editable && flat;
  }

  /** In the photo's pixels. */
  @computed get brushRadius(): number {
    return this.size * Math.max(this.stage.width, this.stage.height);
  }
}
