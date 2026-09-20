// What hiding does to a stack (§12.4), on both sides of it.
//
// A tile's count and the band it opens are two queries over one question, in two modules: the
// listing's `stack_size` (`photo_query.sizeExpression`) and `StacksRepository.memberIds`. What
// most of these pin is that hiding cannot make them disagree - a stack that says three and opens
// onto four is the failure, and every arm of it is a different scope the band has to be told about.
// The last pair is the other side: detection is work, so it never proposes a stack out of frames
// nobody is looking at.
import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from '../../../db/driver';
import { runMigrations } from '../../../db/migrate';
import { PhotoListingRepository } from '../../photos/listing/photo_listing_repository';
import { PhotoStateRepository } from '../../photos/mutations/photo_state_repository';
import { StackMembership } from '../stack_membership';
import { StacksRepository } from '../stacks_repository';

const LIB = 'lib';
const STACK = 'st1';

let db: Database;
let photoListing: PhotoListingRepository;
let photoState: PhotoStateRepository;
let stacks: StacksRepository;

function shoot(id: string, folderPath: string, hidden: boolean): void {
  db.query('INSERT INTO shoots (id, library_id, folder_path, name, is_hidden) VALUES (?, ?, ?, ?, ?)').run(
    id,
    LIB,
    folderPath,
    id,
    hidden ? 1 : 0,
  );
}

function photo(id: string, shootId: string | null): void {
  db.query(
    `INSERT INTO photos (id, library_id, shoot_id, recipe, width, height, date_added, stack_id, is_representative)
       VALUES (?, ?, ?, json_object('kind', 'file', 'path', ?), 100, 100, '2026-01-01T00:00:00.000Z', ?, 0)`,
  ).run(id, LIB, shootId, `${id}.arw`, STACK);
}

/** What the tile says it stands for, and what the band actually hands back. */
function tileAndBand(scope: { shootId?: string }): [number | undefined, string[]] {
  const listing =
    scope.shootId == null ?
      photoListing.listByLibrary(LIB, 'added_asc', 0, 10, { includeDeleted: false })
    : photoListing.listByShoot(scope.shootId, 'added_asc', 0, 10, { includeDeleted: false });
  const tile = listing.photos.find((row) => row.stack_id === STACK);
  return [tile?.stack_size, stacks.memberIds(STACK, 'added_asc', false, scope.shootId).sort()];
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  db.query("INSERT INTO libraries (id, root_path, name) VALUES (?, '/photos', 'Trip')").run(LIB);
  photoListing = new PhotoListingRepository(db);
  photoState = new PhotoStateRepository(db, new StackMembership(db));
  stacks = new StacksRepository(db);
  db.query("INSERT INTO stacks (id, library_id, origin, date_created) VALUES (?, ?, 'manual', '2026-01-01')").run(
    STACK,
    LIB,
  );
});

describe('a stack under a hidden shoot', () => {
  beforeEach(() => {
    shoot('away', 'Away', true);
    photo('one', 'away');
    photo('two', 'away');
    db.query("UPDATE photos SET is_representative = 1 WHERE id = 'one'").run();
  });

  // The shoot is hidden, so the library has no tile for this stack at all - and asking for the band
  // from there must hand back nothing rather than the members the tile is not offering.
  it('is gone from the library, band and all', () => {
    expect(tileAndBand({})).toEqual([undefined, []]);
  });

  // Its own page still shows it, which is the exemption `ownShoot` exists for - so the band there
  // has to be told the shoot, or the tile counts two and opens onto none.
  it('opens onto what its own page counted', () => {
    expect(tileAndBand({ shootId: 'away' })).toEqual([2, ['one', 'two']]);
  });

  it('drops a member put away by hand from both', () => {
    photoState.setHidden(['two'], true);
    expect(tileAndBand({ shootId: 'away' })).toEqual([1, ['one']]);
  });
});

// The case a blanket "this listing ignores shoot hiding" switch gets wrong: exempting one shoot must
// not exempt the other, or the visible shoot's page counts and shows the half that was put away.
describe('a stack straddling a hidden shoot and a visible one', () => {
  beforeEach(() => {
    shoot('open', 'Open', false);
    shoot('away', 'Away', true);
    photo('shown', 'open');
    photo('away-one', 'away');
    db.query("UPDATE photos SET is_representative = 1 WHERE id = 'shown'").run();
  });

  it('counts and opens onto only the half the visible shoot holds', () => {
    expect(tileAndBand({ shootId: 'open' })).toEqual([1, ['shown']]);
  });

  it('shows the same half in the library, where neither shoot is exempt', () => {
    expect(tileAndBand({})).toEqual([1, ['shown']]);
  });
});

// Detection is work, and work passes a hidden photograph over (§12.4) - so a put-away frame is never
// proposed into a stack with the ones still being looked at. No exemption here: detection is not a
// reading of one shoot.
describe('what detection is allowed to consider', () => {
  beforeEach(() => {
    shoot('away', 'Away', true);
    shoot('open', 'Open', false);
    photo('in-hidden-shoot', 'away');
    photo('put-away', 'open');
    photo('ordinary', 'open');
    // A descriptor is what makes a photograph a candidate at all; without one none of these is.
    db.query("UPDATE photos SET descriptor = x'00', stack_id = NULL, stack_state = 'none'").run();
    photoState.setHidden(['put-away'], true);
  });

  it('leaves out a photograph put away, and one whose shoot is', () => {
    expect(stacks.candidates(LIB).map((c) => c.id)).toEqual(['ordinary']);
  });

  it('takes them back once they are unhidden', () => {
    photoState.setHidden(['put-away'], false);
    db.query("UPDATE shoots SET is_hidden = 0 WHERE id = 'away'").run();
    expect(stacks.candidates(LIB).map((c) => c.id).sort()).toEqual(['in-hidden-shoot', 'ordinary', 'put-away']);
  });
});
