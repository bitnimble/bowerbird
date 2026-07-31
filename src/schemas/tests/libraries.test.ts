import { describe, it, expect } from 'bun:test';
import { CreateLibraryRequestSchema } from '../libraries';

const base = { root_path: '/photos' };

describe('CreateLibraryRequestSchema.bin_name', () => {
  it('defaults to Bin and trims what was typed', () => {
    expect(CreateLibraryRequestSchema.parse(base).bin_name).toBe('Bin');
    expect(CreateLibraryRequestSchema.parse({ ...base, bin_name: '  Deleted  ' }).bin_name).toBe('Deleted');
  });

  // It is joined onto the root and onto each shoot folder, so anything that is
  // not one folder name would put the bin somewhere the scan does not skip.
  it('refuses anything that is not a single folder name', () => {
    for (const bin_name of ['', '   ', '.', '..', 'a/b', 'a\\b', '../escape']) {
      expect(() => CreateLibraryRequestSchema.parse({ ...base, bin_name })).toThrow();
    }
  });
});
