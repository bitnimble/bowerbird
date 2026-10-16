import { expect, test } from 'bun:test';
import { RemainingRates } from '../remaining_rates';

const at = (counts: Record<string, number>): Map<string, number> => new Map(Object.entries(counts));

test('measures how fast a count falls over the last ten seconds', () => {
  const rates = new RemainingRates();
  expect(rates.observe(at({ reading: 100 }), 0).get('reading')).toBeUndefined();
  rates.observe(at({ reading: 90 }), 5_000);
  expect(rates.observe(at({ reading: 80 }), 10_000).get('reading')).toBe(2);
  expect(rates.observe(at({ reading: 76 }), 12_000).get('reading')).toBeCloseTo(14 / 7);
});

test('starts over when more work arrives, and forgets a key that finished', () => {
  const rates = new RemainingRates();
  rates.observe(at({ sending: 10 }), 0);
  rates.observe(at({ sending: 5 }), 1_000);
  expect(rates.observe(at({ sending: 40 }), 2_000).get('sending')).toBeUndefined();
  expect(rates.observe(at({ sending: 38 }), 3_000).get('sending')).toBe(2);

  rates.observe(at({}), 4_000);
  expect(rates.observe(at({ sending: 30 }), 5_000).get('sending')).toBeUndefined();
});

test('gives no rate to a count that holds steady', () => {
  const rates = new RemainingRates();
  rates.observe(at({ rendering: 4 }), 0);
  expect(rates.observe(at({ rendering: 4 }), 3_000).get('rendering')).toBeUndefined();
});
