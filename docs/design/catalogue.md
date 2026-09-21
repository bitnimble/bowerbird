# Bowerbird design: The catalogue

A chapter of [`DESIGN.md`](../../DESIGN.md). The chapters are numbered as one document, so
`DESIGN §N` anywhere in the repo, and a `§N` cited here that is not below, both mean the
section the index in `DESIGN.md` maps §N to.

---

## 4. Database Schema

All `datetime` columns are stored as TEXT in ISO 8601 format with a `Z` suffix (e.g. `2024-06-15T04:30:00.000Z`), so lexicographic (byte) comparison equals chronological order and the `date_added`/`date_taken` ordering indexes (§4.2) sort correctly. `date_added` is a true instant, normalized to UTC from the server's offset (which shifts across DST). `date_taken` is not an instant: EXIF records a naive wall clock, so §11.1 stores that wall clock re-encoded as UTC and the client formats it back in UTC (`captureDateTime`), leaving a capture time reading as the camera wrote it on any machine in any zone.

All entity IDs are stored as TEXT (§3).

Foreign keys are enforced. Enforcement is a decision each connection makes rather than a property of the file, so `connection.ts` runs `PRAGMA foreign_keys = ON` on every one. The schema is acyclic (no table pair references each other) so migrations can be created in dependency order.

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
- `include_subfolders`, whether the scan descends past the root at all (§9.1). A standing rule rather than a decision taken once at import: a folder created next month is out of scope for the same reason today's are, so turning it off writes no `folder_rules` rows and never needs revisiting. Off makes shoots meaningless for the library - a shoot *is* a subfolder, and its photos would never be scanned. Sync keeps shoots in step with the folders on disk (§9.4.1): every folder holding photos is a shoot, and the catalogue cannot disagree with the tree.
- `include_non_raw`, whether the finished formats are photographs here (§7). Off by default, and a standing rule like the one above it rather than an import-time choice: beside a folder of RAWs a JPEG is usually the camera's own copy of a frame the library already holds, and taking both makes every frame two rows. Turning it off makes the next scan stop finding them, so their rows go `is_missing` exactly as they would had the files been moved off the disk - the same thing `include_subfolders` does to a subfolder's, and not a delete: the rows stay until somebody removes them, and the files are never touched. Asked in the Add-library dialog as well as in Settings, because the import begins as the row lands (§9.8). It is replicated, unlike the rendition settings beside it: what the library *contains* is the same catalogue on every peer, where where its renditions come from is a statement about one machine's disk.
- `bin_name`, what this library's bin folder is called at its root (§12.3). Per library rather than a constant because the name is also what the live scan skips: a root that already keeps a folder called `Bin` has it adopted as the bin, and everything inside it imports as already-binned rather than as part of the collection (§12.3). The Add-library dialog warns against the folder listing it already has, so that is settled while the name is still being chosen. **NULL means the library has no bin at all**, which is what a library born read-only is: nothing on disk records a binning, so `is_deleted` is the only truth. Nullable rather than `''` because joining `''` onto the root gives the root, which would point the bin channel at the whole library.
- `read_only`, whether the app may write under `root_path` at all: an archive volume, a NAS export mounted read-only, or a collection the photographer would rather no software rearranged. Almost nothing the catalogue knows was ever about the files, so what this actually turns off is short - binning moves nothing (§12.1), and a shoot has to be a folder that already exists (§4.3). `read_only = 0` with a NULL `bin_name` never persists: clearing the flag needs a `bin_name` in the same request, and makes the folder. Detected, not guessed: `access(dir, W_OK)`, reported per listing by `GET /api/browse`, and a create that says the root is writable when it is not is refused with `READ_ONLY` rather than silently upgraded.
- `bin_dev` / `bin_ino` / `bin_birthtime`, the bin folder's identity, recorded when the folder is made. A photographer renaming `<root>/Bin` to `<root>/Rubbish` has done to the bin what §9.4.1 already handles for a shoot, and it is answered the same way. Deliberately not on the `Library` API type: they would leak into every response.

**`bin_name` is not create-only.** `PATCH` with one **renames the folder**, which is what the rule against renaming existed to avoid having to do: changing the setting alone would strand every already-binned RAW in a folder the scan then walks back in, and changing it together with the folder strands nothing. The `rename` runs first and outside the transaction, because a crash between it and the commit leaves disk at the new name with stale columns - which is exactly the state the bin channel repairs by identity (§9.1); committing first would leave the mirror image, and the repair would revert the name just set.

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

`photos.recipe` says how a row's pixels are arrived at, as a discriminated union (`schemas/recipes.ts`).
There is `file`, which names the one path a camera wrote, and two ways to compose other rows: `panorama`,
which joins frames pointing in different directions into one wider picture, and `assembly`, which joins
frames pointing at the *same* thing and takes each part of the result from whichever frame the reader liked
- a face that blinked in one, a car that drove through another. **The path is in here rather than in a
column beside it**, and that is the point of the shape: a row is not one file, it is a recipe over a list of
them, so every caller that wants a path is handed a list and has to say what it does with one.
`originalPathOf` is the only way to a row's own bytes and answers null for anything that is not exactly one
file; `soleInputOf` is the same answer without a library to join it onto.

A recipe this build cannot read - a peer on a later one composing in a way this does not know, or a third
composite kind neither of these is - is its own kind, `unreadable`, rather than a fall back to `file`: what
is true of such a row is that its picture cannot be built here, and reading it as a file would send every
caller to a path that resolves and holds nothing.

`photo_inputs` is that list unpacked, one row per file a recipe names, **maintained by triggers**
(`photoInputTriggers`) for the reason `replication_log` is - a recipe is written from an import, a rename, a
bin move and a merge, and an index the writer has to remember is one that drifts. It answers in both
directions: the folder ranges and path lookups a scan does, and the reverse edge that matters more, which is
that a file changing on disk makes every row composed from it stale. The scan reads it as `photos JOIN
photo_inputs`, so a file two rows name is diffed once per row and the change reaches both. Derived, and so
replicated by nothing.

`photo_sources` is the other half of that graph, written by the same triggers: one row per *photograph* a
recipe composes, which is what a `panorama` or an `assembly` names. It answers which rows a listing must
hide because a composite stands for them, and the reverse - which composite a photograph is a frame of.
Only `composed_id` is a foreign key: replication carries rows in stamp order rather than dependency order,
so a composite can reach a peer before its frames do, and requiring them to exist would reject it outright.

**A kind this build does not recognise is never read as a shape it does recognise, and that has to hold for
replication too.** Whether a row's own bytes might be missing (`isComposite`, `apply.ts`'s `composed()`) and
whether a peer's row indexes any frames at all both answer *"is this not a `file`"* rather than naming
`panorama` or `assembly` outright - a photograph that composes others has none of its own bytes to lose,
which is as true of a kind this build has never heard of as of one it has. `photoInputTriggers`' own
allowlist is the one place that keeps a name list rather than a shape check, and it is tested for it: every
kind in the recipe union except `file` has to appear there, or a peer's crafted row can claim a photograph as
a frame no live composite actually holds.

**A composite is a photograph** (§19.4). As a row of its own it is one listing entry, its copies are keyed
by its own id, the queue rebuilds it like anything else, the bin takes it, and replication carries it as
`photo.placement`. Its `width`/`height` are the canvas already framed to what its frames cover - the
*union* of them for a panorama, so the frame is as wide as anything any source saw; the *intersection* for
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

- `folder_path` is the **full** path from the library root to this shoot's folder (forward slashes), e.g. `Weddings/2024/Smith`. It is *not* parent-relative: storing the full path lets sync reconciliation (§9.4) and create-adoption (§8.5) test membership with a prefix check on a photograph's input paths (§4.2.1), and lets the most-specific (longest matching) shoot win for nested folders. On create it is the requested `parent_path` plus the name, and `parent_id` is then read back off it (§8.5) rather than chosen alongside it. Nothing *in the app* rewrites it afterwards: `name` seeds the folder once and is a label from then on, so renaming a shoot never moves a file (§8.5). It does follow the folder when the folder itself moves **on disk**, which is the one writer (§9.5).
- **Membership test (used everywhere "a file falls under a shoot" is checked):** a file belongs to a shoot iff its path starts with `folder_path + '/'`; a *photograph* belongs iff **every** file it is composed from does, which for almost all of them is the one it is (`INPUTS_ALL_UNDER`, §4.2.1); the trailing separator is required so shoot `NYC` (`folder_path` `NYC`) does not capture files in sibling shoot `NYC2`. "Directly under" a shoot means the remainder after that prefix contains no further `/` (deeper files belong to a descendant shoot). Among all matching shoots, the one with the longest `folder_path` wins.
- When a photo is added to a shoot, its file is physically moved on disk into the shoot's folder.
- **A shoot is identified by its folder, not by its name** (`UNIQUE (library_id, folder_path)`). The folder is the thing that exists; the name is a label on it. Names were once unique library-wide, which mirroring (§9.5) makes simply false to disk: a tree with `NYC/Day1` and `LA/Day1` is ordinary, and a constraint that rejects it would have the catalogue refusing to describe folders the user already has. Uniqueness on `folder_path` is also *tighter* against the collision the old constraint was defending, two shoots sharing one folder, since that is the collision stated directly rather than inferred from names. Renaming a shoot therefore never conflicts.
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

Both shoots and albums can designate a banner photo. A `banner_photo_id` column *on the shoots table* would create a `photos` ↔ `shoots` FK cycle (photos reference their shoot, the shoot references its banner photo). Instead, each banner association lives in its own join table that references the owner and the photo. This keeps full FK integrity on both sides while leaving the FK graph acyclic (nothing points back into `shoots` from `photos`' direction).

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

The exceptions to what the two library settings (§4.1) say in general. Both are the user overruling a default about one folder, so they are one table with one primary key rather than two lists that could disagree about the same path.

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

The catalogue is the only copy of everything about the photographs that is not in the photographs: ratings, notes, verdicts, album membership, shoot assignments and stacks. A rescan brings back the files and none of that, so the database is backed up on a schedule of its own (`backup_every_days`, `backup_keep`, §15); daily, seven kept, both editable and `0` days turning it off. The margin gets thinner as edit state moves into the catalogue with no sidecar file on disk to fall back on, which is what this was built ahead of.

**`VACUUM INTO`, not a file copy.** It reads a consistent snapshot inside a read transaction, so nothing has to be paused around it, and it writes one self-contained file; no `-wal` to be restored alongside it and no way to restore half a pair. The path is bound rather than interpolated.

**Atomic by construction.** `VACUUM INTO` refuses an existing destination, so each run writes a dot-prefixed working file and renames it into place only once it has been verified. Rename is atomic: nothing that has ever appeared under a real backup name is a partial file, and a partial backup that looks whole is worse than no backup at all. Whatever goes wrong, a refusal, a full disk partway through, a dead thread, the caller removes the working file, which is the size of the catalogue and which nothing else would ever come looking for. A kill leaves no chance to run that cleanup, so each run also sweeps working files left by earlier ones before it starts; rotation cannot see them, being dot-prefixed, and nothing else names them. Only ones an hour old or more, though: the process that owns a working file is holding it open and writing to it, and a live `VACUUM INTO` does not pause for an hour, so sweeping on sight would delete a *concurrent* run's output from under it - which two servers on one catalogue, or an overlapping restart, will do to each other.

**On a thread of its own** (`backup_worker.ts`). The driver is synchronous and the main thread owns all DB writes (§10.2), so vacuuming from the server's connection would hold the event loop for the whole copy; seconds, on a large catalogue, of a server that answers nothing. The worker opens its own read-only connection; a read transaction blocks no writer. A run still in flight when the next is due is skipped rather than stacked.

Two ways a thread can fail to answer, and both have to be handled, because either leaves the promise unsettled, the in-flight flag latched, and every later run returning at that guard - a schedule that has silently stopped while still looking exactly like one that works. A thread that **exits** without reporting is caught by its `close` event. A thread that is **alive but wedged** - inside `VACUUM INTO` or `statfs` on a hung mount, which `/config` can be - emits no event at all, so there is also a deadline. Six hours: not a performance bound, since a snapshot of a huge catalogue is allowed to take as long as it takes, but a ceiling on how long a wedge can pass for work.

Also on the "looks healthy" theme: a `readdir` that fails for any reason other than the directory not existing is raised rather than read as "no backups". Swallowing it would have the restore tool report an empty list during the one event this feature exists for. It is raised where the listing is actually needed, though - a restore given an explicit *path* never consults the directory, so a copy rescued from elsewhere is not refused because the backup directory happens to be unreadable.

**Verified before it counts.** The snapshot is reopened for `PRAGMA quick_check`, which is the only thing standing between a backup that was never readable and finding that out at restore time. The `user_version` comparison beside it is an invariant assertion rather than a check that can fail in practice - the expected value comes from the connection that just produced the file - and is kept because `VACUUM INTO` preserving `user_version` is the property the restore-side refusal rests on, so a SQLite that stopped doing it should be loud here rather than at a restore.

Free space is checked against the *backup* directory, which can be a different volume from the database's and in the shipped container is. It is checked against **the larger of the main file and its `-wal`**, half again. Committed work sits in the WAL until a checkpoint moves it, and a long-lived reader - which this backup is - stops checkpoints advancing: measured, a 220KB main file beside a 56MB WAL vacuumed to 46MB, 200x what the main file alone suggested, so sizing on `stat(dbPath).size` was a guard that passes and then fills the disk. Their *sum* is the other error - a checkpoint-starved WAL is mostly rewrites of pages already in the main file, so 15.7MB beside 15.7MB still vacuums to 15.7MB, and demanding 47MB would refuse backups that had room.

**The WAL it inflates is bounded by `journal_size_limit`, not by a checkpoint.** A checkpoint rewinds the WAL to be overwritten from the start rather than shrinking it, so the file keeps the high-water mark of the worst burst the database has ever seen, for the life of that database. Under ordinary load that mark is just the autocheckpoint threshold: measured, 40MB written in small commits holds the WAL at 4.0MB, however long it goes on. What overshoots it is a long-lived *reader*, which pins the snapshot a checkpoint would have to move past; and this backup's read transaction is exactly one. With a reader held open across that same 40MB the WAL grows to somewhere between 49MB and 470MB and stays there, because every version of every page touched has to be kept while somebody may still read the old one. The spread is the point: the multiplier is set by commit *shape*, not by bytes written - measured 1.2x at 64KiB values per commit, 2.7x at 8KiB, 11.8x at 1KiB - so no single number characterises it and the bound cannot be reasoned about from write volume.

So `connection.ts` sets `journal_size_limit` to 16MB, four times the autocheckpoint threshold: clear of anything normal operation reaches, low enough to reclaim a blowup like that. The alternative, a periodic `wal_checkpoint(TRUNCATE)` when the server looks idle, needs idle detection to be safe, because TRUNCATE waits out every reader and takes the write lock. The limit needs none: it is applied at the next WAL reset, so the space comes back once writing resumes and wraps, with nothing blocking.

**Due by the age of the newest snapshot, not by a timer's own interval.** The orphan sweep can wait for its interval to come round, because a restart is not evidence that anything was orphaned. A backup cannot: a timer alone means a laptop shut each night, or a server restarted more often than the interval, reaches its first backup never. So an hourly check asks whether one is *due* - by the newest snapshot's age against `backup_every_days` - which also keeps a development reload from taking one every time.

A snapshot is dated by **the stamp in its own name**, read from the *end* of that name, not by its mtime. Anchoring matters: matching the stamp's shape anywhere takes the leftmost hit, so a catalogue whose own filename carries a stamp-shaped run - `<db>.pre-restore-<stamp>`, which this section's own restore writes, and a plausible thing to point `DB_PATH` at - would date every one of its snapshots to that fixed instant, leaving the schedule overdue on every check. The name is what this app wrote down when it took the snapshot, and it survives being copied, unzipped, downloaded or rsync'd without `-t` - every one of which rewrites mtimes, and every one of which is how a backup reaches the machine that has to restore it. Dating by mtime made `latest` hand back the *oldest* snapshot in a directory carried off a dead machine, which is the disaster-recovery path itself.

A snapshot dated in the *future* is **ignored** for that question, rather than trusted or treated as due. Both alternatives are wrong and the second is worse. A clock that was ahead - a VM before NTP settles, a fileserver whose clock leads this one's - writes a snapshot whose name *and* mtime are both ahead, since both come from that clock. Trusted, it stalls backups for the length of the skew. Read as due, it stays newest by name for ever, so every hourly check finds itself due again: measured, a week of daily history rotated away in eight hourly ticks, every run logging a successful backup. Ignoring it does neither, because the snapshot taken now is datable and answers the question next time. For the same reason `latest` picks by date rather than by name, or `bun run restore latest` would hand back the oldest catalogue in the directory and report success.

That the check is hourly and fixed is not a detail: `setInterval` clamps a delay past its signed 32-bit range to 1ms, so scheduling on the interval directly would fire continuously from 25 days up. `backup_every_days: 30` would then rotate a week of history down to a few seconds of it, which is the exact opposite of what setting it asks for. Reading the interval instead of sleeping it removes the failure mode rather than bounding it. (`ScheduledPrune` still schedules on the interval directly and so still has the wrap; there the consequence is only wasted I/O, and it has no record of its last run to date itself against.)

**Beside the database, in `backups/`.** Deliberately *not* under `DATA_DIR`, which is where everything else this app generates lives: that directory is disposable by design (§6) - removing a library takes its subtree, and a user is free to delete the lot by hand to reclaim space, both of which must cost only renders. A backup is the one generated file for which that is false, so it belongs beside the thing it is a copy of. In the container that is the difference between the `/config` volume and the `/data` one.

Rotation keeps the newest `backup_keep` and deletes the rest. Names carry an ISO stamp, so the directory sorts chronologically and dating a snapshot needs no `stat` at all, and they are built from the database's **whole filename** matched against the stamp's shape - not from its stem against a prefix. Both halves are load-bearing for catalogues sharing a directory: on a stem, `photos.db` and `photos.sqlite` collide on one name outright; on a prefix, `photos.db` claims `photos-archive.db`'s snapshots, and since a letter sorts after a digit those are the *newest*, so rotation would delete every snapshot of the catalogue it was protecting and keep only the neighbour's.

Three things rotation will not do, each of them a way to end up with no history at all:

- **Delete on a retention below 1.** Refused rather than read as "keep none".
- **Delete the snapshot just taken**, whatever it sorts as. A clock stepped backwards gives it an older name than the history it joins, and which backup this run just made is not a question to leave to the wall clock.
- **Make a bogus date immortal.** Deletion is ordered oldest-first by *claimed age*, with an unreadable or future date counting as oldest rather than newest. Ordering by name instead leaves a future-stamped snapshot at the end of the list for ever, so rotation never reaches it while it still counts against `keep`: measured, seven of them collapse `backup_keep: 7` to "one snapshot, at most one interval old", with every run reporting a successful backup and a rotation.
**A catalogue that has gone missing is refused at startup, not worked around in rotation** (`connection.ts`). "Missing" counts an *empty database* as none: SQLite reads a zero-byte file as one, and the placeholder a killed restore leaves behind to hold its lock is a valid 4096-byte one, so neither `existsSync` nor a size test sees the hazard - the next start builds the schema into it and calls it a catalogue. Unreadable or locked counts as present, since something that cannot be opened is not something to refuse over. Opening creates, which is right for a first run and dangerous for every run after it: anything leaving `DB_PATH` absent - a volume that failed to mount, a restore killed between its renames, a path edited by one character - otherwise produces a silent empty replacement that the app is perfectly happy with. Everything downstream of that is invisible: the user sees an empty library and re-adds their folder, a rescan writes into the replacement, and the rolling backup starts snapshotting *it*, rotating the real catalogue's history away within `backup_keep` runs. So a missing catalogue with snapshots sitting beside it is a refusal to start, naming `bun run restore latest`.

This one is worth stating as a lesson rather than a rule. It was first caught *in rotation*, and so was first patched there - refusing to rotate on a snapshot with no libraries and smaller than the history it would displace. That guard was defeated by the very next thing a user does, which is re-add their library: one library, guard off, history gone. It also could not tell an empty catalogue from a small real one, both vacuuming to exactly 225280 bytes. Fixing it where it was noticed instead of where it was caused cost two rounds and a `libraries` count plumbed from the worker through the outcome type into rotation, all of which the startup check deleted.

Rotation runs after the snapshot is safely in place and its failure is never the backup's: a snapshot that exists must not be reported as a failed backup because some *older* file would not delete. That goes to the log as its own line.

**Restore is offline** (`scripts/restore-backup.ts`, `bun run restore`), because the running server holds the file it replaces:

```bash
bun run restore                # list what there is
bun run restore latest         # or a name exactly as that listing prints it
```

`scripts/restore-backup.ts` is copied into the runtime image for this reason alone. Left out, the only supported deployment is the one deployment that cannot restore its own backups - and the backups are on a named volume inside that image's world, so the discovery happens during the outage that needs them.

#### Restoring by hand, and the one trap in it

A snapshot is a plain self-contained SQLite file, so stopping the server and copying one into place obviously works, and people will do it that way. It does work - **as long as the sidecars go too**:

```bash
docker compose stop bowerbird
rm bowerbird.db bowerbird.db-wal bowerbird.db-shm      # all three
cp backups/bowerbird.db-<stamp>.db bowerbird.db
docker compose start bowerbird
```

Deleting only the `.db` restores the wrong catalogue. Measured, with a killed server's 12KB `-wal` left beside a deleted 225KB catalogue: after copying the snapshot in, the server reads back **both** the snapshot's contents and the dead server's. The WAL header carries a magic number, a page size, a checkpoint sequence, two salts and two checksums - and **nothing identifying a database** - so SQLite cannot tell that WAL belongs to a different file and simply replays it over whatever it is found beside. Read-only opens replay it too, so nothing about how it is opened avoids this. The result opens, passes `quick_check`, is the right size, and is a mix of two catalogues.

**This is now caught rather than silent.** SQLite offers no way to bind a WAL to a database, but the *pairing* is checkable: `VACUUM INTO` writes a rollback-journal file - every snapshot this app takes has read-version 1 in its header, where a live catalogue has 2 - and a database that has never been in WAL mode has never legitimately had a `-wal`. So a rollback-mode header beside a non-empty `-wal` means the two came from different databases, which is exactly the shape of this mistake. `createDatabase` refuses to start on it and names the two files to delete. It cannot false-positive: SQLite removes the `-wal` when a database leaves WAL mode, so the combination never arises legitimately.

The refusal is a backstop, not a licence - it catches this particular pairing, not every way a hand-rolled restore can go wrong, and the tool remains the path that handles the sidecars for you.

**Why not mark the snapshot instead**, giving it a distinct schema - renamed tables, an `application_id` - and recognising it after opening? Because the marker does not survive the thing it is meant to detect. Replay is at the *page* level and page 1 is the schema page, so the stale WAL overwrites the snapshot's schema along with everything else. Measured, with a marked snapshot copied in beside a 3.3MB stale WAL: the tables come back as the *old* catalogue's, 401 rows, marker gone, indistinguishable from an ordinary healthy catalogue. Anything written inside the file is destroyed by the event, so the check has to happen before SQLite opens the file at all - which is what confines it to reading bytes off disk. Auto-healing on detection is worse again: it would mean deleting a WAL whose contents belong to some other catalogue and may still be wanted, which is the move this whole section exists to prevent.

The check leans on `VACUUM INTO` emitting a rollback-journal file, which is observed rather than a documented guarantee. It fails *open* if that ever changes - no false refusals, just no protection - and the test asserting the refusal would go red, so it would not pass unnoticed.

What the tool does that a copy does not, worth knowing before choosing: it parks the old catalogue instead of deleting it, so a restore of the wrong snapshot is itself undoable; it runs `quick_check` and the version refusal *before* touching anything; and it refuses outright if the server is still running, which a copy will happily land underneath. Two things still protect a manual restore: the filename has to be right or the startup refusal fires (naming `bun run restore latest`), and the snapshot really is complete on its own, having no sidecars of its own to forget.

In the container the file is owned by uid 1000; a `cp` run as root on the host leaves a catalogue the server cannot write.

A bare name is resolved against the backup directory rather than the shell's working directory, since following the tool's own output would otherwise fail with "no such backup" - and **only** there. It is deliberately not offered to the filesystem as a fallback: `photos.db-<stamp>.db` typed while standing in the backup directory would then resolve against the cwd and restore a *different* catalogue's snapshot over this one, which nothing downstream can catch, the file being intact and at a schema this build understands. A path (anything containing a separator) is still taken as a path, which is how a copy kept elsewhere is restored.

The snapshot is put back with **`VACUUM INTO`, not a file copy** - the same reasoning as the backup side, and here it is load-bearing rather than tidy. A copy takes the main file alone, and a catalogue's committed work can be almost all of it in the `-wal`: measured, a 4KB main file beside a 1.8MB WAL holding all 300 rows, where the copy did not contain even the table. Both sources this is ever pointed at normally have a WAL beside them - a catalogue parked by an earlier restore, which keeps its sidecars by design, and a copy rescued from another machine - so copying would have made "undo the restore" and "restore from elsewhere" silently restore nothing.

It refuses a backup that is not there, one whose path is the catalogue itself, and the three below - and there is one thing it will not delete:

- **A catalogue another process still has open.** A restore while the server is up looks like it worked and throws away everything written afterwards: the server keeps writing through its open handle to the inode this moves aside, so its reads stay right, its shutdown is clean, and the work is discarded at the next start. `restart: unless-stopped` in the compose file means "stop the server first" cannot be left to a comment, so it is asked of the database directly, by taking an exclusive lock - exclusive *locking mode*, not just the write lock, because an idle server holds no write lock and is still a server. That also gets it right for a second container sharing the volume.

  **A missing catalogue gets a lock too.** With nothing at the path there is nothing to lock, and that is not a corner case: one of the two ways anyone arrives here is having deleted the catalogue that looked broken, and a host being restored onto may have no local backups either, so the startup refusal does not cover it. A server starting during the vacuum then creates its own catalogue at that path, takes writes into it, and has them discarded by the final rename - measured, 60 committed rows gone with both processes exiting 0 and nothing logged. So an empty file is put there purely to be locked, and is never parked as "the catalogue that was there".

  **The lock is held across the whole swap, not sampled at the start.** Everything after it - vacuuming the snapshot out, then the renames - takes as long as the catalogue is big: measured at 3.7s for 244MB, minutes on a slow volume. Releasing the lock after the check leaves that entire window open for a server to start in, and one that does writes through its handle to the inode about to be parked, so its reads stay right, its shutdown is clean, and the work is discarded at the next start with nothing reported anywhere. With `restart: unless-stopped` that window is a likely place for a server to appear, not a theoretical one.

  **Only a busy code counts**, matched as a prefix rather than exactly: bun reports SQLite's *extended* result codes, and a lock refusal can arrive as `SQLITE_BUSY_RECOVERY` - another process recovering this WAL after a crash, which under `restart: unless-stopped` is precisely the shape of "the server died and came back while I was restoring". Every other way that probe can fail - not a database, a trashed header, a read-only file or directory - says the catalogue is broken or unwritable, which is *precisely why somebody is restoring*. Refusing on those was measured to leave a user with a corrupt catalogue no way through at all: told to stop a server that was not running, with deleting their only catalogue by hand as the only remaining move. A guard that fires hardest in the emergency it exists for is worse than no guard.

- **A backup from a newer Bowerbird.** Restoring an *older* one is fine; the migrations run on the next start and bring it forward. The other direction is not: this build's migrations have no route to a schema they predate, and the failure would look like a corrupt catalogue rather than an error. The check is the newest migration the snapshot has had applied against the newest this build ships, both read from drizzle's journal. Every schema change is a migration and every migration is stamped, so unlike a counter somebody has to remember to bump, there is no way to move the schema without moving this.
- **A backup that does not pass `quick_check`.** A file that is not a database at all throws out of the open rather than returning a verdict, so that is caught and surfaced as the same refusal instead of a stack trace. Every refusal happens before anything on disk moves.
- **The catalogue that was there.** It is renamed aside to `<db>.pre-restore-<stamp>`, **with its `-wal`, `-shm` and `-journal`**. Moving the sidecars is half of what makes this correct: SQLite derives their names from the database's filename, so a live `-wal` left in place would replay the old catalogue's uncheckpointed pages over the restored file and quietly undo the restore. Taking them along also keeps the displaced catalogue openable, which is what makes a restore chosen in a panic itself undoable.

  **The sidecars move whether or not the catalogue itself is still there**, which is the case that actually happens: the likeliest route to a restore at all is that the catalogue looked broken, so somebody deleted it and put a backup back. Scoping the sidecar move to "only if the old file exists" makes precisely that path silently restore nothing - the `-wal` survives, the next start replays it, and the result passes `quick_check` at the right size with the old contents.

  `movedAside` is reported only when the catalogue itself was parked. A lone `-wal` moved out of the way is not something to point anyone at as "the catalogue that was there" - the path would hold no such file.

The snapshot is staged beside the catalogue and renamed in, rather than written over it: writing is not atomic, so a full disk partway through would otherwise leave a truncated file where the catalogue used to be, after the real one had already been moved away. **If any step after the first rename fails, the moves are put back**, because the alternative is a path with no catalogue at all and a real one parked under a name nothing has been told. The startup refusal above is the backstop for that state rather than the fix for it: better still not to create it. And if a move back *also* fails, the error says so and names where the files actually are, since "the restore was undone" when it was not is worse than the original failure.

Also swept here: a `<db>.restoring-<stamp>` left by a restore killed between its vacuum and its rename, which is catalogue-sized and which nothing else names - the same litter the backup side already sweeps for itself, and on the same age rule, so a second restore started by an impatient user does not delete the first's staging file out from under it.

A **symlinked `DB_PATH` is resolved first** - a chain of them, up to a bounded number of hops, since unwrapping only the first link writes the restored catalogue into the middle of the chain and leaves the real one live and orphaned - by `lstat` rather than by asking whether the path exists. A symlink there is a deliberate placement - the catalogue on the big volume, the link on the small one - and writing the restored file at the link's own path silently relocates the catalogue and orphans the real one where nothing will look again. Testing existence instead follows the link, so a **dangling** one reads as "no catalogue here" and gets exactly that treatment - and dangling is not the rare case, it is the volume that failed to mount and the catalogue somebody deleted, which are two of the three reasons anyone is here.

The refusals are ordered so the backup is validated **before** the in-use probe, because that probe opens the catalogue read-write and so may checkpoint a stale `-wal` into it. Harmless in itself, and no data is lost either way, but a restore refused for a bad backup should not have touched the live catalogue at all.

---

## 5. Schemas (Zod)

All Zod schemas live under `src/schemas/`. They define the shape of request bodies, response bodies, and the domain entities themselves. They are imported by both API handlers (for request validation) and services (for return type safety).

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
  photo_ids: z.array(IdSchema).min(1).max(1000),  // max bounds per-request file moves and keeps IN(...) under SQLite's variable limit
});
```

### 5.2 `libraries.ts`

```typescript
export const CreateLibraryRequestSchema = z.object({
  root_path: z.string().min(1),
  name: z.string().trim().optional(),          // blank: store the inferred folder name (§4.1)
  ordering: OrderingSchema.default('taken_asc'),
  include_subfolders: z.boolean().default(true),  // §4.1
  include_non_raw: z.boolean().default(false),    // §7
  read_only: z.boolean().default(false),       // §4.1; forces bin_name to null
  bin_name: BinNameSchema.nullable().default('Bin'),  // one folder name, not a path (§12.3)
});

export const LibrarySchema = z.object({
  id: IdSchema,
  root_path: z.string(),
  bin_name: z.string().nullable(),             // null = no bin folder (§4.1)
  read_only: z.boolean(),
  name: z.string().min(1),
  ordering: OrderingSchema,
  rendition_source: RenditionSourceSchema,
  rendition_hdr: z.boolean(),
  render_skip_full: OptionalStagesSchema,      // stages left out of each render (§10.1)
  render_skip_max: OptionalStagesSchema,
  include_subfolders: z.boolean(),
  include_non_raw: z.boolean(),
  last_synced_at: z.string().nullable(),
  photo_count: z.number().int(),
});

// Every field optional: the settings UI changes one control at a time, and a
// partial update must not reset the others to their defaults.
export const UpdateLibraryRequestSchema = LibrarySchema
  .pick({ ordering: true, rendition_source: true, rendition_hdr: true,
          render_skip_full: true, render_skip_max: true,
          include_subfolders: true, include_non_raw: true })
  .extend({ name: z.string().trim().min(1) })
  .partial();

export const FolderRuleSchema = z.object({           // §4.7
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
  width: z.number().int().positive(),   // display/upright dims, match the served rendition
  height: z.number().int().positive(),
  ordering_date: z.string().nullable(),  // ISO datetime, resolved based on library/shoot/album ordering; NULL for a taken_* ordering when date_taken is NULL (sorts last, §5.1)
  triage: TriageSchema,
  rating: z.number().int().min(0).max(5),
  is_missing: z.boolean(),
  is_deleted: z.boolean(),
});

export const PhotoDetailSchema = PhotoSummarySchema.extend({
  recipe: StoredRecipeSchema,  // what this row's pixels come from (§4.2.1); `file_path` on the summary is its single input, null for a composite
  file_hash: z.string().nullable(),
  orientation: z.number().int(),  // EXIF orientation, 1 to 8; informational only, renditions are already upright (§11), do NOT rotate them by this
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
export const PhotoListQuerySchema = PaginationSchema
  .extend(SoftDeleteFilterSchema.shape)  // include_deleted
  .extend({
    is_missing: z.stringbool().optional(),
    needs_tile: z.stringbool().optional(),
  });

// What a bulk action applies to. The same filters as a list query, in JSON
// rather than in a query string, plus runs of positions in the collection they
// describe (§18.3.3). No ordering: the collection owns that (§18.3.1).
export const PhotoSelectionSchema = z.object({
  scope: z.discriminatedUnion('kind', [ /* library | shoot | album */ ]),
  filters: PhotoFiltersSchema.default({}),
  ranges: z.array(z.object({ start: z.number().int().min(0), end: z.number().int().min(0) })).min(1).max(10_000),
});

export const PhotoTargetSchema = z.union([PhotoIdListSchema, z.object({ selection: PhotoSelectionSchema })]);
```

### 5.4 `shoots.ts`

```typescript
export const CreateShootRequestSchema = z.object({
  library_id: IdSchema,
  parent_path: z.string().default(''),  // root-relative folder the shoot's folder goes in; '' is the library root
  name: z.string().min(1),
  description: z.string().optional(),
  ordering: OrderingSchema.default('taken_desc'),
});

export const UpdateShootRequestSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  ordering: OrderingSchema.optional(),
  banner_photo_id: IdSchema.nullable().optional(),  // null clears the banner (§4.6)
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
  banner_photo_id: IdSchema.nullable().optional(),  // null clears the banner (§4.6)
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

Generated files live **outside every library root**, under `DATA_DIR` (§15), one subdirectory per library keyed by its id. Nothing the app generates is written among the photographs, which is what lets a library be read-only (`docs/superpowers/specs/2026-08-06-readonly-library-design.md` §3) and what makes bulk storage a mount rather than a per-library setting.

**Everything under it is disposable, and nothing under it is an original.** Removing a library removes its whole subtree (§10.6), and a user is free to delete it by hand to reclaim the space; both must cost only renders. That is why the Bin lives at the library root rather than in here (§12.3), why a `root_path` inside `DATA_DIR` (and a `DATA_DIR` inside a root) is refused in both directions at creation *and* at startup - `DATA_DIR` is an environment variable, so a catalogue that was valid yesterday can be started against one that now swallows a root - and why the removal itself refuses to run while any RAW is still inside.

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
  return library.bin_name == null ? null : path.join(library.root_path, library.bin_name, relFolder);
}
```

### Sync Exclusion

The data directory needs no rule of its own: it is not under the root. A `<root>/.bowerbird` left by the layout that predates this is skipped by the hidden-directory rule and by nothing else, and is abandoned rather than swept - the sweep can no longer reach it.

This leaves four rules that together answer "is this path part of this library": hidden directories, the library's bin (§12.3), its `include_subfolders` setting (§4.1) and its `excluded` folders (§4.7). They live together in `isInScope` (§9.1) rather than being restated by each caller, because the scan and the watcher answering it differently is not a visible failure - it is a folder that quietly still wakes syncs, or a sync queued for paths the scan will discard.
