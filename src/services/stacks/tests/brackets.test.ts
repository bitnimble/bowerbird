import { describe, expect, it } from 'bun:test';
import type { CaptureSequence } from '../../../schemas/capture_sequence';
import { BRACKET_GAP_SECONDS, bracketsOf, type SequencedFrame } from '../brackets';

function frame(id: string, timestamp: number, sequence: Partial<CaptureSequence> & { index: number }): SequencedFrame {
  return {
    id,
    shootId: null,
    timestamp,
    sequence: { kind: 'exposureBracket', group: null, count: null, ...sequence },
  };
}

function pixelShift(id: string, timestamp: number, index: number, group = 77): SequencedFrame {
  return frame(id, timestamp, { kind: 'pixelShift', group, index, count: 4 });
}

describe('bracketsOf', () => {
  it('finds a 4-shot pixel shift as exactly its four frames', () => {
    const found = bracketsOf([1, 2, 3, 4].map((index) => pixelShift(`p${index}`, 100 + index, index)));

    expect(found).toEqual([{ kind: 'pixelShift', photoIds: ['p1', 'p2', 'p3', 'p4'] }]);
  });

  it('splits two bursts fired back to back where the index restarts', () => {
    const frames = [
      ...[1, 2, 3, 4].map((index) => pixelShift(`a${index}`, 100, index, 1)),
      ...[1, 2, 3, 4].map((index) => pixelShift(`b${index}`, 101, index, 2)),
    ];

    expect(bracketsOf(frames).map((bracket) => bracket.photoIds)).toEqual([
      ['a1', 'a2', 'a3', 'a4'],
      ['b1', 'b2', 'b3', 'b4'],
    ]);
  });

  it('keeps two bursts apart that share a second but not a key', () => {
    const frames = [1, 2, 3, 4].flatMap((index) => [pixelShift(`a${index}`, 100, index, 1), pixelShift(`b${index}`, 100, index, 2)]);

    expect(bracketsOf(frames)).toHaveLength(0);
  });

  it('refuses a burst missing a frame', () => {
    expect(bracketsOf([1, 2, 4].map((index) => pixelShift(`p${index}`, 100 + index, index)))).toEqual([]);
  });

  it('refuses a bracket whose first frame is gone', () => {
    const frames = [2, 3].map((index) => frame(`e${index}`, 100 + index, { index, count: 3 }));

    expect(bracketsOf(frames)).toEqual([]);
  });

  it('ends a bracket with no stated count where the index restarts', () => {
    const frames = [1, 2, 3, 1, 2, 3].map((index, at) => frame(`e${at}`, 100 + at, { index }));

    expect(bracketsOf(frames).map((bracket) => bracket.photoIds)).toEqual([
      ['e0', 'e1', 'e2'],
      ['e3', 'e4', 'e5'],
    ]);
  });

  it('ends a bracket at its stated count even when the next frame climbs on', () => {
    const frames = [1, 2, 3, 4].map((index) => frame(`e${index}`, 100 + index, { index, count: 3 }));

    expect(bracketsOf(frames).map((bracket) => bracket.photoIds)).toEqual([['e1', 'e2', 'e3']]);
  });

  it('does not join frames further apart than a capture ever is', () => {
    const frames = [frame('e1', 0, { index: 1 }), frame('e2', BRACKET_GAP_SECONDS + 1, { index: 2 })];

    expect(bracketsOf(frames)).toEqual([]);
  });

  it('never mixes a pixel shift and a bracket', () => {
    const frames = [pixelShift('p1', 100, 1), frame('e2', 101, { index: 2 }), frame('e1', 99, { index: 1 })];

    expect(bracketsOf(frames)).toEqual([{ kind: 'exposureBracket', photoIds: ['e1', 'e2'] }]);
  });

  it('never joins frames from two shoots', () => {
    const frames = [frame('e1', 100, { index: 1 }), { ...frame('e2', 101, { index: 2 }), shootId: 'elsewhere' }];

    expect(bracketsOf(frames)).toEqual([]);
  });
});
