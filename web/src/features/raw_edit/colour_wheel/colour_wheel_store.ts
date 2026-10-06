import { computed, observable } from 'mobx';
import type { ColourNode } from '../../../../../src/schemas/photo_edits';
import type { EditStore } from '../edit/edit_store';
import { type Channel, type Hued, inChannel, lightnessOf, nearestChannel } from './colour_wheel';

/** Where the profile takes one place on the wheel, at a channel's lightness. */
export interface FieldArrow {
  lightness: number;
  from: Hued;
  to: Hued;
}

/** A photograph's colour where colour edits read it: ZCAM lightness, then its place on the wheel. */
export interface Dot extends Hued {
  lightness: number;
}

export class ColourWheelStore {
  constructor(private readonly edit: EditStore) {}

  @observable accessor channel: Channel = 55;

  @observable accessor selectedIndex: number | null = null;

  /** The chroma at the wheel's rim, and the displayable chroma at each degree, at the channel. */
  @observable.ref accessor drawn: { chroma: number; edge: readonly number[] } | null = null;

  @observable.ref accessor dots: readonly Dot[] = [];

  @observable.ref accessor field: readonly FieldArrow[] = [];

  @computed get nodes(): readonly ColourNode[] {
    return this.edit.doc?.colourNodes ?? [];
  }

  @computed get shown(): { node: ColourNode; index: number }[] {
    return this.nodes
      .map((node, index) => ({ node, index }))
      .filter(({ node }) => inChannel(node, this.channel));
  }

  @computed get selectedNode(): ColourNode | null {
    return this.selectedIndex == null ? null : (this.nodes[this.selectedIndex] ?? null);
  }

  @computed get edited(): ReadonlySet<Channel> {
    return new Set(this.nodes.map((node) => node.lightness));
  }

  @computed get channelDots(): readonly Dot[] {
    if (this.channel == null) return this.dots;
    const channel = this.channel;
    return this.dots.filter((dot) => nearestChannel(dot.lightness) === channel);
  }

  @computed get channelField(): readonly FieldArrow[] {
    const lightness = lightnessOf(this.channel);
    return this.field.filter((arrow) => arrow.lightness === lightness);
  }
}
