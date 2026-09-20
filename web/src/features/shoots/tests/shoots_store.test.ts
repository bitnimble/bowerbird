import { expect, test } from 'bun:test';
import { PathSegment, route } from '../../../../../src/schemas/route';
import { type Shoot } from '../../../../../src/schemas/shoots';
import { NO_SHOOT_PATH, ShootsStore } from '../shoots_store';

function store(fields: Partial<ShootsStore>): ShootsStore {
  return Object.assign(new ShootsStore(), fields);
}

const SHOOT: Shoot = {
  id: 'id:Reef',
  parent_id: null,
  library_id: 'lib',
  folder_path: 'Reef',
  name: 'Reef',
  description: null,
  banner_photo_id: null,
  ordering: 'taken_asc',
  photo_count: 3,
  is_hidden: false,
  hidden_directly: false,
};

test('the photographs in no shoot lead the list, counted', () => {
  const rows = store({ rootPhotoCount: 2, shoots: [SHOOT] }).rows;
  expect(rows.map((r) => r.key)).toEqual([NO_SHOOT_PATH, 'Reef']);
  expect(rows[0]?.name).toBe('Not in any shoot (2 photos)');
});

// A row that stands for a listing shows the first photograph of it, the same as
// a shoot's does; without one it wore the placeholder icon for good.
test('the row shows the first of the photographs it stands for', () => {
  const rows = store({ rootPhotoCount: 2, rootBannerPhotoId: 'p1' }).rows;
  expect(rows[0]?.bannerPhotoId).toBe('p1');
});

// Nothing to open, and while the first read is in flight the count is zero
// because nothing has been read - so the page can say it is still reading.
test('there is no row for them when there are none', () => {
  expect(store({ shoots: [SHOOT] }).rows.map((r) => r.key)).toEqual(['Reef']);
  expect(store({ loading: true }).rows).toEqual([]);
  expect(store({ loading: true }).isEmpty).toBe(false);
});

// The row is the whole list here, and a page holding it is not an empty one -
// which the "no folders holding photographs" block would otherwise say beneath it.
test('a library whose photographs are all at the root is not empty', () => {
  expect(store({ rootPhotoCount: 2 }).isEmpty).toBe(false);
  expect(store({}).isEmpty).toBe(true);
});

// Whether a hidden shoot is here at all is the server's answer (§12.4), so what the store has to get
// right is how one is drawn once it has been asked for: in its own place, greyed, and saying so -
// dimming alone is what an untracked folder and an empty shoot already look like.
const HIDDEN: Shoot = { ...SHOOT, id: 'id:Wharf', folder_path: 'Wharf', name: 'Wharf', is_hidden: true };

test('a hidden shoot is drawn in its own place and says it is hidden', () => {
  const row = store({ shoots: [SHOOT, HIDDEN] }).rows.find((r) => r.key === 'Wharf');
  expect(row?.tone).toBe('hidden');
  expect(row?.meta).toBe('Hidden · 3 photos');
  expect(row?.href).toBe(route(PathSegment.shoots(), 'id:Wharf'));
});

// The listing leaves the hidden out, so a reader standing on one has to have got it some other way.
test('a shoot resolved by id is found even though no listing holds it', () => {
  const held = store({ shoots: [SHOOT], resolved: new Map([[HIDDEN.id, HIDDEN]]) });
  expect(held.byId.get(HIDDEN.id)).toBe(HIDDEN);
  // And the listing wins where both have it, being the fresher of the two.
  const both = store({ shoots: [SHOOT], resolved: new Map([[SHOOT.id, { ...SHOOT, name: 'stale' }]]) });
  expect(both.byId.get(SHOOT.id)?.name).toBe('Reef');
});
