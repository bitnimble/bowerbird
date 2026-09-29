import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Library } from '../../../schemas/libraries';

export function withRoot(run: (root: string) => Promise<void> | void) {
  return async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-blobstore-'));
    try {
      await run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

export function library(root: string): Library {
  return {
    id: 'library1',
    root_path: root,
    bin_name: 'Bin',
    read_only: false,
    name: 'Trip',
    ordering: 'taken_asc',
    rendition_source: 'render',
    rendition_hdr: true,
    render_skip_full: [],
    render_skip_max: [],
    denoiser: 'galosh',
    include_subfolders: true,
    include_non_raw: false,
    auto_stack: true,
    auto_stack_similarity: 0.78,
    auto_stack_window_seconds: 60,
    last_synced_at: null,
    photo_count: 0,
    missing_photo_count: 0,
    unavailable_photo_count: 0,
    rendered_photo_count: 0,
  };
}

export function stream(text: string): ReadableStream<Uint8Array> {
  return new Response(text).body!;
}
