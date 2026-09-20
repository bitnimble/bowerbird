import { expect, test } from 'bun:test';
import { gateOf, rerecorded } from './bench';

const ADAPTER = 'RADV RAPHAEL_MENDOCINO';
const budget = {
  tolerance: 0.15,
  adapters: { [ADAPTER]: { 'DSC00853.ARW': { condition: 14.2, denoise: 1526.7 } } },
  widened: { [ADAPTER]: { 'DSC00853.ARW': { condition: 18, denoise: 900 } } },
};

test('a stage is held to its measurement unless it is widened past it', () => {
  expect(gateOf(budget, ADAPTER, 'DSC00853.ARW', 'condition')).toBe(18);
  // A widening the stage has already grown past is inert rather than a gate that fell.
  expect(gateOf(budget, ADAPTER, 'DSC00853.ARW', 'denoise')).toBe(1526.7);
  expect(gateOf(budget, ADAPTER, 'DSC00853.ARW', 'resize')).toBeUndefined();
  expect(gateOf(budget, 'NVIDIA', 'DSC00853.ARW', 'condition')).toBeUndefined();
});

test('a re-record writes what it measured and keeps every widening', () => {
  const written = rerecorded(budget, [
    { adapter: ADAPTER, taken: { 'DSC00853.ARW': { condition: 13.9, denoise: 1502.0 } } },
  ]);
  expect(written.adapters[ADAPTER]?.['DSC00853.ARW']?.condition).toBe(13.9);
  expect(written.widened).toEqual(budget.widened);
  expect(gateOf(written, ADAPTER, 'DSC00853.ARW', 'condition')).toBe(18);
});
