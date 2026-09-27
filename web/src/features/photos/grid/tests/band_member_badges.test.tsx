import { afterEach, expect, test } from 'bun:test';
import { runInAction } from 'mobx';
import { useEffect } from 'react';
import { type PhotoSummary } from '../../../../../../src/schemas/photos';
import { registerDom } from '../../../../test_dom';

registerDom();
const { cleanup, render, screen } = await import('@testing-library/react');
const { MemoryRouter } = await import('react-router-dom');
const { BandMember } = await import('../photo_tile');
const { StoresProvider, useReplicationStore } = await import('../../../../app/stores_context');

afterEach(cleanup);

const member = (state: Partial<PhotoSummary>): PhotoSummary =>
  ({
    id: 'p1',
    library_id: 'lib',
    file_path: 'shoot/DSC0001.ARW',
    width: 6000,
    height: 4000,
    stack_id: 's1',
    stack_size: 3,
    composite_kind: null,
    is_missing: false,
    is_offloaded: false,
    is_deleted: false,
    is_hidden: false,
    ...state,
  }) as PhotoSummary;

function CatalogueOnly(): null {
  const replication = useReplicationStore();
  useEffect(() => {
    runInAction(() => {
      replication.peersByLibrary = new Map([
        [
          'lib',
          [
            {
              peer_id: 'nas',
              name: 'NAS',
              paired_at: '2026-01-01T00:00:00.000Z',
              last_replicated_at: null,
              last_error: null,
              wants_originals: true,
              outdated: null,
            },
          ],
        ],
      ]);
      replication.syncOriginalsByLibrary = new Map([['lib', false]]);
    });
  }, [replication]);
  return null;
}

function renderMember(photo: PhotoSummary, catalogueOnly = false): void {
  render(
    <MemoryRouter>
      <StoresProvider>
        {catalogueOnly && <CatalogueOnly />}
        <BandMember photo={photo} />
      </StoresProvider>
    </MemoryRouter>,
  );
}

test('a band member with no file says it is missing', () => {
  renderMember(member({ is_missing: true }));
  expect(screen.getByText('missing')).toBeTruthy();
});

test('a band member held only on the backup wears the snowflake', () => {
  renderMember(member({ is_missing: true, is_offloaded: true }));
  expect(screen.getByLabelText('on the backup')).toBeTruthy();
  expect(screen.queryByText('missing')).toBeNull();
});

test('a band member whose original stays on a synced device wears the network glyph', () => {
  renderMember(member({ is_missing: true }), true);
  expect(screen.getByLabelText('on a synced device')).toBeTruthy();
  expect(screen.queryByText('missing')).toBeNull();
});

test('a binned band member says so', () => {
  renderMember(member({ is_deleted: true }));
  expect(screen.getByText('in Bin')).toBeTruthy();
});
