import { describe, it, expect } from 'bun:test';
import type { LibraryScope } from '../../../../utils/scope';
import { wentAway, withoutStalled } from '../scan_scope';

// §7.4: a merged move the drain could not make is the one disagreement between
// catalogue and disk a scan must not read.
describe('holding a stalled materialisation out of a scan', () => {
  const photo = (id: string) => ({ id });
  const file = (relPath: string) => ({ relPath });
  const all = {
    dbPhotos: [photo('p1'), photo('p2')],
    files: [file('Day1/a.arw'), file('Day2/b.arw')],
    binned: [photo('p3')],
    binFiles: [file('Bin/Day1/c.arw')],
  };

  it('takes the photograph out of both channels, not just the live one', () => {
    const kept = withoutStalled(all, [{ photoId: 'p1', wasAt: 'Day1/a.arw' }, { photoId: 'p3', wasAt: 'Bin/Day1/c.arw' }]);

    expect(kept.dbPhotos.map((p) => p.id)).toEqual(['p2']);
    expect(kept.binned).toEqual([]);
  });

  /*
   * The one that replicates, and the reason the bin walk is filtered at all.
   *
   * A merge restores a photograph: the row leaves the binned set while the file
   * is still at its old bin path. Unfiltered, the bin walk finds a file no row
   * claims and cannot pair it - the live-side removal that would have paired it
   * is exactly what is held back - so it is inserted as a new photograph with a
   * fresh id, and *that* replicates. Two rows for one file is not something
   * anything undoes.
   */
  it('takes the file out of the bin walk, so a restore in flight is not imported again', () => {
    const kept = withoutStalled(all, [{ photoId: 'p3', wasAt: 'Bin/Day1/c.arw' }]);

    expect(kept.binFiles).toEqual([]);
    // And the live walk is untouched by a bin-side stall.
    expect(kept.files).toHaveLength(2);
  });

  it('takes the file out of the live walk, so a binning in flight is not read as gone', () => {
    const kept = withoutStalled(all, [{ photoId: 'p1', wasAt: 'Day1/a.arw' }]);

    expect(kept.files.map((f) => f.relPath)).toEqual(['Day2/b.arw']);
    expect(kept.binFiles).toHaveLength(1);
  });

  it('hands back exactly what it was given when nothing is stalled', () => {
    expect(withoutStalled(all, [])).toBe(all);
  });
});

/**
 * Deleting a shoot replicates, and a shoot's grave is final: name, description,
 * ordering, banner and the whole subtree, on every device, unrecoverably. So the
 * only absence that justifies it is one the walk was actually in a position to
 * observe.
 */
describe('a shoot folder that went away', () => {
  const scope = (over: Partial<LibraryScope> = {}): LibraryScope => ({
    rootPath: '/photos',
    includeSubfolders: true,
    includeNonRaw: false,
    binName: 'Bin',
    excluded: new Set<string>(),
    ...over,
  });
  const shoot = { folder_path: 'Trip', folder_dev: 42 };

  it('is a folder this device walked before and did not find now', () => {
    expect(wentAway(scope(), new Set(), shoot)).toBe(true);
  });

  it('is not one the walk found', () => {
    expect(wentAway(scope(), new Set(['Trip']), shoot)).toBe(false);
  });

  // Settable on any folder from the settings page, not only by removing a shoot.
  it('is not one the walk was told to skip', () => {
    expect(wentAway(scope({ excluded: new Set(['Trip']) }), new Set(), shoot)).toBe(false);
  });

  // A root-only library walks no folders at all, so every shoot in it is absent.
  it('is not any of them when the library walks no folders', () => {
    expect(wentAway(scope({ includeSubfolders: false }), new Set(), shoot)).toBe(false);
  });

  // A replicated shoot whose photographs have not arrived to make its folder - and
  // one holding none never gets a folder at all.
  it('is not one this device has never seen', () => {
    expect(wentAway(scope(), new Set(), { folder_path: 'Trip', folder_dev: null })).toBe(false);
  });
});
