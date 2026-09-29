# Bowerbird design: The catalogue

A chapter of [`DESIGN.md`](../../DESIGN.md). The chapters are numbered as one document, so
`DESIGN §N` anywhere in the repo, and a `§N` cited here that is not below, both mean the
section the index in `DESIGN.md` maps §N to.

---

## 4. Database Schema

Store `datetime` as ISO 8601 TEXT with `Z` suffix (e.g. `2024-06-15T04:30:00.000Z`)
so byte and chronological order agree in `date_added`/`date_taken` indexes (§4.2).
`date_added` is a UTC-normalized instant, including server DST changes. `date_taken`
preserves EXIF's naive wall clock encoded as UTC (§11.1); UTC formatting
(`captureDateTime`) displays the camera's time unchanged in every zone.

All entity IDs are stored as TEXT (§3).

`connection.ts` sets `PRAGMA foreign_keys = ON` on every connection; enforcement is
connection-local. The acyclic schema permits migrations in dependency order.

### 4.1 `libraries` table

```sql
CREATE TABLE libraries (
  id          TEXT PRIMARY KEY,
  root_path   TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,  -- display name; create stores the folder name (or parent + year) when none is given
  ordering    TEXT NOT NULL DEFAULT 'taken_asc'
    CHECK (ordering IN ('taken_asc', 'taken_desc', 'added_asc', 'added_desc')),
  -- How much of the folder tree this library is (§4.7).
  include_subfolders INTEGER NOT NULL DEFAULT 1,
  -- Whether JPEG, PNG, HEIC and AVIF are photographs here or clutter to walk past (§7).
  include_non_raw    INTEGER NOT NULL DEFAULT 0,
  bin_name    TEXT,             -- folder soft-deleted RAWs move into, and the name the scan skips (§12.3); NULL = no bin
  read_only   INTEGER NOT NULL DEFAULT 0,  -- the app writes nothing under root_path
  -- The bin folder's identity, so a hand-rename of it is followed rather than
  -- read as the whole bin being restored (§9.4.1 for the same idea on shoots).
  bin_dev       INTEGER,
  bin_ino       INTEGER,
  bin_birthtime REAL
);
```

- `root_path`, absolute path to the library root folder on disk.
- `name`, what the library is called in the sidebar and in Settings. Required. On create, an omitted or blank name is filled from the root folder and stored: the last path segment, or when that segment is a four-digit year, `"<parent> <year>"` so date-sorted trees do not all show as `"2025"`. Renaming the folder on disk afterwards does not change the stored name.
- `ordering`, default ordering for photo listings in this library.
- `include_subfolders`, whether the scan descends past the root at all (§9.1). A standing rule rather than a decision taken once at import: a folder created next month is out of scope for the same reason today's are, so turning it off writes no `folder_rules` rows and never needs revisiting. Off makes shoots meaningless for the library - a shoot _is_ a subfolder, and its photos would never be scanned. Sync keeps shoots in step with the folders on disk (§9.4.1): every folder holding photos is a shoot, and the catalogue cannot disagree with the tree.
- `include_non_raw`, whether the finished formats are photographs here (§7). Off by default, and a standing rule like the one above it rather than an import-time choice: beside a folder of RAWs a JPEG is usually the camera's own copy of a frame the library already holds, and taking both makes every frame two rows. Turning it off makes the next scan stop finding them, so their rows go `is_missing` exactly as they would had the files been moved off the disk - the same thing `include_subfolders` does to a subfolder's, and not a delete: the rows stay until somebody removes them, and the files are never touched. Asked in the Add-library dialog as well as in Settings, because the import begins as the row lands (§9.8). It is replicated, unlike the rendition settings beside it: what the library _contains_ is the same catalogue on every peer, where where its renditions come from is a statement about one machine's disk.
- `bin_name`, what this library's bin folder is called at its root (§12.3). Per library rather than a constant because the name is also what the live scan skips: a root that already keeps a folder called `Bin` has it adopted as the bin, and everything inside it imports as already-binned rather than as part of the collection (§12.3). The Add-library dialog warns against the folder listing it already has, so that is settled while the name is still being chosen. **NULL means the library has no bin at all**, which is what a library born read-only is: nothing on disk records a binning, so `is_deleted` is the only truth. Nullable rather than `''` because joining `''` onto the root gives the root, which would point the bin channel at the whole library.
- `read_only`, whether the app may write under `root_path` at all: an archive volume, a NAS export mounted read-only, or a collection the photographer would rather no software rearranged. Almost nothing the catalogue knows was ever about the files, so what this actually turns off is short - binning moves nothing (§12.1), and a shoot has to be a folder that already exists (§4.3). `read_only = 0` with a NULL `bin_name` never persists: clearing the flag needs a `bin_name` in the same request, and makes the folder. Detected, not guessed: `access(dir, W_OK)`, reported per listing by `GET /api/browse`, and a create that says the root is writable when it is not is refused with `READ_ONLY` rather than silently upgraded.
- `bin_dev` / `bin_ino` / `bin_birthtime`, the bin folder's identity, recorded when the folder is made. A photographer renaming `<root>/Bin` to `<root>/Rubbish` has done to the bin what §9.4.1 already handles for a shoot, and it is answered the same way. Deliberately not on the `Library` API type: they would leak into every response.

**Changing `bin_name` through `PATCH` renames the folder.** A setting-only change
would re-import stranded binned RAWs. Run `rename` before and outside the transaction:
a crash leaves stale columns repairable by bin identity (§9.1). Committing first
would instead let repair revert the requested name.

### 4.2 `photos` table

```sql
CREATE TABLE photos (
  id                TEXT PRIMARY KEY,
  library_id        TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  shoot_id          TEXT REFERENCES shoots(id) ON DELETE SET NULL,
  file_hash         TEXT,
  recipe            TEXT NOT NULL,  -- how this row's pixels are arrived at, and what from (§4.2.1)
  file_size         INTEGER,        -- bytes at last scan; with date_updated, the sync stat quick-check (§9.1)
  width             INTEGER NOT NULL,  -- display (upright) pixel width, post-orientation
  height            INTEGER NOT NULL,  -- display (upright) pixel height, post-orientation
  orientation       INTEGER NOT NULL DEFAULT 0,  -- EXIF orientation, 1 to 8; informational + hash input only, NOT to be applied to renditions (§11)
  is_missing        INTEGER NOT NULL DEFAULT 0,
  is_deleted        INTEGER NOT NULL DEFAULT 0,
  is_hidden         INTEGER NOT NULL DEFAULT 0,  -- put away: out of every listing but the one asking for it (§12.4)
  date_taken        TEXT,
  date_added        TEXT NOT NULL,
  date_updated      TEXT,  -- last modified on disk
  -- One pending flag and one written-at stamp per import stage (10.2): the grid
  -- tile the gallery shows, then the photo viewer's renditions. Split so a run
  -- interrupted between them resumes at the one it did not reach, and so a URL
  -- versioned off a stamp moves only when its own file did (13.5).
  needs_tile        INTEGER NOT NULL DEFAULT 1,
  needs_renditions  INTEGER NOT NULL DEFAULT 1,
  tile_built_at     TEXT,
  renditions_built_at TEXT,
  -- Which develop settings each stored copy rendered, as the photo_edits stamp: a JSON
  -- object keyed by renditionVariant, {"grid": ..., "full-hdr": ..., "max-hdr": ...}.
  -- Staleness is decided on these and never on the times above: the edit is timed on
  -- whichever peer made it and the build on whichever peer holds the original, so
  -- comparing the two compares two machines' clocks (docs/replication.md §7.9). Per
  -- variant because the five files are written at five different moments (§10.3).
  built_from        TEXT,
  processing_error  TEXT,  -- last rendition-generation error; NULL if none/succeeded (§10.2)
  latitude          REAL,
  longitude         REAL,
  -- Shooting metadata off the RAW header (§11.1). shutter_speed is seconds.
  iso               INTEGER,
  shutter_speed     REAL,
  aperture          REAL,
  focal_length      REAL,
  camera_make       TEXT,
  camera_model      TEXT,
  lens_model        TEXT,
  rating            INTEGER NOT NULL DEFAULT 0 CHECK (rating >= 0 AND rating <= 5),
  triage            TEXT CHECK (triage IN ('picked', 'rejected')),  -- NULL = untriaged (§5.3)
  notes             TEXT
);

CREATE INDEX idx_photos_library ON photos(library_id);
CREATE INDEX idx_photos_shoot ON photos(shoot_id);
CREATE INDEX idx_photos_library_added ON photos(library_id, date_added);
CREATE INDEX idx_photos_library_taken ON photos(library_id, date_taken);
CREATE INDEX idx_photos_shoot_added ON photos(shoot_id, date_added);
CREATE INDEX idx_photos_shoot_taken ON photos(shoot_id, date_taken);
CREATE INDEX idx_photos_file_hash ON photos(library_id, file_hash);
CREATE INDEX idx_photos_path ON photos(library_id, json_extract(recipe, '$.path'));
CREATE INDEX idx_photos_needs_tile ON photos(needs_tile) WHERE needs_tile = 1;
CREATE INDEX idx_photos_needs_renditions ON photos(needs_renditions) WHERE needs_renditions = 1;
CREATE INDEX idx_photos_is_missing ON photos(library_id, is_missing) WHERE is_missing = 1;
CREATE INDEX idx_photos_is_deleted ON photos(library_id, is_deleted) WHERE is_deleted = 1;
CREATE INDEX idx_photos_is_hidden ON photos(library_id, is_hidden) WHERE is_hidden = 1;
```

- The `_order_` composite indexes serve the library and shoot list orderings (§5.1, §8.2 `listByLibrary`/`listByShoot`), and they are keyed **exactly as `orderByClause` spells the sort**: `(collection, is_deleted, <sort expression>, id)`, with the `taken_*` pair leading on the indexed `(date_taken IS NULL)` expression so the NULL-last grouping is part of the key rather than something evaluated per row. Getting this wrong is expensive in a way a pager hid: the `id` tiebreak that makes paging a total order (§18.3.3) is not optional, and an index without it sent every one of the four orderings through `USE TEMP B-TREE FOR ORDER BY` - a sort of the whole library **per request**, measured at 927ms for one block of a million-photo library, on a scroll that asks for ten thousand blocks. Keyed to match, all four plan as `SEARCH … USING COVERING INDEX` with no b-tree, and the same block costs 0ms.
  - The `id` tiebreak follows the direction of its sort (`… DESC, id DESC`), so `added_desc` is the ascending index walked backwards rather than a second index. `taken_desc` is the one ordering that genuinely differs by direction - NULLs stay last while the dates reverse - so it is the only one given a `_desc` twin.
  - `is_deleted` sits ahead of the sort columns because every listing filters on it, which keeps a deep `OFFSET` inside the index instead of probing the table for each row it skips: 326ms rather than 1097ms to reach position 900,000 of a million.
  - `SELECT COUNT(*)` is the other half, and no ordering index can cover it - the filter chips vary, so it is a scan of everything that matches: **774ms of a 792ms block fetch** at a million photos. So a listing only counts when asked to (`count`, §5.3), and `PhotoListResponse.total` and `photo_total` alike are absent when it was not. Nothing can change the count without starting a new pass over the collection - a filter, a sort, a bin, a scan tick all go through `refresh` - so the client asks on the first block of each pass and reuses the answer for the rest (§18.3.2). The number on screen is exactly as fresh as it was; it is simply not recomputed ten thousand times per scroll.
  - Album listings (`listByAlbum`, §8.2) are not covered: albums have no `library_id` (§4.4) so they span arbitrary photos, and `album_photos` is keyed only on `(album_id, photo_id)` (§4.5), so neither the date composites nor the album PK anchor an album-scoped ordering; these listings therefore incur a filesort, accepted as albums are typically small.

- `recipe`, how this row's pixels are arrived at and what from (§4.2.1). `{"kind":"file","path":"Trip/a.arw"}` for a photograph a camera wrote, which is almost every row; the path is relative to the library `root_path` and uses forward slashes regardless of OS.
- `format`, which of the formats in §7 this file is, with the spellings of one collapsed: `.jpg` and `.jpeg` are both `jpeg`, and `.heic`, `.heif` and `.hif` are all `heif`. CR2 and CR3 stay apart, being different formats Canon happens to have numbered. **Stored rather than derived, so a filter is a `WHERE` and not a `LIKE` over the path** - and collapsed here rather than at each caller, so filtering for HEIC is not a list of extensions to remember. `utils/scan.ts`'s `formatOf` is the one mapping. NULL where the extension is not one this build imports, which a stored row can only be if it predates a format leaving the set; a later build fills it in rather than having to recognise a wrong answer already stored. Written at import and never again - every later write of a path is a folder rename, a bin move or a restore, none of which changes a filename's extension - which is why it rides in the `photo.imported` replication unit beside `date_added` rather than in `photo.placement` beside the recipe it came from.
- `is_missing`, set to 1 when the file is not found on disk during sync.
- `is_deleted` — set to 1 when the user requests deletion (file moved to Bin).
- `triage`, the cull verdict: `picked`, `rejected`, or NULL for untriaged. Three states rather than a boolean, because "not yet judged" is the set a photographer filters on most and a two-state flag cannot tell it apart from "judged and rejected". This replaced the old `selected` column: the migration turns every `selected = 1` row into `picked` and then drops the column, so the two can never disagree.

#### 4.2.1 A photograph is a recipe over files, not a file

`photos.recipe` is a discriminated union (`schemas/recipes.ts`): `file` names one
camera-written path; `panorama` combines different viewing directions into a wider
picture; `assembly` combines takes of the same scene using chosen parts, such as
unblinking faces or unobstructed ground. **Paths belong inside recipes**, forcing
callers to handle a list of inputs. `originalPathOf` returns a path to own bytes only for
exactly one file, otherwise null; `soleInputOf` gives the same answer without joining
the library path.

Unknown recipes, including newer peers' kinds, become `unreadable`, never `file`:
this build cannot produce their picture, and a fabricated file path would hold nothing.

`photo_inputs` unpacks one row per recipe file. **Triggers maintain it**
(`photoInputTriggers`), like `replication_log`, across imports, renames, bin moves and
merges. It supports folder/path queries and reverse invalidation: `photos JOIN
photo_inputs` diffs shared files against each dependent photo. Derived, never replicated.

The same triggers fill `photo_sources`, one row per _photograph_ composed by
`panorama` or `assembly`. It identifies hidden source rows and their composites.
Only `composed_id` has a foreign key: stamp-ordered replication may deliver composites
before their frames.

**A kind this build does not recognise is never read as a shape it does recognise, and that has to hold for
replication too.** Whether a row's own bytes might be missing (`isComposite`, `apply.ts`'s `composed()`) and
whether a peer's row indexes any frames at all both answer _"is this not a `file`"_ rather than naming
`panorama` or `assembly` outright - a photograph that composes others has none of its own bytes to lose,
which is as true of a kind this build has never heard of as of one it has. `photoInputTriggers`' own
allowlist is the one place that keeps a name list rather than a shape check, and it is tested for it: every
kind in the recipe union except `file` has to appear there, or a peer's crafted row can claim a photograph as
a frame no live composite actually holds.

**A composite is a photograph** (§19.4). As a row of its own it is one listing entry, its copies are keyed
by its own id, the queue rebuilds it like anything else, the bin takes it, and replication carries it as
`photo.placement`. Its `width`/`height` are the canvas already framed to what its frames cover - the
_union_ of them for a panorama, so the frame is as wide as anything any source saw; the _intersection_ for
an assembly, so the result is exactly the ground every frame agrees on and is slightly smaller than any
single input - so either lays out like any other picture; the canvas itself is an internal of the recipe.
Its frames are hidden behind it in a collapsed listing (`NOT_A_FRAME`) and shown in the band its badge
opens. Nothing about it is a stack: the frames may be stacked, loose or a mixture, and regrouping them never
touches the recipe.

### 4.3 `shoots` table

```sql
CREATE TABLE shoots (
  id            TEXT PRIMARY KEY,
  parent_id     TEXT REFERENCES shoots(id) ON DELETE CASCADE,
  library_id    TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  folder_path   TEXT NOT NULL,  -- FULL path relative to library root, incl. ancestor shoot folders, forward slashes
  name          TEXT NOT NULL,
  description   TEXT,
  ordering      TEXT NOT NULL DEFAULT 'taken_desc'
    CHECK (ordering IN ('taken_asc', 'taken_desc', 'added_asc', 'added_desc')),
  -- The folder's identity independent of its name, so a rename on disk is
  -- recognised rather than read as a delete plus a create (§9.4.1).
  folder_ino        INTEGER,
  folder_birthtime  REAL,
  is_hidden         INTEGER NOT NULL DEFAULT 0,  -- off the shoots tree, its photographs off every listing (§12.4)
  UNIQUE (library_id, folder_path)
);

CREATE INDEX idx_shoots_library ON shoots(library_id);
CREATE INDEX idx_shoots_parent ON shoots(parent_id);
CREATE INDEX idx_shoots_hidden ON shoots(is_hidden) WHERE is_hidden = 1;
```

- `folder_path` is the **full** path from the library root to this shoot's folder (forward slashes), e.g. `Weddings/2024/Smith`. It is _not_ parent-relative: storing the full path lets sync reconciliation (§9.4) and create-adoption (§8.5) test membership with a prefix check on a photograph's input paths (§4.2.1), and lets the most-specific (longest matching) shoot win for nested folders. On create it is the requested `parent_path` plus the name, and `parent_id` is then read back off it (§8.5) rather than chosen alongside it. Nothing _in the app_ rewrites it afterwards: `name` seeds the folder once and is a label from then on, so renaming a shoot never moves a file (§8.5). It does follow the folder when the folder itself moves **on disk**, which is the one writer (§9.5).
- **Membership test (used everywhere "a file falls under a shoot" is checked):** a file belongs to a shoot iff its path starts with `folder_path + '/'`; a _photograph_ belongs iff **every** file it is composed from does, which for almost all of them is the one it is (`INPUTS_ALL_UNDER`, §4.2.1); the trailing separator is required so shoot `NYC` (`folder_path` `NYC`) does not capture files in sibling shoot `NYC2`. "Directly under" a shoot means the remainder after that prefix contains no further `/` (deeper files belong to a descendant shoot). Among all matching shoots, the one with the longest `folder_path` wins.
- When a photo is added to a shoot, its file is physically moved on disk into the shoot's folder.
- **A shoot is identified by its folder, not by its name** (`UNIQUE (library_id, folder_path)`). The folder is the thing that exists; the name is a label on it. Names were once unique library-wide, which mirroring (§9.5) makes simply false to disk: a tree with `NYC/Day1` and `LA/Day1` is ordinary, and a constraint that rejects it would have the catalogue refusing to describe folders the user already has. Uniqueness on `folder_path` is also _tighter_ against the collision the old constraint was defending, two shoots sharing one folder, since that is the collision stated directly rather than inferred from names. Renaming a shoot therefore never conflicts.
- `folder_dev`, `folder_ino` and `folder_birthtime` are the folder's identity independent of its path, `stat`'s `dev`, `ino` and `birthtimeMs`, recorded on create and refreshed on every scan that sees the folder. A rename preserves all three (verified on ZFS; POSIX guarantees the inode across a `rename(2)` within a filesystem), so a shoot whose folder_path has gone can be found again wherever it now sits (§9.4.1), including one holding no photos at all. **`dev` is half the key, not a detail:** inode numbers are unique only within one filesystem, so a library with a card reader or a share mounted inside it would otherwise match a dead shoot against an unrelated folder on the other volume and rewrite every one of its photos' paths onto it. `birthtime` is the third guard, against a recycled inode number, and is advisory: some filesystems report `0`, so it only rejects a match when both values are non-zero. All three are NULL for a shoot whose folder has never been scanned, and a move across filesystems changes the inode, which is what the fallback in §9.4.1 is for.
- The banner photo, if any, lives in the `shoot_banners` table (§4.6), not on this table; a `banner_photo_id` column here would form a `photos` ↔ `shoots` FK cycle.

### 4.4 `albums` table

```sql
CREATE TABLE albums (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  ordering        TEXT NOT NULL DEFAULT 'taken_desc'
    CHECK (ordering IN ('taken_asc', 'taken_desc', 'added_asc', 'added_desc'))
);
```

The banner photo, if any, lives in the `album_banners` table (§4.6).

### 4.5 `album_photos` table

```sql
CREATE TABLE album_photos (
  album_id    TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  photo_id    TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  date_added  TEXT NOT NULL,
  PRIMARY KEY (album_id, photo_id)
);

CREATE INDEX idx_album_photos_photo ON album_photos(photo_id);
```

### 4.6 Banner tables

Shoot and album banners use join tables. A `banner_photo_id` on shoots would create
a `photos` ↔ `shoots` FK cycle; separate associations preserve full FK integrity
without a reverse edge into `shoots` from `photos`.

```sql
CREATE TABLE shoot_banners (
  shoot_id  TEXT PRIMARY KEY REFERENCES shoots(id) ON DELETE CASCADE,
  photo_id  TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE
);

CREATE TABLE album_banners (
  album_id  TEXT PRIMARY KEY REFERENCES albums(id) ON DELETE CASCADE,
  photo_id  TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE
);

CREATE INDEX idx_shoot_banners_photo ON shoot_banners(photo_id);
CREATE INDEX idx_album_banners_photo ON album_banners(photo_id);
```

- The `PRIMARY KEY` on the owner column enforces at most one banner per shoot/album.
- `ON DELETE CASCADE` on the owner column removes the banner row automatically when the shoot/album is deleted (a DB-record delete, not a disk operation, §8). No app-level bookkeeping needed.
- `ON DELETE CASCADE` on `photo_id` removes the association if the underlying photo is hard-deleted (only via library-delete cascade; soft-delete leaves the record and its banner intact).
- `banner_photo_id` still appears in the `Shoot` and `Album` **response** schemas (§5.4, §5.5), resolved by joining the respective table.
- These tables hold a **choice**, never a default. A shoot with no row falls back to its first photo in the shoot's own ordering, computed in the `SELECT` (`shoots_repository.ts`) rather than written at import. The first photo moves as photos are added, binned or re-dated, so a stored default would go stale, and once stored it could no longer be told apart from a photo the user actually picked. Binned photos are excluded, so the banner agrees with the photo count beside it. A row here still wins, and deleting it returns the shoot to its first photo rather than to no banner at all.

### 4.7 `folder_rules` table

```sql
CREATE TABLE folder_rules (
  library_id   TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  folder_path  TEXT NOT NULL,  -- root-relative, forward slashes, no trailing separator
  rule         TEXT NOT NULL CHECK (rule IN ('excluded', 'plain')),
  PRIMARY KEY (library_id, folder_path)
);
```

Per-folder exceptions to library defaults (§4.1), sharing one table/key so rules
cannot disagree about a path.

- **`excluded`**, the folder is not scanned, so nothing inside it is in the catalogue. Subtree-wide by construction: a folder that is never walked has no children to consider. This is the folder of rejects triaged years before the library existed, and the rest of the tree that is not photographs.
- **`plain`**, the folder is scanned normally and its photos are in the library, but mirroring will not make it a shoot. Per-folder and **not** inherited: declaring `A` plain leaves `A/B` free to be a shoot, since "this folder is not a set of photographs" says nothing about what is filed beneath it.
- A `plain` rule is what makes "delete this shoot but keep its photos" survive the next sync; without it, mirroring would recreate the shoot within seconds and the delete would read as broken (§8.5).
- The `PRIMARY KEY` means one rule per folder: `excluded` and `plain` are answers to the same question ("what is this folder to the library"), so the second write replaces the first rather than stacking.

### 4.8 `sync_locks` table

```sql
CREATE TABLE sync_locks (
  library_id    TEXT PRIMARY KEY REFERENCES libraries(id) ON DELETE CASCADE,
  owner         TEXT NOT NULL,   -- one per acquire rather than per process
  started_at    TEXT NOT NULL,   -- toISOString(), UTC, which is what makes the comparison valid
  refreshed_at  TEXT NOT NULL
);
```

"This library is syncing", as a leased row (§9.7). `owner` is minted per **acquire**, not per process: a per-process owner let a run whose lease had lapsed delete its successor's row on the way out, and let two syncs in one server both believe they held it. No `pid` column - a PID means nothing outside the namespace it was minted in, which is the whole reason this is not a file at the library root any more.

A row present at startup means "stale within the lease", not "syncing": a crashed process leaves its row and expiry clears it, so startup deletes nothing.

### 4.9 Backups and restore

The catalogue uniquely holds ratings, notes, verdicts, memberships, assignments,
stacks and sidecar-free edits; rescanning recovers none of them. Backups have their
own schedule (`backup_every_days`, `backup_keep`, §15): daily, seven retained, both
editable; `0` days disables.

**`VACUUM INTO`, not a file copy.** It reads a consistent snapshot inside a read transaction, so nothing has to be paused around it, and it writes one self-contained file; no `-wal` to be restored alongside it and no way to restore half a pair. The path is bound rather than interpolated.

**Atomic promotion.** `VACUUM INTO` refuses existing destinations. Write a dot-prefixed
working file, verify, then atomically rename; real backup names never expose partials.
The caller removes failed working files, including disk/thread failures. Each run also
sweeps abandoned dot-files invisible to rotation, but only after an hour: live
`VACUUM INTO` does not pause that long, and immediate cleanup could delete concurrent
server/restart output.

**Dedicated thread** (`backup_worker.ts`): synchronous vacuum on the main DB-writing
thread (§10.2) would block requests for seconds. A separate read-only connection's
transaction blocks no writer. Skip due runs while one remains in flight.

Handle both silent worker failures so promises settle and schedules unlatch: unexpected
exit via `close`, and a live wedge via a six-hour deadline. `VACUUM INTO` or `statfs`
can hang on mounts such as `/config`; the deadline bounds hangs, not normal performance.

Raise `readdir` errors except nonexistent directories; never report unreadable backups
as absent. Explicit-path restore needs no listing and remains usable when the backup
directory is unreadable.

**Verify before promotion:** reopen for `PRAGMA quick_check` and compare
`user_version` with the producing connection. `VACUUM INTO` preserving `user_version`
underpins restore version checks; fail at backup time if that invariant changes.

Check free space on the _backup volume_: **max(main file, `-wal`) × one and a half**.
Long readers prevent checkpoint progress; a 220KB main plus 56MB WAL vacuumed to
46MB, 200x `stat(dbPath).size`. Summing also overestimates rewritten pages:
15.7MB plus 15.7MB vacuumed to 15.7MB, so demanding 47MB would reject usable space.

**The WAL it inflates is bounded by `journal_size_limit`, not by a checkpoint.** A checkpoint rewinds the WAL to be overwritten from the start rather than shrinking it, so the file keeps the high-water mark of the worst burst the database has ever seen, for the life of that database. Under ordinary load that mark is just the autocheckpoint threshold: measured, 40MB written in small commits holds the WAL at 4.0MB, however long it goes on. What overshoots it is a long-lived _reader_, which pins the snapshot a checkpoint would have to move past; and this backup's read transaction is exactly one. With a reader held open across that same 40MB the WAL grows to somewhere between 49MB and 470MB and stays there, because every version of every page touched has to be kept while somebody may still read the old one. The spread is the point: the multiplier is set by commit _shape_, not by bytes written - measured 1.2x at 64KiB values per commit, 2.7x at 8KiB, 11.8x at 1KiB - so no single number characterises it and the bound cannot be reasoned about from write volume.

So `connection.ts` sets `journal_size_limit` to 16MB, four times the autocheckpoint threshold: clear of anything normal operation reaches, low enough to reclaim a blowup like that. The alternative, a periodic `wal_checkpoint(TRUNCATE)` when the server looks idle, needs idle detection to be safe, because TRUNCATE waits out every reader and takes the write lock. The limit needs none: it is applied at the next WAL reset, so the space comes back once writing resumes and wraps, with nothing blocking.

**Check newest snapshot age hourly against `backup_every_days`.** Timer-only
scheduling can miss every backup on frequently restarted servers or nightly-shutdown
laptops; age checks also avoid backing up on every development reload.

Date snapshots by the **stamp at the end of their name**, not mtime. Unanchored
matching could reuse a date in `<db>.pre-restore-<stamp>` when used as `DB_PATH`,
making every backup overdue. Name stamps survive copying, unzipping, downloading and
rsync without `-t`; modified mtimes made `latest` select the oldest rescued snapshot.

**Ignore future-dated snapshots when scheduling.** Clock skew affects names and mtimes:
trusting it stalls backups; treating it as due triggers every hourly check. Measured:
a week of daily history vanished in eight ticks, all reporting success. Ignore it so
a current snapshot governs the next check. `latest` also selects by valid date rather
than name, keeping `bun run restore latest` from reporting success with the oldest copy.

That the check is hourly and fixed is not a detail: `setInterval` clamps a delay past its signed 32-bit range to 1ms, so scheduling on the interval directly would fire continuously from 25 days up. `backup_every_days: 30` would then rotate a week of history down to a few seconds of it, which is the exact opposite of what setting it asks for. Reading the interval instead of sleeping it removes the failure mode rather than bounding it. (`ScheduledPrune` still schedules on the interval directly and so still has the wrap; there the consequence is only wasted I/O, and it has no record of its last run to date itself against.)

**Keep backups beside the database in `backups/`**, never disposable `DATA_DIR`
(§6). Library removal or manual data cleanup must cost only renders. Containers
therefore keep backups on `/config`, not `/data`.

Keep newest `backup_keep`, delete the rest. ISO-stamped names need no `stat` for
dating. Match the **whole database filename plus stamp shape**: stems collide for
`photos.db` and `photos.sqlite`; prefixes let `photos.db` claim `photos-archive.db`
backups, which sort newer and could displace all its own history.

Three things rotation will not do, each of them a way to end up with no history at all:

- **Delete on a retention below 1.** Refused rather than read as "keep none".
- **Delete the snapshot just taken**, whatever it sorts as. A clock stepped backwards gives it an older name than the history it joins, and which backup this run just made is not a question to leave to the wall clock.
- **Make a bogus date immortal.** Deletion is ordered oldest-first by _claimed age_, with an unreadable or future date counting as oldest rather than newest. Ordering by name instead leaves a future-stamped snapshot at the end of the list for ever, so rotation never reaches it while it still counts against `keep`: measured, seven of them collapse `backup_keep: 7` to "one snapshot, at most one interval old", with every run reporting a successful backup and a rotation.
  **A catalogue that has gone missing is refused at startup, not worked around in rotation** (`connection.ts`). "Missing" counts an _empty database_ as none: SQLite reads a zero-byte file as one, and the placeholder a killed restore leaves behind to hold its lock is a valid 4096-byte one, so neither `existsSync` nor a size test sees the hazard - the next start builds the schema into it and calls it a catalogue. Unreadable or locked counts as present, since something that cannot be opened is not something to refuse over. Opening creates, which is right for a first run and dangerous for every run after it: anything leaving `DB_PATH` absent - a volume that failed to mount, a restore killed between its renames, a path edited by one character - otherwise produces a silent empty replacement that the app is perfectly happy with. Everything downstream of that is invisible: the user sees an empty library and re-adds their folder, a rescan writes into the replacement, and the rolling backup starts snapshotting _it_, rotating the real catalogue's history away within `backup_keep` runs. So a missing catalogue with snapshots sitting beside it is a refusal to start, naming `bun run restore latest`.

Rotation cannot detect this safely: re-adding a library defeats emptiness guards,
and empty/small real catalogues both vacuum to 225280 bytes. A `libraries` count
cannot replace the startup check; that attempted downstream fix cost two rounds.

Rotate after promotion. Log rotation failures separately; failure to delete an older
file does not make the completed snapshot a failed backup.

**Restore is offline** (`scripts/restore-backup.ts`, `bun run restore`), because the running server holds the file it replaces:

```bash
bun run restore                # list what there is
bun run restore latest         # or a name exactly as that listing prints it
```

Include `scripts/restore-backup.ts` in the runtime image so the supported container
deployment can restore backups on its named volume during an outage.

#### Restoring by hand, and the one trap in it

A stopped server can be restored by copying a self-contained SQLite snapshot,
**provided old sidecars are removed too**:

```bash
docker compose stop bowerbird
rm bowerbird.db bowerbird.db-wal bowerbird.db-shm      # all three
cp backups/bowerbird.db-<stamp>.db bowerbird.db
docker compose start bowerbird
```

Replacing only `.db` can mix catalogues. A killed server's 12KB `-wal` beside a
replaced 225KB catalogue replayed old contents into the snapshot. WAL headers contain
magic, page size, checkpoint sequence, two salts and two checksums, but **no database
identity**. Even read-only opens replay it; mixed results open at the expected size
and pass `quick_check`.

**This is now caught rather than silent.** SQLite offers no way to bind a WAL to a database, but the _pairing_ is checkable: `VACUUM INTO` writes a rollback-journal file - every snapshot this app takes has read-version 1 in its header, where a live catalogue has 2 - and a database that has never been in WAL mode has never legitimately had a `-wal`. So a rollback-mode header beside a non-empty `-wal` means the two came from different databases, which is exactly the shape of this mistake. `createDatabase` refuses to start on it and names the two files to delete. It cannot false-positive: SQLite removes the `-wal` when a database leaves WAL mode, so the combination never arises legitimately.

This refusal catches only that pairing; use the restore tool for complete sidecar handling.

**Schema markers cannot detect replay.** Renamed tables or `application_id` on page
1 are overwritten by stale WAL pages. Measured beside a 3.3MB WAL: 401 old rows,
old schema, marker gone, apparently healthy. Inspect bytes before SQLite opens.
Do not auto-delete a detected WAL: another catalogue's contents may still be wanted.

The check leans on `VACUUM INTO` emitting a rollback-journal file, which is observed rather than a documented guarantee. It fails _open_ if that ever changes - no false refusals, just no protection - and the test asserting the refusal would go red, so it would not pass unnoticed.

What the tool does that a copy does not, worth knowing before choosing: it parks the old catalogue instead of deleting it, so a restore of the wrong snapshot is itself undoable; it runs `quick_check` and the version refusal _before_ touching anything; and it refuses outright if the server is still running, which a copy will happily land underneath. Two things still protect a manual restore: the filename has to be right or the startup refusal fires (naming `bun run restore latest`), and the snapshot really is complete on its own, having no sidecars of its own to forget.

In the container the file is owned by uid 1000; a `cp` run as root on the host leaves a catalogue the server cannot write.

Resolve bare names **only** against this catalogue's backup directory. Cwd fallback
for `photos.db-<stamp>.db` could restore another catalogue's valid snapshot undetectably.
Anything containing a separator is an explicit path, permitting copies kept elsewhere.

Restore through **`VACUUM INTO`**, not main-file copy, to include committed `-wal`
work. Measured: a 4KB main beside a 1.8MB WAL held none of its 300 rows or even the
table without the WAL. Parked catalogues and rescued copies may both need their WALs;
copying alone could silently lose all restored work.

It refuses a backup that is not there, one whose path is the catalogue itself, and the three below - and there is one thing it will not delete:

- **A catalogue another process still has open.** A restore while the server is up looks like it worked and throws away everything written afterwards: the server keeps writing through its open handle to the inode this moves aside, so its reads stay right, its shutdown is clean, and the work is discarded at the next start. `restart: unless-stopped` in the compose file means "stop the server first" cannot be left to a comment, so it is asked of the database directly, by taking an exclusive lock - exclusive _locking mode_, not just the write lock, because an idle server holds no write lock and is still a server. That also gets it right for a second container sharing the volume.

  **A missing catalogue gets a lock too.** With nothing at the path there is nothing to lock, and that is not a corner case: one of the two ways anyone arrives here is having deleted the catalogue that looked broken, and a host being restored onto may have no local backups either, so the startup refusal does not cover it. A server starting during the vacuum then creates its own catalogue at that path, takes writes into it, and has them discarded by the final rename - measured, 60 committed rows gone with both processes exiting 0 and nothing logged. So an empty file is put there purely to be locked, and is never parked as "the catalogue that was there".

  **The lock is held across the whole swap, not sampled at the start.** Everything after it - vacuuming the snapshot out, then the renames - takes as long as the catalogue is big: measured at 3.7s for 244MB, minutes on a slow volume. Releasing the lock after the check leaves that entire window open for a server to start in, and one that does writes through its handle to the inode about to be parked, so its reads stay right, its shutdown is clean, and the work is discarded at the next start with nothing reported anywhere. With `restart: unless-stopped` that window is a likely place for a server to appear, not a theoretical one.

  **Only a busy code counts**, matched as a prefix rather than exactly: bun reports SQLite's _extended_ result codes, and a lock refusal can arrive as `SQLITE_BUSY_RECOVERY` - another process recovering this WAL after a crash, which under `restart: unless-stopped` is precisely the shape of "the server died and came back while I was restoring". Every other way that probe can fail - not a database, a trashed header, a read-only file or directory - says the catalogue is broken or unwritable, which is _precisely why somebody is restoring_. Refusing on those was measured to leave a user with a corrupt catalogue no way through at all: told to stop a server that was not running, with deleting their only catalogue by hand as the only remaining move. A guard that fires hardest in the emergency it exists for is worse than no guard.

- **A backup from a newer Bowerbird.** Restoring an _older_ one is fine; the migrations run on the next start and bring it forward. The other direction is not: this build's migrations have no route to a schema they predate, and the failure would look like a corrupt catalogue rather than an error. The check is the newest migration the snapshot has had applied against the newest this build ships, both read from drizzle's journal. Every schema change is a migration and every migration is stamped, so unlike a counter somebody has to remember to bump, there is no way to move the schema without moving this.
- **A backup that does not pass `quick_check`.** A file that is not a database at all throws out of the open rather than returning a verdict, so that is caught and surfaced as the same refusal instead of a stack trace. Every refusal happens before anything on disk moves.
- **The catalogue that was there.** It is renamed aside to `<db>.pre-restore-<stamp>`, **with its `-wal`, `-shm` and `-journal`**. Moving the sidecars is half of what makes this correct: SQLite derives their names from the database's filename, so a live `-wal` left in place would replay the old catalogue's uncheckpointed pages over the restored file and quietly undo the restore. Taking them along also keeps the displaced catalogue openable, which is what makes a restore chosen in a panic itself undoable.

  **The sidecars move whether or not the catalogue itself is still there**, which is the case that actually happens: the likeliest route to a restore at all is that the catalogue looked broken, so somebody deleted it and put a backup back. Scoping the sidecar move to "only if the old file exists" makes precisely that path silently restore nothing - the `-wal` survives, the next start replays it, and the result passes `quick_check` at the right size with the old contents.

  `movedAside` is reported only when the catalogue itself was parked. A lone `-wal` moved out of the way is not something to point anyone at as "the catalogue that was there" - the path would hold no such file.

Stage beside the catalogue, then rename atomically; never overwrite with a potentially
truncated write. **Undo moves after any post-first-rename failure.** If rollback also
fails, report actual file locations rather than claiming recovery. Startup refusal is
the final backstop for a missing catalogue.

Sweep abandoned `<db>.restoring-<stamp>` files under the same age rule as backup
working files, preserving concurrent restores' staging files.

**Resolve symlinked `DB_PATH` first**, following bounded chains with `lstat`, including
**dangling** links. Replacing a link or only its first hop silently relocates the
catalogue and orphans its intended target. Dangling links are common after mount
failure or manual deletion; existence tests would miss them.

The refusals are ordered so the backup is validated **before** the in-use probe, because that probe opens the catalogue read-write and so may checkpoint a stale `-wal` into it. Harmless in itself, and no data is lost either way, but a restore refused for a bad backup should not have touched the live catalogue at all.

### 4.10 `labels` and `photo_labels` tables

```sql
CREATE TABLE labels (
  id              TEXT PRIMARY KEY,
  library_id      TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,  -- one line, at most 20 characters
  colour          TEXT NOT NULL,  -- '#rrggbb'
  position        INTEGER NOT NULL,
  stamp           TEXT,
  stamp_position  TEXT
);
CREATE INDEX idx_labels_library ON labels(library_id);

CREATE TABLE photo_labels (
  library_id  TEXT NOT NULL,
  label_id    TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  photo_id    TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  stamp       TEXT,
  PRIMARY KEY (library_id, label_id, photo_id)
);
CREATE INDEX idx_photo_labels_photo ON photo_labels(photo_id, label_id);
```

A library's free-form tags, in the order the reader arranged them, and which photos carry each.

- **Per library, not global like an album**, so they replicate with the library (docs/replication.md §3.2). A label applies only to photos of its own library, which the write enforces.
- **No unique index on `name`.** Two devices naming a label the same while apart is a state neither can refuse, and a unique index would defer the second row on every session for good. `LabelsService` refuses a duplicate, ignoring case, where it is made, and the ones replication brings together merge when the session closes (docs/replication.md §5.2.1).
- `position` ties are broken by `id`, since two devices each appending a label while apart both take the same position.
- A listing filters by labels as scope (`photo_query.ts`): a photo must carry **every** label asked for, and `match: 'any'` does not reach them.

---

## 5. Schemas (Zod)

`src/schemas/` defines Zod request, response and domain shapes, shared by API
validation and service return types.

### 5.1 `common.ts`

```typescript
import { z } from 'zod';

export const OrderingSchema = z.enum(['taken_asc', 'taken_desc', 'added_asc', 'added_desc']);
export type Ordering = z.infer<typeof OrderingSchema>;
// For `taken_*` orderings, photos with a NULL `date_taken` always sort last
// (SQL `ORDER BY date_taken IS NULL, date_taken <dir>`), regardless of direction.

export const PaginationSchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type Pagination = z.infer<typeof PaginationSchema>;

export const IdSchema = z.string().regex(/^[0-9a-z]{8}$/);

// Every list endpoint accepts this filter. Default excludes soft-deleted rows.
// NB: use z.stringbool(), NOT z.coerce.boolean(), the latter runs Boolean("false")
// which is true, so ?include_deleted=false would wrongly parse as true.
export const SoftDeleteFilterSchema = z.object({
  include_deleted: z.stringbool().default(false),
});
export type SoftDeleteFilter = z.infer<typeof SoftDeleteFilterSchema>;

export const PhotoIdListSchema = z.object({
  photo_ids: z.array(IdSchema).min(1).max(1000), // max bounds per-request file moves and keeps IN(...) under SQLite's variable limit
});
```

### 5.2 `libraries.ts`

```typescript
export const CreateLibraryRequestSchema = z.object({
  root_path: z.string().min(1),
  name: z.string().trim().optional(), // blank: store the inferred folder name (§4.1)
  ordering: OrderingSchema.default('taken_asc'),
  include_subfolders: z.boolean().default(true), // §4.1
  include_non_raw: z.boolean().default(false), // §7
  read_only: z.boolean().default(false), // §4.1; forces bin_name to null
  bin_name: BinNameSchema.nullable().default('Bin'), // one folder name, not a path (§12.3)
});

export const LibrarySchema = z.object({
  id: IdSchema,
  root_path: z.string(),
  bin_name: z.string().nullable(), // null = no bin folder (§4.1)
  read_only: z.boolean(),
  name: z.string().min(1),
  ordering: OrderingSchema,
  rendition_source: RenditionSourceSchema,
  rendition_hdr: z.boolean(),
  render_skip_full: OptionalStagesSchema, // stages left out of each render (§10.1)
  render_skip_max: OptionalStagesSchema,
  include_subfolders: z.boolean(),
  include_non_raw: z.boolean(),
  last_synced_at: z.string().nullable(),
  photo_count: z.number().int(),
});

// Every field optional: the settings UI changes one control at a time, and a
// partial update must not reset the others to their defaults.
export const UpdateLibraryRequestSchema = LibrarySchema.pick({
  ordering: true,
  rendition_source: true,
  rendition_hdr: true,
  render_skip_full: true,
  render_skip_max: true,
  include_subfolders: true,
  include_non_raw: true,
})
  .extend({ name: z.string().trim().min(1) })
  .partial();

export const FolderRuleSchema = z.object({
  // §4.7
  folder_path: z.string(),
  rule: z.enum(['excluded', 'plain']),
});

export const LibraryScanStatusSchema = z.object({
  library_id: IdSchema,
  status: z.enum(['idle', 'processing', 'rendition']),
  photos_to_scan: z.number().int(),
  photos_scanned: z.number().int(),
  photos_added: z.number().int(),
  photos_removed: z.number().int(),
  photos_moved: z.number().int(),
  photos_modified: z.number().int(),
  photos_processing: z.number().int(),
  photos_processed: z.number().int(),
  photos_per_second: z.number().nullable(),
});
```

### 5.3 `photos.ts`

```typescript
export const PhotoSummarySchema = z.object({
  id: IdSchema,
  library_id: IdSchema,
  shoot_id: IdSchema.nullable(),
  width: z.number().int().positive(), // display/upright dims, match the served rendition
  height: z.number().int().positive(),
  ordering_date: z.string().nullable(), // ISO datetime, resolved based on library/shoot/album ordering; NULL for a taken_* ordering when date_taken is NULL (sorts last, §5.1)
  triage: TriageSchema,
  rating: z.number().int().min(0).max(5),
  is_missing: z.boolean(),
  is_deleted: z.boolean(),
});

export const PhotoDetailSchema = PhotoSummarySchema.extend({
  recipe: StoredRecipeSchema, // what this row's pixels come from (§4.2.1); `file_path` on the summary is its single input, null for a composite
  file_hash: z.string().nullable(),
  orientation: z.number().int(), // EXIF orientation, 1 to 8; informational only, renditions are already upright (§11), do NOT rotate them by this
  date_taken: z.string().nullable(),
  date_added: z.string(),
  date_updated: z.string().nullable(),
  tile_built_at: z.string().nullable(),
  renditions_built_at: z.string().nullable(),
  needs_tile: z.boolean(),
  needs_renditions: z.boolean(),
  processing_error: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  iso: z.number().nullable(),
  shutter_speed: z.number().nullable(),
  aperture: z.number().nullable(),
  focal_length: z.number().nullable(),
  camera_make: z.string().nullable(),
  camera_model: z.string().nullable(),
  lens_model: z.string().nullable(),
  notes: z.string().nullable(),
});

export const PhotoListResponseSchema = z.object({
  photos: z.array(PhotoSummarySchema),
  total: z.number().int(),
  offset: z.number().int(),
  limit: z.number().int(),
  ordering: OrderingSchema, // the ordering this page was built in (§18.3.1)
});

export const UpdatePhotoRequestSchema = z.object({
  rating: z.number().int().min(0).max(5).optional(),
  triage: TriageSchema.optional(),
  notes: z.string().optional(),
});

// Query params for photo listing. All booleans use z.stringbool() (not
// z.coerce.boolean()) so ?is_missing=false parses as false, not true.
export const PhotoListQuerySchema = PaginationSchema.extend(SoftDeleteFilterSchema.shape) // include_deleted
  .extend({
    is_missing: z.stringbool().optional(),
    needs_tile: z.stringbool().optional(),
  });

// What a bulk action applies to. The same filters as a list query, in JSON
// rather than in a query string, plus runs of positions in the collection they
// describe (§18.3.3). No ordering: the collection owns that (§18.3.1).
export const PhotoSelectionSchema = z.object({
  scope: z.discriminatedUnion('kind', [/* library | shoot | album */]),
  filters: PhotoFiltersSchema.default({}),
  ranges: z
    .array(z.object({ start: z.number().int().min(0), end: z.number().int().min(0) }))
    .min(1)
    .max(10_000),
});

export const PhotoTargetSchema = z.union([
  PhotoIdListSchema,
  z.object({ selection: PhotoSelectionSchema }),
]);
```

### 5.4 `shoots.ts`

```typescript
export const CreateShootRequestSchema = z.object({
  library_id: IdSchema,
  parent_path: z.string().default(''), // root-relative folder the shoot's folder goes in; '' is the library root
  name: z.string().min(1),
  description: z.string().optional(),
  ordering: OrderingSchema.default('taken_desc'),
});

export const UpdateShootRequestSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  ordering: OrderingSchema.optional(),
  banner_photo_id: IdSchema.nullable().optional(), // null clears the banner (§4.6)
});

export const ShootSchema = z.object({
  id: IdSchema,
  parent_id: IdSchema.nullable(),
  library_id: IdSchema,
  folder_path: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  banner_photo_id: IdSchema.nullable(),
  ordering: OrderingSchema,
});

// What becomes of the photographs, asked rather than assumed (§8.5). The
// reversible answer is the default: 'remove' takes rows and renditions with it.
export const DeleteShootQuerySchema = z.object({
  photos: z.enum(['keep', 'remove']).default('keep'),
});
```

`folder_ino` / `folder_birthtime` (§4.3) are not in the response: they are how the server recognises a folder through a rename, and mean nothing to a client.

### 5.5 `albums.ts`

```typescript
export const CreateAlbumRequestSchema = z.object({
  name: z.string().min(1),
  ordering: OrderingSchema.default('taken_desc'),
});

export const UpdateAlbumRequestSchema = z.object({
  name: z.string().min(1).optional(),
  ordering: OrderingSchema.optional(),
  banner_photo_id: IdSchema.nullable().optional(), // null clears the banner (§4.6)
});

export const AlbumSchema = z.object({
  id: IdSchema,
  name: z.string(),
  ordering: OrderingSchema,
  banner_photo_id: IdSchema.nullable(),
});
```

---

## 6. Library Data Directory

Generated files live **outside all library roots**, under `DATA_DIR` (§15) keyed
by library id. This permits read-only libraries
(`docs/superpowers/specs/2026-08-06-readonly-library-design.md` §3) and one bulk-storage mount.

**Everything under it is disposable, and nothing under it is an original.** Removing a library removes its whole subtree (§10.6), and a user is free to delete it by hand to reclaim the space; both must cost only renders. That is why the Bin lives at the library root rather than in here (§12.3), why a `root_path` inside `DATA_DIR` (and a `DATA_DIR` inside a root) is refused in both directions at creation _and_ at startup - `DATA_DIR` is an environment variable, so a catalogue that was valid yesterday can be started against one that now swallows a root - and why the removal itself refuses to run while any RAW is still inside.

`DATA_DIR` is created and tested for writability at startup, before the database is opened; each library's subtree and every rendition directory in it are created when the library is, so a library that has built nothing yet still has somewhere for the orphan sweep to look. The processing worker creates its own outputs' parents before every job regardless (`ensureOutputDirs`), because a rendition added later would otherwise have to be remembered in two places.

### Structure

```
<DATA_DIR>/
├── render_timings.json       # What a render costs on this machine, stage by stage (§10.1)
└── <library id>/
    └── renditions/           # Derived copies of a photo (§10.1)
        ├── grid/             # 800px AVIF, the library grid; always SDR
        ├── full/             # 3840px AVIF, the photo view
        ├── full-hdr/         # the same, PQ
        ├── max/              # native-resolution AVIF (§10.5)
        └── max-hdr/
            └── <photo id>.avif   # every rendition is named by photo id
```

The timings file is the one thing in here that is not a library's: it describes this machine, so it
sits beside the subtrees rather than inside one.

### Path Resolution

```typescript
function getDataPath(library: Library): string {
  return path.join(config.dataDir, library.id);
}

// Originals, so outside the data directory (§12.3). One bin at the library root,
// laid out inside itself like the library around it: `relFolder` is the folder a
// photo was binned from, empty for one binned from the root. The only place the
// bin's name is spelled, so a second spelling cannot disagree with the scan.
// Null for a library with no bin (§4.1), which every caller has a branch for:
// the watcher has nothing to ignore, `delete` bins in place, and the bin channel
// has no root to walk.
function getBinPath(library: Library, relFolder = ''): string | null {
  return library.bin_name == null
    ? null
    : path.join(library.root_path, library.bin_name, relFolder);
}
```

### Sync Exclusion

The data directory needs no rule of its own: it is not under the root. A `<root>/.bowerbird` left by the layout that predates this is skipped by the hidden-directory rule and by nothing else, and is abandoned rather than swept - the sweep can no longer reach it.

Four shared `isInScope` rules (§9.1) govern scan and watcher: hidden directories,
bin (§12.3), `include_subfolders` (§4.1) and `excluded` folders (§4.7). Duplicated
rules would silently queue syncs for excluded paths.
