import { computed, observable } from 'mobx';
import type { ColourNode } from '../../../../../src/schemas/photo_edits';
import type { EditStore } from '../edit/edit_store';
import type { WheelDrawn } from '../local_decode/local_open';
import {
  type Channel,
  type Hued,
  channelOf,
  inChannel,
  lightnessOf,
  nearestChannel,
  opponent,
} from './colour_wheel';

const FIELD_SECTORS = 12;
const FIELD_LEAST_SHARE = 0.2;

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

  @observable accessor channel: Channel = null;

  @observable accessor selectedIndex: number | null = null;

  @observable.ref accessor drawn: WheelDrawn | null = null;

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
    return new Set(this.nodes.map(channelOf));
  }

  @computed get channelDots(): readonly Dot[] {
    if (this.channel == null) return this.dots;
    const channel = this.channel;
    return this.dots.filter((dot) => nearestChannel(dot.lightness) === channel);
  }

  @computed get channelField(): readonly FieldArrow[] {
    const lightness = lightnessOf(this.channel);
    const strongest = new Map<number, { arrow: FieldArrow; push: number }>();
    for (const arrow of this.field) {
      if (arrow.lightness !== lightness) continue;
      const sector = Math.floor(arrow.from.hue / (360 / FIELD_SECTORS)) % FIELD_SECTORS;
      const push = pushOf(arrow);
      if (push > (strongest.get(sector)?.push ?? 0)) strongest.set(sector, { arrow, push });
    }
    const most = Math.max(0, ...[...strongest.values()].map(({ push }) => push));
    return [...strongest.values()]
      .filter(({ push }) => push >= most * FIELD_LEAST_SHARE)
      .map(({ arrow }) => arrow);
  }
}

function pushOf({ from, to }: FieldArrow): number {
  const [a, b] = opponent(from);
  const [toA, toB] = opponent(to);
  return Math.hypot(toA - a, toB - b);
}
