import type { CaptureSequence, CaptureSequenceKind } from '../../schemas/capture_sequence';

/** A photograph whose body says it is one frame of a multi-shot capture. */
export interface SequencedFrame {
  id: string;
  shootId: string | null;
  /** Seconds since the epoch, from the capture time. */
  timestamp: number;
  sequence: CaptureSequence;
}

/** One capture's frames, in index order. */
export interface Bracket {
  kind: CaptureSequenceKind;
  photoIds: string[];
}

/**
 * The longest a capture's frames sit apart. A pixel shift at its longest interval and exposure is
 * well under a minute a frame, so this only ever separates two captures, never one.
 */
export const BRACKET_GAP_SECONDS = 600;

/**
 * The captures among these frames: runs whose index climbs from 1, one step at a time.
 *
 * **The index restarting is what ends a capture**, since only pixel shift carries a key and Canon
 * carries no count - so a run that does not start at 1 (its first frame deleted or never
 * imported) is no capture, and neither is one short of the count its body stated. A group key,
 * where there is one, has to match as well, which is what keeps two bursts fired in the same
 * second apart.
 *
 * A frame with no index - Canon's focus bracketing - is placed by when it was taken, and its run
 * ends at the count its body stated.
 */
export function bracketsOf(frames: readonly SequencedFrame[]): Bracket[] {
  const lanes = new Map<string, SequencedFrame[]>();
  for (const frame of frames) {
    const lane = `${frame.shootId ?? ''}\0${frame.sequence.kind}`;
    const held = lanes.get(lane);
    if (held == null) lanes.set(lane, [frame]);
    else held.push(frame);
  }
  const found: Bracket[] = [];
  for (const lane of lanes.values()) {
    lane.sort(
      (a, b) => a.timestamp - b.timestamp || (a.sequence.index ?? 0) - (b.sequence.index ?? 0) || a.id.localeCompare(b.id),
    );
    let run: SequencedFrame[] = [];
    for (const frame of lane) {
      const previous = run.at(-1);
      if (previous != null && continues(previous, frame, run.length)) {
        run.push(frame);
        continue;
      }
      if (isWhole(run)) found.push(bracketOf(run));
      run = [frame];
    }
    if (isWhole(run)) found.push(bracketOf(run));
  }
  return found;
}

function continues(previous: SequencedFrame, next: SequencedFrame, length: number): boolean {
  const [was, is] = [previous.sequence, next.sequence];
  const follows = was.index == null || is.index == null ? was.index == is.index : is.index === was.index + 1;
  return (
    follows &&
    is.group === was.group &&
    is.count === was.count &&
    (was.count == null || length < was.count) &&
    next.timestamp - previous.timestamp <= BRACKET_GAP_SECONDS
  );
}

function isWhole(run: readonly SequencedFrame[]): boolean {
  const first = run[0];
  if (first == null || run.length < 2 || (first.sequence.index != null && first.sequence.index !== 1)) return false;
  return first.sequence.count == null || run.length === first.sequence.count;
}

function bracketOf(run: readonly SequencedFrame[]): Bracket {
  return { kind: run[0]!.sequence.kind, photoIds: run.map((frame) => frame.id) };
}
