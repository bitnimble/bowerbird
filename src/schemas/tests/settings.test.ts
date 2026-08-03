import { describe, it, expect } from 'bun:test';
import { DEFAULT_SETTINGS, SettingsSchema, UpdateSettingsRequestSchema } from '../settings';

describe('SettingsSchema defaults', () => {
  // An empty object must fill every field: the repository seeds missing rows from
  // these, and the settings page compares live values against them for reset.
  it('fills every field from an empty object', () => {
    expect(Object.keys(DEFAULT_SETTINGS).sort()).toEqual(Object.keys(SettingsSchema.shape).sort());
  });

  // Zod's `.partial()` still applies defaults for omitted keys, which would turn a
  // one-field PATCH into a reset of everything else - so the update schema strips
  // them first.
  it('accepts a one-field patch without filling the rest', () => {
    expect(UpdateSettingsRequestSchema.parse({ log_level: 'debug' })).toEqual({ log_level: 'debug' });
  });
});
