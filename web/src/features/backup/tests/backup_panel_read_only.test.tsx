import { afterEach, expect, test } from 'bun:test';
import { runInAction } from 'mobx';
import { useEffect } from 'react';
import { type BackupStatus } from '../../../../../src/schemas/backup';
import { type Library } from '../../../../../src/schemas/libraries';
import { registerDom } from '../../../test_dom';

registerDom();
const { act, cleanup, render, screen } = await import('@testing-library/react');
const { StoresProvider, useBackupStore } = await import('../../../app/stores_context');
const { BackupPanel } = await import('../backup_panel');

afterEach(cleanup);

const status: BackupStatus = {
  library_id: 'lib',
  peer_id: 'backup',
  name: 'Backup',
  path: '/backup',
  available: true,
  owed: 0,
  backed_up: 12,
  local_bytes: 3_000_000_000,
  local_budget_bytes: null,
  offloaded: 0,
  last_run_at: null,
  last_error: null,
};

function library(readOnly: boolean): Library {
  return {
    id: 'lib',
    root_path: '/photos',
    bin_name: readOnly ? null : 'Bin',
    read_only: readOnly,
    name: 'Photos',
    ordering: 'taken_asc',
    rendition_source: 'render',
    rendition_hdr: true,
    render_skip_full: [],
    render_skip_max: [],
    include_subfolders: true,
    include_non_raw: false,
    auto_stack: true,
    auto_stack_similarity: 0.78,
    auto_stack_window_seconds: 60,
    last_synced_at: null,
    photo_count: 12,
  };
}

function Seed(): null {
  const backup = useBackupStore();
  useEffect(() => {
    runInAction(() => {
      backup.byLibrary = new Map([[status.library_id, status]]);
    });
  }, [backup]);
  return null;
}

async function open(readOnly: boolean): Promise<void> {
  render(
    <StoresProvider>
      <Seed />
      <BackupPanel library={library(readOnly)} />
    </StoresProvider>,
  );
  await act(async () => {});
}

test('a read-only library disables its storage limit and says why', async () => {
  await open(true);

  const refusal = 'Read-only libraries cannot remove local originals.';
  const field = screen.getByRole('spinbutton', { name: 'Storage limit (GB)', description: refusal });
  expect(field.matches(':disabled')).toBe(true);
  expect(field.closest('[aria-description]')?.getAttribute('aria-description')).toBe(refusal);
});

test('a writable library keeps its storage limit editable', async () => {
  await open(false);

  const field = screen.getByRole('spinbutton', {
    name: 'Storage limit (GB)',
    description: "Above this, we'll remove the local copies you've used least recently. They stay on the backup.",
  });
  expect(field.matches(':disabled')).toBe(false);
  expect(field.closest('[aria-description]')).toBeNull();
});
