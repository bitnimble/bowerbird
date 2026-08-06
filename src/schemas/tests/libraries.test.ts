import { describe, it, expect } from 'bun:test';
import { inferredLibraryName } from '../../utils/library_name';
import { CreateLibraryRequestSchema, LibrarySchema, UpdateLibraryRequestSchema } from '../libraries';

const base = { root_path: '/photos' };

describe('inferredLibraryName', () => {
  it('uses the last path segment', () => {
    expect(inferredLibraryName('/photos/Trip')).toBe('Trip');
    expect(inferredLibraryName('/photos/Trip/')).toBe('Trip');
  });

  // Date-sorted trees otherwise all show as "2025".
  it('prefixes a year leaf with its parent folder', () => {
    expect(inferredLibraryName('/photos/Trip/2025')).toBe('Trip 2025');
    expect(inferredLibraryName('C:\\photos\\Trip\\2025')).toBe('Trip 2025');
  });

  it('leaves a year alone when there is no parent', () => {
    expect(inferredLibraryName('/2025')).toBe('2025');
  });
});

describe('LibrarySchema.name', () => {
  it('requires a non-empty name', () => {
    const library = {
      id: '00000000-0000-4000-8000-000000000001',
      root_path: '/photos',
      bin_name: 'Bin',
      name: 'Trip',
      ordering: 'taken_asc' as const,
      rendition_source: 'embedded' as const,
      rendition_hdr: false,
      rendition_hdr_video: false,
      include_subfolders: true,
      mirror_shoots: true,
      auto_stack: true,
      auto_stack_similarity: 0.78,
      auto_stack_window_seconds: 60,
      last_synced_at: null,
      photo_count: 0,
    };
    expect(LibrarySchema.parse(library).name).toBe('Trip');
    expect(() => LibrarySchema.parse({ ...library, name: null })).toThrow();
    expect(() => LibrarySchema.parse({ ...library, name: '' })).toThrow();
  });
});

describe('UpdateLibraryRequestSchema.name', () => {
  it('refuses a blank name', () => {
    expect(() => UpdateLibraryRequestSchema.parse({ name: '' })).toThrow();
    expect(() => UpdateLibraryRequestSchema.parse({ name: '   ' })).toThrow();
    expect(UpdateLibraryRequestSchema.parse({ name: ' Trip ' }).name).toBe('Trip');
  });
});

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
