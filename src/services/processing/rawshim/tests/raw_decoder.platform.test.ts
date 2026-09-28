import { describe, expect, test } from 'bun:test';
import { wallClockIso } from '../raw_decoder';

describe('wallClockIso', () => {
  // `header.rs` reads EXIF's `YYYY:MM:DD HH:MM:SS` as UTC and pins that in
  // `a_timestamp_is_read_from_the_exif_spelling`. These are the same instants seen from the
  // other side of the boundary, so the pair cannot drift without one of them going red.
  test('gives back the wall clock the camera wrote', () => {
    expect(wallClockIso(1_717_772_305)).toBe('2024-06-07T14:58:25.000Z');
    expect(wallClockIso(0)).toBe('1970-01-01T00:00:00.000Z');
  });

  // The failure this exists for: the seconds went through the server's own zone and came back
  // re-encoded, which was right while LibRaw's `mktime` put them there and became a shift of
  // the server's offset once the header stopped calling it. At +10 an evening shot moved to
  // the next day.
  test('does not move with the machine it runs on', () => {
    const zone = process.env.TZ;
    try {
      process.env.TZ = 'Australia/Sydney';
      const east = wallClockIso(1_717_772_305);
      process.env.TZ = 'America/Los_Angeles';
      expect(wallClockIso(1_717_772_305)).toBe(east);
    } finally {
      process.env.TZ = zone;
    }
  });
});
