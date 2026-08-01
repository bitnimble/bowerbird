import { describe, it, expect } from 'bun:test';
import { DEFAULT_SETTINGS, SettingsSchema } from '../settings';

describe('DEFAULT_SETTINGS', () => {
  // TypeScript only checks that every field has the right *type*. Every bound the schema
  // carries - `min(0).max(1)` on `raw_defringe`, the quantizer ranges, the enums - is
  // invisible to it, so a default outside one compiles and then fails at the first write
  // through the settings API rather than here.
  it('satisfies the schema it is typed against', () => {
    expect(SettingsSchema.safeParse(DEFAULT_SETTINGS)).toMatchObject({ success: true });
  });

  // The repository seeds a missing row from these keys, so one the schema does not know
  // about is a column nothing ever reads back.
  it('names exactly the fields the schema declares', () => {
    expect(Object.keys(DEFAULT_SETTINGS).sort()).toEqual(Object.keys(SettingsSchema.shape).sort());
  });
});
