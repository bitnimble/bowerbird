// Masonry's scroll, driven the way a browser drives it: blocks mount as the
// viewport reaches them, pack their lines from whatever shapes the client holds,
// report the height they settled at a frame later, and lose their rows to the
// cache once the reader is far enough away. What every one of those has to leave
// alone is the photograph under the reader's eye, so that is what is asserted -
// against the layout as it is actually drawn, not against the arithmetic the
// scroll is built from, which is the thing being tested.
import { runInAction } from 'mobx';
import { describe, expect, test } from 'bun:test';
import { MAX_BLOCKS, PhotosPresenter } from '../../photos_presenter';
import { BLOCK, GRID_GAP, TILE_ASPECT, TILE_PAD, masonryBlockEnd } from '../grid_layout';
import { ListingStore } from '../listing_store';
import { MarksStore } from '../marks_store';
import { StacksStore } from '../stacks_store';
import { ViewerStore } from '../../viewer/viewer_store';

const WIDTH = 1000;
const HEIGHT = 800;

const SHAPES = [3 / 2, 2 / 3, 3 / 2, 1, 3 / 2, 16 / 9, 2 / 3, 3 / 2];
function shapeOf(index: number): number {
  return SHAPES[index % SHAPES.length]!;
}

interface Line {
  start: number;
  height: number;
}

// What the masonry grid's flex wrap (`photo_grid.tsx`) does with a run of tiles: lines that take
// tiles until the next no longer fits, each grown to fill the width.
function lay(ratios: readonly number[], tileSize: number): { lines: Line[]; height: number } {
  const lines: Line[] = [];
  let start = 0;
  let members: number[] = [];
  let used = 0;
  const close = (): void => {
    if (members.length === 0) return;
    const pad = 2 * TILE_PAD * members.length + GRID_GAP * (members.length - 1);
    const sum = members.reduce((a, b) => a + b, 0);
    lines.push({ start, height: (WIDTH - pad) / sum + 2 * TILE_PAD + GRID_GAP });
    members = [];
    used = 0;
  };
  for (let i = 0; i < ratios.length; i++) {
    const basis = Math.max(1, ratios[i]! * tileSize) + 2 * TILE_PAD;
    if (used > 0 && used + GRID_GAP + basis > WIDTH) close();
    if (used === 0) start = i;
    used += (used > 0 ? GRID_GAP : 0) + basis;
    members.push(ratios[i]!);
  }
  close();
  return { lines, height: Math.max(0, lines.reduce((a, l) => a + l.height, 0) - GRID_GAP) };
}

class Sim {
  stacks = new StacksStore();
  store = new ListingStore(this.stacks);
  viewer = new ViewerStore(this.store, this.stacks);
  presenter: PhotosPresenter;
  scrollTop = 0;
  loaded = new Set<number>();
  asked = new Map<number, number>();
  recent: number[] = [];
  clock = 0;
  /** Frames between a block being asked for and its rows landing. */
  latency = 0;
  /** What moved the reader this step, for a failure to name. */
  moved: string[] = [];

  constructor(total: number) {
    const absent = new Proxy({}, { get: () => () => undefined }) as never;
    const marks = new MarksStore(this.store, this.stacks);
    this.presenter = new PhotosPresenter(
      this.store,
      marks,
      this.stacks,
      this.viewer,
      absent,
      absent,
      absent,
      absent,
      {} as never,
      absent,
    );
    runInAction(() => {
      this.store.mode = 'masonry';
      this.store.total = total;
    });
    this.presenter.setViewport(WIDTH, HEIGHT);
    for (let frame = 0; frame < 30; frame++) this.frame();
  }

  private ratioAt = (index: number): number =>
    this.loaded.has(Math.floor(index / BLOCK)) ? shapeOf(index) : TILE_ASPECT;

  /** The photos a block draws, exactly as `MasonryBlock` works it out. */
  range(block: number): { from: number; to: number } {
    const from = this.store.startOf(block);
    if (block >= this.store.blockCount - 1) return { from, to: this.store.total };
    const end = masonryBlockEnd(
      (offset) => this.ratioAt(from + offset),
      this.store.total - from,
      WIDTH,
      this.store.tileSize,
      (block + 1) * BLOCK - from,
    );
    return { from, to: Math.min((block + 2) * BLOCK, from + end) };
  }

  layout(block: number): { from: number; lines: Line[]; height: number } {
    const { from, to } = this.range(block);
    const ratios: number[] = [];
    for (let i = from; i < to; i++) ratios.push(this.ratioAt(i));
    return { from, ...lay(ratios, this.store.tileSize) };
  }

  // One commit: the mounted blocks report where they packed to, then - as a
  // ResizeObserver would, after layout - the heights they settled at, and then
  // whatever the fetches begun for them have brought back.
  frame(): void {
    const { from, to } = this.store.mountedBlocks;
    const mounted: number[] = [];
    for (let b = from; b < to; b++) mounted.push(b);
    for (const b of mounted) {
      if (b < this.store.blockCount - 1) this.presenter.packedBlock(b, this.range(b).to);
    }
    for (const b of mounted) {
      const was = this.topPhoto;
      this.presenter.measuredBlock(b, this.layout(b).height, WIDTH);
      if (this.topPhoto !== was) this.moved.push(`block ${b} measured: photo ${was} -> ${this.topPhoto}`);
    }
    this.scrollTop = this.store.rail.top;
    this.deliverRows();
  }

  // The fetch reaction and `evict`, in the terms this needs: what the store asks
  // for arrives `latency` frames later, and what nothing has needed for the last
  // MAX_BLOCKS of asking is dropped.
  private deliverRows(): void {
    this.clock++;
    const needed = this.viewer.neededBlocks;
    for (const b of needed) if (!this.asked.has(b)) this.asked.set(b, this.clock);
    this.recent = [...needed, ...this.recent.filter((b) => !needed.includes(b))];
    const was = this.topPhoto;
    for (const [b, at] of this.asked) if (this.clock - at > this.latency) this.loaded.add(b);
    for (const b of this.recent.slice(MAX_BLOCKS)) {
      if (needed.includes(b)) continue;
      this.loaded.delete(b);
      this.asked.delete(b);
    }
    this.recent = this.recent.slice(0, MAX_BLOCKS);
    if (this.topPhoto !== was) this.moved.push(`rows arrived: photo ${was} -> ${this.topPhoto}`);
  }

  scrollBy(dy: number): void {
    this.scrollTop = Math.max(0, Math.min(this.store.rail.length - HEIGHT, this.scrollTop + dy));
    this.presenter.rail.setTop(this.scrollTop);
    this.scrollTop = this.store.rail.top;
    this.frame();
  }

  /** The photo at the top edge of the viewport, off the blocks as they are drawn. */
  get topPhoto(): number {
    const anchor = this.store.rail.anchor;
    const { from: first, to: last } = this.store.mountedBlocks;
    for (let b = first; b < last; b++) {
      const top = (this.store.blockTops[b] ?? 0) - anchor;
      const { from, lines, height } = this.layout(b);
      if (this.store.rail.top < top || this.store.rail.top >= top + height) continue;
      let y = 0;
      for (const line of lines) {
        if (this.store.rail.top - top < y + line.height) return from + line.start;
        y += line.height;
      }
      return from + (lines[lines.length - 1]?.start ?? 0);
    }
    return -1;
  }
}

interface Run {
  blocks: number;
  latency: number;
  dy: number;
  steps: number;
  /** The step the scroll reverses on; none by default. */
  turn?: number;
}

function run({ blocks, latency, dy, steps, turn = steps }: Run): string[] {
  const sim = new Sim(blocks * BLOCK);
  sim.latency = latency;
  let was = sim.topPhoto;
  const jumps: string[] = [];
  for (let step = 0; step < steps; step++) {
    const heading = step < turn ? dy : -dy;
    sim.moved = [];
    sim.scrollBy(heading);
    const now = sim.topPhoto;
    // Backwards while scrolling down - or forwards while scrolling up - is the
    // failure, and so is a screenful in one step, which is the same slip seen from
    // the other side since no viewport holds forty. A tile or two of wobble is
    // neither: a block re-packs when its rows land, so turning back into one that
    // is still waiting for them moves the line the viewport starts on by that
    // much, which is the shapes arriving rather than the scroll slipping.
    const moved = heading > 0 ? now - was : was - now;
    if (step !== turn && was >= 0 && now >= 0 && (moved < -4 || moved > 40)) {
      jumps.push(...sim.moved, `step ${step}: photo ${was} -> ${now}; rail ${sim.store.rail.top.toFixed(0)}`);
    }
    if (now < 0) jumps.push(`step ${step}: nothing is drawn at the top edge; rail ${sim.store.rail.top.toFixed(0)}`);
    was = now;
  }
  return jumps;
}

describe('scrolling masonry', () => {
  test('the photo at the top edge follows the scroll, whatever a block measures at', () => {
    const found: Record<string, string[]> = {};
    for (const blocks of [20, 60]) {
      for (const latency of [0, 2, 6]) {
        // Up to 900px a frame, which is a hard fling at 54,000px a second.
        for (const dy of [120, 400, 900]) {
          const cases: Record<string, Run> = {
            down: { blocks, latency, dy, steps: 400 },
            'down and back': { blocks, latency, dy, steps: 400, turn: 200 },
          };
          for (const [name, spec] of Object.entries(cases)) {
            const jumps = run(spec);
            if (jumps.length > 0) found[`${name}, blocks ${blocks} latency ${latency} dy ${dy}`] = jumps.slice(0, 4);
          }
        }
      }
    }
    expect(found).toEqual({});
  });

  test('the block above is mounted a viewport before the reader walks back into it', () => {
    const sim = new Sim(20 * BLOCK);
    for (let step = 0; step < 40; step++) sim.scrollBy(900);
    const first = sim.store.visibleBlocks.from;
    expect(first).toBeGreaterThan(0);
    const top = sim.store.blockTops[first]!;

    sim.presenter.rail.scrollTo(top + HEIGHT / 2);
    expect(sim.store.mountedBlocks.from).toBe(first - 1);

    sim.presenter.rail.scrollTo(top + HEIGHT * 2);
    expect(sim.store.mountedBlocks.from).toBe(first);
  });
});
