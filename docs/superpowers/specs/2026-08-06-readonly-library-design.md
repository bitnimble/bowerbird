# Read-Only Libraries, Design

Date: 2026-08-06

A **read-only library** is one Bowerbird never writes to: an archive volume, a NAS
export mounted read-only, or a collection the photographer would rather no software
rearranged.

Almost nothing the catalogue knows was ever about the files. Ratings, triage
verdicts, notes, albums, stacks, shoot labels and the renditions themselves are rows
and generated files. What genuinely needs to write is a much shorter list than the
code suggests, and most of it writes only because that is how it was built.

Binning is the example. A binned photograph is a RAW moved into `<root>/<bin_name>/`
and a row flagged `is_deleted`. The move is not what makes it binned - the flag is.
The move exists so the next scan does not re-import the file, and there is a cheaper
way to arrange that.

**A bare `§N` is a section of this document. The main design is cited as `DESIGN §N`.**

| term | meaning |
|---|---|
| **read-only** | the library's `read_only` flag is set: the app writes nothing under `root_path` |
| **the bin** | `<root_path>/<bin_name>`, for a library whose `bin_name` is not `NULL` |
| **binned** | `is_deleted = 1`, whatever the file's position on disk |
| **in-place binning** | binned with no move: `file_path` unchanged |
| **claimed** | a path some row's `file_path` names; **unclaimed** is the negation |
| **the live channel** | the existing walk and diff, over the library minus the bin, against `is_deleted = 0` rows |
| **the bin channel** | the same walk and diff, over the bin alone, against `is_deleted = 1` rows (§6) |
| **a crossing** | a move whose halves land in different channels: the file entered or left the bin |
| **followed** | a hand-renamed folder recognised by its recorded inode identity and adopted under its new name, rather than read as a deletion plus an addition |
| **the creation invariant** | a library with a `bin_name` has the folder and its recorded identity from creation (§2.3) |
| **scoped sync** | a watcher-driven sync restricted to named paths, as against the nightly full sync |

## 1. Scope

Read-only-specific: the `read_only` flag (§2); binning, restoring and undo with no
move on disk (§4); shoots restricted to existing folders (§7); the API, error and UI
surfaces of those (§10-§12).

Four changes are worth making for **every** library and are specified that way. Each
stands alone and each fixes something already wrong:

- **Generated files leave the library root** and `data_path` is deleted (§3).
- **The bin folder is created with the library, and `bin_name` stops being
  write-once** (§2.3, §2.4): renaming it moves the folder, which is what the rule
  against renaming existed to avoid having to do. Writable libraries only - a
  read-only library has no bin to rename (§15).
- **The bin gets its own scan channel** (§5, §6), so a binned file deleted, changed,
  moved or renamed by hand is noticed instead of ignored. This makes `is_missing`
  reachable on a binned row, which it is not today.
- **The sync lock becomes a leased row** (§8): it protects the catalogue rather than
  the tree, and its PID-based staleness check is wrong across containers.

**§8 should ship first and alone.** It shares no code with the rest, fixes a bug that
exists today, and is the one piece where being wrong corrupts the catalogue.

Out of scope: read-only *photographs* in a writable library, per-folder permissions,
export, and importing into a read-only library.

**Supersedes** (qualified, because several numbers collide with this document's):
DESIGN §4.1 (the `libraries` columns), DESIGN §6 (the data directory), DESIGN §9.1
(the scan, which gains a channel), DESIGN §9.7 (the sync lock, which stops being a
file), DESIGN §12.1 and DESIGN §12.3 (binning and the bin folder), DESIGN §13.1 (the
API surface), DESIGN §15 (configuration, which gains `DATA_DIR`) and DESIGN §16
(testing).

## 2. The flag

Five columns on `libraries` - two for the flag and the bin's name, three for the bin
folder's identity:

```sql
read_only      INTEGER NOT NULL DEFAULT 0   -- the app writes nothing under root_path
bin_name       TEXT                         -- nullable: NULL means this library has no bin
bin_dev        INTEGER                      -- the bin folder's identity, recorded when the folder is made
bin_ino        INTEGER
bin_birthtime  REAL
```

`bin_name` nullable rather than `''` because `path.join(root, '')` is `root`, which
would point the bin channel at the whole library. `string | null` also makes the
compiler find the `getBinPath` callers that must decide what a library with no bin
does (§2.5).

| `read_only` | `bin_name` | meaning |
|---|---|---|
| 0 | set | today's library |
| 1 | `NULL` | born read-only: nothing on disk can record a binning, so the flag is the only truth |
| 1 | set | flipped to read-only: an existing bin holds RAWs the app put there, still honoured |

`read_only = 0` with `bin_name IS NULL` never persists (§2.2).

The identity columns are **not** on `Library`/`LibrarySchema` - they would leak into
every API response. They are read and written through `getBinIdentity` /
`setBinIdentity` / `setBinName` on `LibrariesRepository`, mirroring
`shoots_repository.ts:126-150`.

### 2.1 Detecting a read-only root

**One mechanism, and it writes nothing:** `access(dir, W_OK)`. `GET /api/browse`
reports it as `writable` for the folder being listed - one boolean per listing, not
per child entry - and `POST /api/libraries` checks the root being added. The field is
optional on `BrowseResponse`, which is shared with `GET /api/libraries/:id/browse`
(`utils/browse.ts:13-38`).

Not a real write test, though `access` can be fooled by an exotic ACL: a root where
`access` lies is the same case as a volume remounted read-only later, and that
already surfaces as an `IO_ERROR` from the write that fails. Writing nothing here is
also what makes §14's byte-identical assertion unconditional rather than dependent on
which folders the dialog visited.

A library created with `read_only: false` over a root that fails the check is refused
with `READ_ONLY`, not silently upgraded: the client supplied a `bin_name` assuming
the root was writable. The check runs at creation and when the flag is cleared.

### 2.2 Changing the flag

`PATCH /api/libraries/:id` accepts `read_only`, both directions.

**Setting it** keeps `bin_name` and moves nothing. New binnings from that point are
in-place (§4); the bin channel keeps reconciling the existing folder, so the
photographer can go on managing it by hand. Photographs already binned in place stay
flagged - they are in neither walk, so §6 has no opinion about them (§6.6).

**Clearing it** on a library whose `bin_name` is `NULL` requires a `bin_name` in the
same request, and creates the folder and records its identity exactly as creation
does (§2.3). A flipped library already has both; clearing its flag creates nothing
and re-stats nothing, and the "a folder of that name already exists" refusal does
**not** apply to it - a library that already owns that folder is not colliding with
anything. The `access` check (§2.1) runs first.

A `PATCH` naming `bin_name` on a library that already has one is a **rename** (§2.4),
not an error. It is a `VALIDATION_ERROR` only when the stored `bin_name` is `NULL`
and the same request does not also clear `read_only`, because the app would have to
create a folder under a root the flag forbids it to write to.

### 2.3 The bin folder's lifecycle

**A library with a `bin_name` has the folder from the moment it is created.**
`LibrariesService.create` makes it beside the data directory it already makes and
stats it into the identity columns before the row is inserted - the order
`ShootsService.create` uses (`shoots_service.ts:62-70`). `POST` already refuses a
root holding a folder of that name (`libraries_service.ts:76-81`), so nothing is
adopted.

**One helper owns creating it: `ensureBinFolder(library)`**, which creates the folder
*and* stats and records its identity whenever it creates. Three callers: creation,
clearing `read_only` (§2.2), and `PhotosService.delete`. Without a single owner,
`PhotosService.delete`'s `ensureDir` silently recreates a hand-deleted bin with a
**new inode** while the columns still name the dead one - after which §6.3 can never
follow a rename, and that freed inode number is the likeliest to be recycled into
§6.3's false-positive case.

**The folder is created only on a path that commits.** `create`'s insert can fail -
its own catch expects a UNIQUE race (`libraries_service.ts:104-107`) - and a bin left
behind by a failed insert is then refused by the very check above, so the library can
never be created with that bin name again. Both mkdir-then-commit sequences (creation
and clearing the flag) remove the directory they made if the commit fails.

That removal is a **deletion**, so it goes through `utils/deletions.ts` like every
other one: `.oxlintrc.json` bans `rm`/`rmdir`/`unlink` outside that module, and the
module's own contract is that every deletion "goes through a guard that proves its
target is not an original". So `deleteEmptyBinFolder(library, target)` lives there,
refusing anything that is not exactly `getBinPath(library)` and refusing a non-empty
directory - a plain `rmdir`, which fails while anything is inside it. Both properties
matter: this runs on an error path, where the thing it is about to delete is a
directory the app believes it just created and might be wrong about.

Only the bin's **root** is created. Its interior mirrors the folder a photograph came
from (DESIGN §12.3), so `PhotosService.delete` keeps making `<bin>/A/B/` on demand.

Nothing in the app removes the folder, but the photographer can, so every consumer
still handles its absence: the bin channel skips the run and logs (§6.3), and a
rename refuses (§2.4). A full sync that finds the recorded identity **nowhere** in
the tree recreates the folder through `ensureBinFolder` and re-records it - the walk
is the only place with enough evidence to tell "deleted" from "renamed".

### 2.4 Renaming the bin moves the folder

`PATCH` with a `bin_name` renames `<root>/<old>` to `<root>/<new>`. DESIGN §4.1
refuses this today because it would "strand every already-binned RAW in a folder the
scan would then walk straight back in" - an argument against changing the setting
*alone*. Changing it and moving the folder together strands nothing.

A `bin_name` equal to the stored value is a no-op returning the row unchanged.
Refused with `READ_ONLY` for a read-only library - that check runs first, so a
read-only library never sees `CONFLICT`. Refused with `CONFLICT` when `<root>/<new>`
already exists **and is not the bin itself**: on a case-insensitive filesystem
`existsSync(<root>/bin)` is true when the folder is `Bin`, so a case-only rename must
compare inodes against the recorded identity rather than colliding with itself. That
check is advisory anyway - POSIX `rename` onto an existing empty directory removes
it, so a folder appearing in the window is a race, bounded by `libraryMutex` on our
own side.

Three writes. The `rename` runs first and outside any transaction - a filesystem
operation has no commit to join - then `bin_name` and the prefix rewrite go into one
`photos.transaction`:

1. `rename(oldBinPath, newBinPath)`. Same parent directory, so `EXDEV` is impossible
   and no copy fallback is needed - this is not `moveIntoDir`, which exists to suffix
   colliding *files*. `ENOENT` is an `IO_ERROR` naming the path and the remedy ("run
   a full sync, then retry"): the folder's absence means the photographer moved or
   deleted it, and recreating is right for one and wrong for the other, where it
   would orphan the real bin and leave §6.3 to adopt the orphan and revert the name
   just set. A full sync distinguishes them (§2.3). `EBUSY`/`EPERM` are an `IO_ERROR`
   too, naming the path and that the folder may be a mount point or open elsewhere.
2. `bin_name` to the new name.
3. The `file_path` prefix of every binned row, from `<old>/` to `<new>/`.
   `deleted_from_path` is **not** rewritten: it records where the photograph came
   from, outside the bin, which has not moved.

`bin_dev`/`bin_ino`/`bin_birthtime` are left alone - `rename` preserves the inode.

**The rename goes first because §6.3 is the repair.** A crash between it and the
commit leaves disk at `<new>` with stale columns, which is exactly what §6.3 follows.
Committing first would leave the mirror image, and §6.3 would follow the *old* folder
and revert the name, fighting the half-applied rename instead of completing it.

`LibrariesService.update` becomes `async` for this (it is synchronous today,
`libraries_service.ts:145-168`, and `libraries_api.ts:92` gains an `await`).

**Two things the mutex does not cover on its own.** Held under `libraryMutex` for the
whole operation, like every mutation that moves files - but:

- **Every operation that derives a path from `bin_name` must re-read the library row
  *inside* the mutex.** `syncLibrary` reads it at `sync_service.ts:196` and enters at
  `:225`; `PhotosService.delete` at `:443` and `:447`; `restore` at `:545` and
  `:547`. `bin_name` was immutable, so none of them had to care. With a rename in
  play, a queued bin move resumes with a stale name, `ensureDir` **recreates the old
  bin folder**, and 500 RAWs land in a directory the bin channel never walks.
- **The watcher must be re-armed.** `scopeKey` (`library_watcher.ts:348-350`) has no
  `binName`, so `onLibraryUpdated` returns early and the watch keeps a stale ignore
  entry - after which the app watches its own bin, every binning wakes a sync, and a
  scoped sync over bin paths reads them as unclaimed live additions. `binName` joins
  `scopeKey`, and §6.3's followed rename needs a route to the lifecycle listeners
  too, since it writes `bin_name` from inside `SyncService`. (`scopeKey` also loses
  `dataPath`, per §3.1.)

### 2.5 What a library with no bin does

`getBinPath` returns `string | null`. Its three current callers
(`photos_service.ts:460`, `library_watcher.ts:217`, `libraries_service.ts:44`) plus
the ones this design adds:

- the watcher omits the bin from its ignore list; there is nothing to ignore
- `libraries_service.ts:44`'s rescue step is deleted anyway (§3.1)
- `PhotosService.delete` takes the in-place branch (§4)
- `LibrariesService.create` skips the folder creation; `update` refuses the rename
- §6's bin channel has no root to walk, so it does not run

## 3. Where the catalogue's own files go

Generated files leave the library root **for every library**, and `data_path` is
deleted.

| | holds | env | Docker |
|---|---|---|---|
| **config** | the SQLite database | `DB_PATH` | `/config` |
| **data** | every generated file, per library | `DATA_DIR` | `/data` |

```
/config/bowerbird.db
/data/<library id>/renditions/grid/<photoId>.avif
/data/<library id>/renditions/full-hdr/<photoId>.avif
```

One directory per rendition, suffixed `-hdr` only when stored as HDR
(`renditions.ts:49-51`) - there is no `-sdr`, and nothing writes an `hdr/` directory;
that name survives only as a legacy sweep target (`deletions.ts:16`).

`getDataPath(library)` becomes `path.join(config.dataDir, library.id)`, with
`config.dataDir` resolved absolute at load. `DATA_DIR` is created at startup, and
`<DATA_DIR>/<library id>` plus one directory per rendition kind at library creation -
where `ensureDir(getDataPath(library))` runs today (`libraries_service.ts:99`).
Nothing is created lazily by a writer. A `DATA_DIR` the process cannot write is a
fatal startup error naming the path (thrown before `serve`, in `src/index.ts`, where
the containment check below also lives).

The Bin does not move: originals belong beside the photographs they came from
(DESIGN §12.3).

### 3.1 What this deletes

- **`assertNoDataDirectoryOverlap`** (`libraries_service.ts:118-129`) and its tests.
- **The data-directory rule in `isPathAllowed`** (`scope.ts:69-71`), plus
  `LibraryScope.dataPath` *and* `resolvedDataPath`, and `libraryScope()`'s `dataPath`
  parameter (`scope.ts:24-37`). Callers to update: `sync_service.ts:142`,
  `shoots_service.ts:269`, and the fixtures in `utils/tests/files.test.ts:50`,
  `utils/tests/scope.test.ts:12`, `test/integration/watcher_ignores.integration.test.ts:42`.
  A legacy `<root>/.bowerbird` is still skipped by the dotfolder rule.
- **`scopeKey`'s `dataPath` component** (`library_watcher.ts:349`) - a compile error
  otherwise - and the watcher's `getDataPath` ignore entry (`:214`). `scopeKey` gains
  `binName` (§2.4).
- **`shoots_service.ts:43`**, refusing a shoot inside the data directory.
- **The "it contains the library root" guard** (`libraries_service.ts:37-40`) and
  **the rescue-originals-to-the-Bin step** (`:42-48`). The rescue existed for a
  `data_path` aimed somewhere unwise; there is no such path, and a read-only library
  has nowhere to rescue *to*. `deleteDataDirectory`'s `findOriginalsAnywhere` check
  stays as an assertion rather than a trigger: `rm -rf` is the one call here that
  cannot be undone.
- **`data_path` through the row types and queries**: `dataPathFor` and the column;
  `libraries_repository.ts` at `:8, 25, 36, 41, 47, 122` (row type, `SELECT`,
  `insert`'s `Pick<>`, the INSERT list, the bind, `mapRow`) - the same `Pick<>` gains
  `read_only` and the three identity columns; `photos_repository.ts:120` and the join
  at `:914`; `processing_service.ts:486`, which needs only a library id.
- **Comments that become false**: `utils/paths.ts:41-43`, `utils/deletions.ts:22,51`,
  `libraries_service.ts:24-34`.
- **Two integration tests that fail at runtime rather than typecheck**, so they must
  land in this commit: `test/integration/prune.integration.test.ts:126` (`UPDATE
  libraries SET … data_path`) and
  `test/integration/lossless_render.integration.test.ts:19-23`, which points
  `data_path` at the fixture directory. Plus mechanical fixture-field removal in
  ~10 test files.

One guard replaces all of it, in **both** directions: `DATA_DIR` inside a library's
root, and a library's root inside `DATA_DIR`. The second is the one that loses
photographs, since `removeDataDirectory` deletes recursively. Checked at creation and
at startup, because `DATA_DIR` is an environment variable that can change under a
catalogue that was already valid.

Every other `getDataPath` caller is unchanged (`prune_service.ts:17,27,68`,
`photos_service.ts:407`, `processing_service.ts:128-129`).

**Legacy `<root>/.bowerbird` trees are abandoned deliberately** - the sweep can no
longer reach them. §13 recreates the catalogue anyway.

### 3.2 Docker

`/data` is currently the *database* volume (`docker-compose.yml:18,25`), so it is
being repurposed and the volume name changes with it.

```yaml
volumes:
  - "${PHOTOS_DIR:-./photos}:/photos:ro"    # :ro for a read-only library
  - bowerbird-config:/config
  - "${DATA_VOLUME:-bowerbird-data}:/data"  # a named volume, or a host path for bulk storage
environment:
  DB_PATH: /config/bowerbird.db
  DATA_DIR: /data
```

`DATA_VOLUME`, not `DATA_DIR`: the latter is the container-side path and must stay
`/data`, and one name for both would have a reader setting `DATA_VOLUME=/mnt/bulk`
believe they had set the app's.

A **named** volume inherits `/data`'s ownership from the image, which is why
`Dockerfile:70-75` chowns it to uid 1000; a **host path** does not and must be
chowned by whoever mounts it. `/config` needs the same `mkdir -p` + `chown` or the
first start cannot open the database. `docker-compose.yml:20-23` and
`docker-compose.dev.yml:20-23` both carry claims about renditions living under the
root that stop being true.

## 4. Binning without a bin

`PhotosService.delete` gains one branch. When the library is read-only the file is
not moved, no directory is made, `file_path` is left alone, and
`markDeleted(id, photo.file_path, batch)` runs as today so `deleted_from_path` equals
`file_path`.

Not new machinery: `photos_service.ts:456` already does this for a photo whose file
has gone before the move could run, down to the `row.binRelPath !== row.wasAt` guard
that skips `setFilePath`. The rollback path (`:498-507`) becomes unreachable, because
`row.to === row.from` for every row and it already skips those.

`restore` branches on **where the file is**; `read_only` only decides whether the bin
branch may move anything. Three arms, because two would break every writable library
- whose binned files are all inside the bin:

| the row's file | result |
|---|---|
| outside the bin | `markRestored(id, photo.file_path)`, no move |
| inside the bin, writable | today's move out of the bin, unchanged |
| inside the bin, read-only | refused with `READ_ONLY` |

The first arm cannot merely skip the move:
`moveIntoDir(from, dirname(from), basename(from))` claims the name the file already
holds, hits `EEXIST`, walks its suffix loop to `a_1.arw`, and then `unlinkMovedFile`
removes the source (`files.ts:31`). The file is not duplicated, it is **silently
renamed** under the photographer.

It also keeps today's existence check (`photos_service.ts:554`): "no move" is not "no
validation". Without it a row whose file has gone goes live with `is_missing` cleared
and nothing behind it, and the renditions make the grid look fine while every
original 404s.

The third arm exists because otherwise the row goes live with its RAW still in the
bin and the bin channel re-bins it next sync - a restore repeatable for ever, with
`deleted_from_path` replaced by a guess each time. The message says to clear the flag
first.

**Undo by batch** tests every row's position **before restoring any**, and refuses
the whole batch with `READ_ONLY` if one is inside a read-only library's bin, naming
how many. A half-landed undo is worse than none.

Renditions are kept, as for a bin move (DESIGN §12.1), which is what keeps the Bin
page browsable.

## 5. The exclusion moves from the bin folder to the `photos` table

Today `listForSync` selects only `is_deleted = 0` rows (`photos_repository.ts:739`)
and the scan skips the bin by name (`scope.ts:59`). The file is invisible because it
is somewhere the walk does not go. Remove the move and it is in scope with no row to
match, so every sync imports it as a *new* photograph while the original row stays
flagged: one duplicate per binned photo, per sync.

> **A path claimed by a binned row is not the live channel's business.**

In `syncLibrary`:

1. `binned = photos.listBinnedForSync(libraryId)` - `listForSync` with
   `is_deleted = 1`, returning `SyncDbPhoto`, so it includes `is_missing`, which
   `buildDiff` reads (`sync_algorithm.ts:83,98,100`). Never restricted by scope: one
   query on the existing `idx_photos_is_deleted` partial index (`migrations.ts:140`),
   so no new index is needed. Placed beside `dbPhotos` (`sync_service.ts:307`).
2. `scanFiles` is called as `scanFiles(files, [...dbPhotos, ...binned], …)` - no
   signature change - so `dbByPath` covers binned files and the `unchanged` test at
   `:957` answers correctly. Nothing binned is opened or hashed unless it changed.
   The first-scan gate at `:315` becomes `dbPhotos.length === 0 && binned.length === 0`
   (§6.6). One second-order effect: `dbByPath` is also the hardlink tie-break at
   `:928`, so a live and a binned file briefly hardlinked mid-move may resolve to the
   other path. Harmless.
3. `present` and `changed` are partitioned by the binned paths before `buildDiff`.
   **On a scoped run the binned half is discarded**, because §6 does not run there
   (§6.6) - without this an in-place binned file the watcher reports is an unclaimed
   addition and inserts a second live row every time anyone touches it.

Partitioning *after* the scan would throw the work away having already paid for it:
with `dbByPath` from `listForSync` alone every binned file looks new, and 100k binned
RAWs would decode 100k RAW headers nightly.

**`isPathAllowed`'s bin rule stays where it is** (`scope.ts:59`); the bin gets its own
walk instead (§6). It is a choke point with six callers, all wanting the bin
excluded: the walk (`scan.ts:78`), the watcher (`library_watcher.ts:229`),
`ShootsService.create` (`shoots_service.ts:49`, whose comment says why), the
in-library browser (`libraries_api.ts:49`), and the two scoped-sync helpers
(`sync_service.ts:868,882`). Move the rule out and each needs its own repair, and
each omission is a bug: a shoot created in the bin whose `addPhotos` then moves live
RAWs into it; a bin folder in `dirs` letting `detectRelocationsByIdentity` relocate a
shoot inside the bin; mirroring duplicating the shoots tree; the bin pickable in the
UI. One guard in a shared function beats four in its callers, and DESIGN §6's
one-predicate rule and DESIGN §9.8 stand unamended.

## 6. The bin channel

The bin gets **its own walk**, whose output goes only to the binned rows - a
*secondary* scan of the bin rather than the bin folded into the primary one.

### 6.1 The shapes this needs

The plumbing first, because it is where the risk is. `detectMoves` takes **one**
`LibraryDiff` and neither it nor `MoveEntry` carries a channel, so "detectMoves sees
both" is not expressible against today's types. Three additions:

```ts
// sync_algorithm.ts
interface AddedEntry   { …; channel: 'live' | 'bin' }
interface RemovedEntry { …; channel: 'live' | 'bin' }

interface Crossing { photoId: string; oldFilePath: string; newFilePath: string;
                     direction: 'in' | 'out' | 'within' }

interface MoveResult { moves: MoveEntry[]; crossings: Crossing[]; added: …; removed: …; modified: … }
```

The two channels' diffs are concatenated and `detectMoves` is called **once**; a pair
whose halves disagree on `channel` becomes a `Crossing` rather than a `MoveEntry`.
Three consequences that must be written into the algorithm, not left to the reader:

- **The hash bucket's tie-break is channel first, then `isInAlbum`.** Today's sort is
  `isInAlbum` alone (`sync_algorithm.ts:148-150`), so a binned album member would
  outrank a live non-album removal and take its addition - the swallow §6.4 promises
  cannot happen, on the most ordinary input.
- **The `modified.oldHash` reservation** (`:134-137`) is scoped to its own channel,
  or a bin-side modification consumes a live addition.
- **Crossings stay out of `moves`.** `detectShootRelocations` reads that array
  (`sync_service.ts:351`) and a binned file's movement is not evidence about a live
  shoot folder.

The prefix-rewrite helper both §2.4 and §6.3 share:

```ts
rewriteBinnedPathPrefix(libraryId: string, oldPrefix: string, newPrefix: string): void
```

```sql
UPDATE photos SET file_path = ? || substr(file_path, ?)
  WHERE library_id = ? AND is_deleted = 1 AND file_path >= ? AND file_path < ?
```

It is **not** `rewritePathPrefix` (`photos_repository.ts:634-649`), which does the two
halves the opposite way round - `file_path` for live rows, `deleted_from_path` for
binned ones - and, critically, **clears `is_missing`**. That is right for a shoot
relocation, which is only inferred once every file is proven present at the new
prefix; a bin rename proves nothing about individual files, and §6.2's diff is what
decides `is_missing`. Copy that statement and flip the flag and every hand-deleted
binned file is resurrected on every rename.

**And `rewritePathPrefix` itself needs fixing for in-place binning**, which is a
separate change in the same file. Its comment states the assumption it rests on: "A
soft-deleted row's file is in the bin at the library root and did not move with the
folder, so its `file_path` is left exactly as it is." An **in-place** binned row's
file is not in the bin - it is under the shoot folder that just got renamed, and it
*did* move with it. So a hand-renamed shoot folder in a read-only library leaves
those rows with a stale `file_path`: §5 partitions the dead path out of the live
channel so nothing notices, the file at the new path is unclaimed and imports as a
**new live photograph**, and the binned row is orphaned pointing at nothing. One
duplicate per in-place binned photo under any renamed folder.

The rule that replaces the comment's assumption: a binned row's `file_path` follows a
folder rename when the row's file moved with the folder, which is exactly when the
row is binned in place (`deleted_from_path = file_path`) - and `deleted_from_path`
follows in that case too, since both name the same moved file. A bin-resident binned
row keeps today's behaviour. `is_missing` is still only cleared for rows proven
present, so the in-place arm does not clear it.

`insertFromSync` also needs widening: it hardcodes `is_deleted = 0`,
`needs_tile = 1`, `needs_renditions = 1` and takes no `deleted_from_path`
(`photos_repository.ts:784-793`), and §6.5 needs all four different.

### 6.2 It is the same algorithm, run twice

`scanBinTree` reuses `scanLibraryTree` with an added start-directory argument rather
than forking 45 lines of walk - which is also what keeps relPaths **library-root
relative** (`scan.ts:56` computes them off `scope.rootPath`), as every path in §6
requires. Four decisions it needs beyond that:

- it bypasses `isDirInScope`'s bin rule (a derived scope with `binName` nulled)
- it ignores `include_subfolders`: the bin mirrors folders even in a root-only library
- excluded-folder rules and the dotfolder rule do not apply inside it
- it stats its own root, which §6.3 needs, though it collects no `dirs`

Then the existing machinery with the binned rows as the database side. The four
branches already mean exactly this (`sync_algorithm.ts:81-108`), so none is restated
as a rule of its own:

| `buildDiff` says | result |
|---|---|
| `removed` | `is_missing = 1` |
| `reappeared` | clear `is_missing` |
| `modified` | re-hash, update the row |
| `added` | §6.5 |

`is_missing` on a binned row is unreachable today, so a photograph whose RAW was
deleted out of the Bin still appears there with an original that 404s. The display
side already works (`photo_grid.tsx:254`, and the Bin page uses `PhotoGrid`), which
is why a photo binned while *already* missing does show the badge.

`listMissingForSync` and `listMissing` filter `is_deleted = 0`, so a missing binned
photo stays out of the missing-photos view and is marked in the Bin instead: that
view is a list of things to go and find.

### 6.3 A renamed bin folder is followed

A photographer renaming `<root>/Bin` to `<root>/Rubbish` has done to the bin what
DESIGN §9.4.1 already handles for a shoot, and it is answered the same way - by the
folder's inode identity. Undetected it is the worst outcome in this document: the
live channel walks `Rubbish/`, its files are unclaimed additions whose hashes match
the binned rows exactly (a rename preserves mtime and size, and `computeFileHash` is
a digest of those - `hash.ts:7-21`), and every binned row pairs as a crossing *out*
of the bin. The whole bin restored, `deleted_from_path` destroyed, every undo batch
unresolvable (`idsDeletedInBatch` filters `is_deleted = 1`).

**Detection runs immediately after the walk and before `scanFiles`.** Not merely
"before `buildDiff`": §5's steps 2 and 3 both live in between, and running after them
re-hashes the entire bin and then partitions on paths that match nothing. It does
four things:

1. re-roots the bin channel at the identified folder, reusing the subtree the live
   walk already collected - no second traversal
2. removes that subtree from `files` **and from `dirs`** - otherwise the bin's
   interior stays in `dirs`, and a shoot folder the photographer had earlier moved
   into the bin gets relocated by `detectRelocationsByIdentity` into the renamed bin
3. rewrites the in-memory `binned` rows' `file_path` prefixes, so `dbByPath` and §5's
   partition both see the new paths
4. queues the persisted writes - `bin_name` and the prefix rewrite - for the apply
   transaction (§6.6). An aborted run leaves the folder renamed and the columns
   stale, which the next sync follows again.

**The trigger is the identity turning up in `dirs`.** A directory reaches `dirs` only
if the live walk did not skip it, and the walk skips by name, so a directory carrying
the recorded identity *is* the bin under a name that no longer matches. That covers a
case-only difference too, where the recorded path still resolves and no existence test
would fire.

**Excluding is safe; renaming needs two more conditions.** Dropping the recorded-path
absence test that `detectRelocationsByIdentity` uses (`sync_algorithm.ts:211`) admits
three false positives, all of which present as exactly one candidate with an
identical birthtime: a **bind mount** of the bin elsewhere under the root (same
`st_dev` and `st_ino`), a **hardlinked directory**, and a **recycled inode** where the
bin was deleted and its number handed to a new folder - birthtime cannot help, since
`birthtimesAgree` returns true whenever either side is 0 and overlayfs and 128-byte
ext4 inodes report 0. Following any of them renames `bin_name` to an innocent folder
and re-prefixes every binned row into it, after which that folder's live photographs
read as removed and its files are imported as binned: **a real shoot silently
binned**.

So excluding a `dirs` entry that carries the identity is unconditional, but rewriting
`bin_name` additionally requires:

- `statSync(getBinPath(library))` fails, or returns a **different** `dev:ino` than
  recorded. Not the existence test rejected above: on a case-insensitive filesystem
  it returns the *same* inode, so a case-only rename is still handled by exclusion
  without a spurious rename - and bind mounts and hardlinks die here.
- the candidate contains **at least one file claimed by a binned row** (a prefix
  match against `binned`, already in memory). A newly created folder claims none.

Otherwise, and for a nested candidate (`getBinPath` joins a single name, so a bin one
folder deep is not *expressible*, which is a constraint inherited from
`BinNameSchema` rather than a principle), or two candidates, or `ino` 0: **the bin
channel is skipped for that run** and the reason logged, rows untouched.

**A missing bin root is a skip, not a throw.** `scanBinTree` tests its root before
walking and never propagates `ENOENT` into the live channel's transaction - otherwise
the state §2.4 hands to §6.3 for repair is one where the sync dies, and §2.4's safety
argument is circular. Scoped to ENOENT on the bin with a healthy root: if `<root>`
itself is unreadable the sync must still fail loudly, or an unmounted volume reads as
"the whole bin was deleted".

**Detection runs on a scoped sync too**, even though §6.6 skips the walk and diff
there. It is a `dirs` test and costs nothing, and a Finder rename of a root-level
folder is delivered *by the watcher* - so without it a scoped run sees the bin's files
as unclaimed live additions and inserts one new live row per binned RAW. The
persisted writes are whole-table prefix updates, so they are complete even from a
scoped run.

### 6.4 A crossing is structural

A file that entered or left the bin is a removal in one channel and an addition in
the other. The `channel` tags give the direction, so there is no position to test:

- **live removal + bin addition** - hand-binned. `markDeleted(id, oldPath)`, keeping
  `shoot_id` rather than letting the move's own
  `setFilePathAndShoot(…, shootFor(newPath))` null it (`shootFor` on a bin path is
  `null`, and an app-driven bin preserves membership,
  `photos_repository.ts:667-670`). If the row is *already* binned this is a path
  update only - no `markDeleted`, which would null `deleted_batch` and drop it from
  its batch's undo.
- **bin removal + live addition** - hand-restored. `markRestored`, plus `shoot_id`
  from `shootFor(newPath)`: `markRestored` does not touch it
  (`photos_repository.ts:725-732`) and `reconcileShootFolders` only restates claims
  under newly created folders (`sync_service.ts:827`), so without this the photograph
  lands in the grid with no shoot for good. It also needs `needs_tile = 1` and
  `needs_renditions = 1`, which `markRestored` does not set back after `markDeleted`
  zeroed them (`:682`) - that is part of this change and applies to every restore.
  Only fires on a row that is currently binned.
- **bin removal + bin addition** - moved within the bin. `setFilePath` only.

Keeping the channels separate is what makes this structural. Deciding it by testing
whether a path is under the bin cannot be made correct: an in-place binned row is
`is_deleted = 1` with its file *outside* the bin, indistinguishable by position from a
hand-restore, so a folder rename in a flipped library would silently restore it.

### 6.5 An unclaimed file under the bin is imported as already-binned

The bin channel's `added` branch, over the remainder of `result.added` after pairing.
`is_deleted = 1`, and `deleted_from_path` by stripping the bin segment: the mirrored
layout means `<bin>/A/B/c.arw` yields `A/B/c.arw` exactly, and `<bin>/c.arw` yields
`c.arw` - a file path at the library root.

Before importing, a **path** test beats a hash test: if `<bin>/A/c.arw` is unclaimed
and `A/c.arw` is an unpaired live removal, that is the crossing, and §6.4's first case
applies to the existing row - which also removes that removal from `result.removed`
so `setMissing` does not fire. This survives the case a hash cannot see: the file was
copied into the bin and the original deleted, or touched on the way, so the mtimes
differ. Without it that crossing produces a missing live row *and* a second
already-binned row for one frame.

Such a row has no renditions and `PENDING_PROCESSING` excludes `is_deleted = 1`
(`photos_repository.ts:255`), so nothing queues any; the Bin page shows a hole until
the photograph is opened. Building renditions for something already thrown away is
work nobody asked for.

### 6.6 Where it runs, and what it counts

The bin walk runs alongside the live one; §6.3's detection sits between the walk and
`scanFiles`; pairing happens before the apply, because `result.added` is consumed
inside it (`sync_service.ts:425-428`) and a pass afterwards would insert the file
*and* re-point the binned row at it, leaving two rows claiming one path with no
UNIQUE to stop them (`idx_photos_file_path` is not unique, `migrations.ts:138`).

**Every row write §6 produces is applied inside the same `photos.transaction` as the
live diff** (`sync_service.ts:392-443`), so a run that aborts leaves neither half.
The in-memory rewrites of §6.3 are not deferred to it - the diff has to see matched
paths.

**Order inside that transaction matters, because two of the writes are
path-guarded.** §6.3's persisted prefix rewrite runs *first*. `setMissing(photoId,
expectedFilePath)` only marks a row whose `file_path` still equals the path the scan
saw, and its comment says why: "if a concurrent move/soft-delete changed `file_path`
during the (async) scan, the row is no longer missing at that path, so this is a
no-op" (`photos_repository.ts:890-895`). After a followed rename the scan's paths are
the *new* ones while the rows still hold the old, so a `setMissing` issued before the
prefix rewrite matches nothing and **silently does nothing** - a guard designed to
absorb a race quietly absorbing a correct write instead. The same applies to any
other path-guarded update the bin channel issues.

A **scoped sync runs no bin channel**: the watcher never reports events inside the bin
(`library_watcher.ts:217`, kept - watching a tree that only grows costs an inotify
handle per directory), so a scoped run has no evidence and must not conclude
`is_missing` on rows it did not look at. Hand-managed bin changes are noticed by the
nightly full sync. §6.3's detection is the one exception.

**That makes the bin channel depend on a setting the photographer can switch off.**
`full_sync_at` defaults to `03:00` and `''` disables the daily reconcile entirely
(`DailySync.start` returns immediately), and it is the only thing that runs a full
sync unprompted - so with it off, a hand-binned file is never imported, a hand-deleted
one never marked missing, a renamed bin never followed, and §2.4's `IO_ERROR` remedy
("run a full sync, then retry") has to be performed by hand. That is acceptable but it
must be said: the Settings copy for `full_sync_at` names the bin as something the
nightly run reconciles, so turning it off is an informed choice rather than a silent
loss of a feature the photographer was told they had.

Counts: §6.2's `is_missing` transitions and re-hashes are `photosModified`, crossings
and within-bin moves `photosMoved`, §6.5's imports `photosAdded`, and a followed
rename none of them - it renames a folder. The bin channel's paths are part of the
progress total, in the same phase as the walk. `photo_count` needs nothing: it is a
subquery over `is_deleted = 0` (`libraries_repository.ts:23-28`).

## 7. Shoots

A shoot is a folder (DESIGN §4.3) and membership is decided by the folder a file sits
in (DESIGN §9.4), so "add these photographs to that shoot" *is* a file move -
`reconcileShootFolders` restates membership from the path whenever a new mirrored
shoot appears (`sync_service.ts:827`), so a database-only override would revert.

Read-only libraries therefore create shoots only over folders that already exist
(`ShootsService.create` already distinguishes this with `existsSync`; `!existed`
becomes `READ_ONLY` instead of an `ensureDir`), and refuse `addPhotos` and
`removePhotos` with `READ_ONLY` - the guard landing before `ensureDir(destDir)` at
`shoots_service.ts:124`, which runs outside the mutex. Mirroring already makes a
shoot per folder holding photographs, so most exist before anyone asks.

Albums need no changes: pure membership rows, already accepting the same
`PhotoTarget` shapes (`albums_presenter.ts:69-74`). One inherited limit is worth
knowing, since this document makes albums the answer: `getBasicByIds` filters
`is_deleted = 0` (`photos_repository.ts:564-574`), so a **binned** photograph cannot
be added to an album. Its comment gives the reason - a Bin-resident row "must not be
movable/settable via these paths (it would escape the Bin while still flagged
`is_deleted` and get re-imported as a duplicate)" - which is a shoot-move argument
that album membership was swept up by. §5 removes the re-import hazard it names, so
the filter could be narrowed to the shoot paths later; left alone here because
binning a photograph and then filing it is a rare thing to want. Everything else about shoots
keeps working, none of it touching disk - renaming, descriptions, banners, ordering,
deletion with `photos: 'keep'` or `'remove'` (a folder rule and rows, DESIGN §4.7,
never a file), and mirroring itself.

## 8. The sync lock becomes a table

The lock protects the catalogue, not the tree - DESIGN §9.7 calls it "the
cross-process source of truth for *is this library syncing*" - so it belongs in the
catalogue. In one process the correctness already comes from `libraryMutex`; the
comment at `sync_service.ts:222-224` says the file lock is taken first only "to keep
sync-vs-sync fail-fast (409)". Its sole unique contribution is cross-process
exclusion. Two call sites: `syncLibrary` (`:207`) and `rebuildStage` (`:566`), the
second not a sync at all - it holds the lock for a claim only, and `sync_locks` must
serve that too.

Two processes with **separate** databases syncing one library are both read-only
against the tree. The hazard is two syncs racing the **same rows** - diff and apply
are not one transaction - which is the same-database case a table covers exactly.

```sql
CREATE TABLE sync_locks (
  library_id    TEXT PRIMARY KEY REFERENCES libraries(id) ON DELETE CASCADE,
  owner         TEXT NOT NULL,   -- UUID, one per ACQUIRE
  started_at    TEXT NOT NULL,   -- toISOString(), UTC
  refreshed_at  TEXT NOT NULL
);
```

`owner` per acquire, not per process: a per-process owner let a run whose lease had
lapsed delete its successor's row on the way out, and let two syncs in one server
both hold the lock. No `pid` column - a PID is what §8.1 is about, and the owner UUID
goes in the log line. Timestamps are `toISOString()` UTC, which is what makes
`refreshed_at < ?` a valid comparison. The lease is 30 seconds, so `?4` is `now - 30s`.

**Acquire** is one statement, so there is no check-then-claim window:

```sql
INSERT INTO sync_locks (library_id, owner, started_at, refreshed_at)
VALUES (?1, ?2, ?3, ?3)
ON CONFLICT(library_id) DO UPDATE SET
  owner = excluded.owner, started_at = excluded.started_at, refreshed_at = excluded.refreshed_at
WHERE sync_locks.refreshed_at < ?4;
```

`changes()` is 1 when taken, 0 when a live holder kept it - the `SYNC_IN_PROGRESS`
case. SQLite's upsert is the compare-and-swap, so this needs no `BEGIN IMMEDIATE` and
cannot lose the race a `SELECT` then `INSERT` in a deferred transaction would.

**Refresh** is the same `UPDATE … WHERE library_id = ?1 AND owner = ?3`, owner-scoped
so a stalled holder cannot resurrect a lock somebody took over. It is driven by the
work rather than a timer, because the scan and apply are synchronous and a
`setInterval` is starved precisely when the lease matters. The refresh points must
cover all four blocking stretches, not just the obvious one: `scanLibraryTree`'s walk
(the lease is taken at `:207`, *before* `libraryMutex` and the walk), `scanFiles`'
first stat loop (`:915-931`, which has no callback today), `reportScan` in the second
loop (`:953`), and `insertBatch`. Throttled on a `Date.now()` compare.

**Release** is `DELETE … WHERE library_id = ?1 AND owner = ?2`, owner-scoped so a
late `finally` cannot delete a successor's lock. The lease covers scan and apply only
and is released before the detached processing (DESIGN §9.6).

**The apply re-reads the owner as its first statement and rolls back on a mismatch** -
the one stretch no refresh point can reach. It must be `BEGIN IMMEDIATE`
(`db.transaction(fn).immediate()`, which `PhotosRepository.transaction` does not
expose today): a leading `SELECT` in a deferred transaction takes the read snapshot
there and the first write must then upgrade, returning `SQLITE_BUSY_SNAPSHOT`, which
`busy_timeout` does **not** retry. Each batch on the first-scan path does the same;
batches already committed are not rolled back.

**`syncAll` retries what it skipped.** It swallows `SYNC_IN_PROGRESS` with no retry
(`:176-181`), so under expiry-only reclaim a container killed and restarted within
seconds has that library dropped until tomorrow. It collects the skipped libraries
and re-attempts them once at the end of its loop, by which point a real lease has
lapsed.

Living in a `SyncLocksRepository` injected into `SyncService` (whose constructor takes
repositories, `:128-136`), wired in `src/index.ts`.

**What this deletes:** `sync_lock.ts`'s contents, `SYNC_LOCK_NAME` and
`deleteSyncLockSync` (`utils/deletions.ts:20,64-70`), the watcher's ignore entry
(`library_watcher.ts:216`), `utils/tests/deletions.test.ts:86-97`, all of
`services/sync/tests/sync_lock.test.ts` (its PID and stale-file tests are about a
mechanism that stops existing), and
`test/integration/watcher_ignores.integration.test.ts:108-110`. It also removes one
write from the library root for every library, which is why a read-only library needs
no lock special case.

### 8.1 Liveness stops depending on the PID

`pidAlive` asks `process.kill(pid, 0)` in the *asking* process's PID namespace, which
is not the namespace the number was minted in. Container A holds the lock as its PID
1; container B checks PID 1, finds its own init, and refuses to sync **permanently**.
Or A holds PID 37, which does not exist in B, so B declares it stale and both sync at
once. Not Docker-specific either: a reused PID after a hard kill gives the same
permanent refusal on a plain host.

A timestamp means the same thing in every namespace. The cost is that reclaiming a
crashed sync's lock takes up to 30 seconds, which the watcher handles by re-arming
and `syncAll` by retrying. `flock(2)` is moot: SQLite already holds a kernel-level,
namespace-blind lock on the inode, and neither Node nor Bun exposes one to acquire
directly.

### 8.2 Two containers sharing /config

The configuration the table has to be right for, and the one the file lock gets
wrong. SQLite excludes writers with `fcntl` locks, which live on the inode in the
kernel rather than in any PID namespace, so two containers holding the same inode
through the same volume contend correctly. The pragmas are already set
(`connection.ts:10-12`): WAL, cross-process on one host because both mmap the same
`-shm` off the shared volume, and `busy_timeout = 5000`.

Three supported-configuration statements:

- **Sharing `/config` requires sharing `/data`.** `needs_tile`, `needs_renditions`
  and `renditions_built_at` are columns in the shared database; the files are
  per-`DATA_DIR`. With separate data directories whichever container builds a
  rendition clears the flags for both, `PENDING_PROCESSING` then excludes those rows
  for everyone, and the other serves 404s for ever with nothing able to queue the
  work.
- **Two containers are read-mostly**: both may sync, only one may bin or move
  photographs. `libraryMutex` is process-global (`library_mutex.ts:6-10`) and cannot
  see the other container. Mutations taking the lease and waiting is the fix, out of
  scope here.
- **Two hosts are unsupported**, and were before: SQLite over a network filesystem
  has no working WAL shared memory.

On a race the loser re-arms rather than concluding its change is covered
(`library_watcher.ts:325-327`) - the holder's scan may have started before that
change. The retry then stats its handful of paths, finds them unchanged against the
rows the winner wrote, and applies an empty diff.

## 9. What needs nothing

Verified, not assumed: ratings, triage, notes, albums, stacks and auto-stacking,
shoot names/descriptions/banners/orderings, folder rules, every setting, metadata
refresh, the watcher, rendition building, the orphan sweep, and the quality-check
page (`tmpdir`). Raw edit parameters are not persisted anywhere today; when they are,
they belong in the database, and this design is the reason to say so now rather than
in a sidecar beside the RAW.

## 10. Errors

`ErrorCode` gains `READ_ONLY` → **403** (`errors.ts:5-18`). Distinct from
`VALIDATION_ERROR` because the request is well-formed and would have succeeded
against another library.

Raised by: `ShootsService.create` for a folder that does not exist **in a read-only
library**; `addPhotos` and `removePhotos` in one; `PhotosService.restore` and undo for
a row whose file is inside a read-only library's bin (§4); `LibrariesService.create`
for `read_only: false` over a root failing the `access` check, `update` when clearing
`read_only` on such a root, and `update` for a `bin_name` rename on a read-only
library - that check running first, so a read-only library never sees `CONFLICT`.

A *writable* library's rename raises `CONFLICT` when the new name is already a folder
at the root. `ShootsService.create` and `addPhotos` for a destination under the bin
raise `VALIDATION_ERROR` in any library: not a legal shoot target regardless of the
flag.

Not raised by binning: that succeeds, differently.

## 11. API and schema

```ts
// schemas/libraries.ts
LibrarySchema           read_only: z.boolean().default(false)
                        bin_name: z.string().nullable()
                        // data_path: gone; bin_dev/bin_ino/bin_birthtime are not exposed
CreateLibraryRequest    read_only: z.boolean().default(false)
                        bin_name: BinNameSchema.nullable().default('Bin')  // forced null when read_only
UpdateLibraryRequest    read_only: z.boolean().optional()
                        bin_name: BinNameSchema.optional()   // renames the folder (§2.4)
```

```ts
// config.ts - alongside port, host, dbPath
dataDir: path.resolve(process.env.DATA_DIR ?? './data')
```

`BinNameSchema` (`schemas/libraries.ts:7-12`) is unchanged - one path segment,
rejecting `/`, `\`, `.`, `..` and empty - and that is still the whole of the
validation, because the rename adds no new expressible shapes.

`GET /api/browse` gains one optional `writable` per listing. A successful rename
returns the updated `LibrarySchema` row; the number of rewritten rows is not
reported, and a rename neither updates `last_synced_at` nor queues a sync.

`POST /api/libraries` stops accepting `data_path` (ignored rather than rejected: it
named a location the app no longer has a concept of) and forces `bin_name` to `null`
when `read_only` is set. The "root already holds a folder named `bin_name`" refusal
applies only when a `bin_name` is supplied.

## 12. UI

**Add-library dialog** (`add_library_dialog.tsx`) gains one checkbox, *Don't change
anything in this folder*, ticked and disabled when the listing reports
`writable: false`. Ticking it hides the bin-name field - and must also drop `bin`
from the submit guard at `:182`, which otherwise disables Add for ever. A `READ_ONLY`
from `POST` re-ticks the checkbox rather than surfacing a bare error, since `access`
can be wrong.

**Settings** shows the flag per library with the consequences named, and gains a
**new** bin-name field - there is none today, only in the add dialog - which renames
the folder (§2.4) and says so. Read-only for a read-only library, with the reason. A
`CONFLICT` names the folder in the way, since the remedy is another name.

**The Bin page's** line about the files (`bin_page.tsx:23`, "The RAW files still
exist, moved into a Bin folder on disk") is false for a read-only library and must
read off it: moved into `<bin_name>` when there is one, left where they were when
there is not. A binned photograph whose file has moved carries the `missing` badge
until a full sync pairs it.

**Restore** stays visible but disabled for a photograph whose file is inside a
read-only library's bin, with "clear the flag first" in the tooltip. **Add to shoot**
and **Remove from shoot** are hidden for a read-only library; *Add to album* is the
thing to reach for.

## 13. Schema, not migration

**Nothing migrates.** There are no installs to carry forward - only a dev catalogue,
which gets recreated - so every change is an edit to `SCHEMA` in `db/migrations.ts`:
no `ensureColumn`, no table rebuild, no data move. `migrations.ts:486`'s
`ensureColumn(db, 'libraries', 'bin_name', "TEXT NOT NULL DEFAULT 'Bin'")`
contradicts the nullable column and goes with it.

In `libraries`: add `read_only`, `bin_dev`, `bin_ino`, `bin_birthtime`; make
`bin_name` nullable; delete `data_path`. Plus `sync_locks` (§8), which goes **after
`libraries`** in `SCHEMA` - the file's opening comment is "Tables are ordered so every
REFERENCES target already exists", and `sync_locks` references `libraries(id)` with
`PRAGMA foreign_keys = ON` (`connection.ts:11`). A `sync_locks` row at startup means
"stale within 30 seconds", not "syncing" - a crashed process leaves its row and expiry
clears it, so startup deletes nothing.

The ten incremental migrations already in the file carry the same dead weight, but
folding them into `SCHEMA` is a separate change and not this document's call.

**These are not one commit.** The schema edits belong to the commits that need them:
`read_only` and `bin_name` nullable with §2, the identity columns with §2.3, the
`data_path` deletion with §3, `sync_locks` with §8.

## 14. Testing

The two highest-value tests, neither of which any other test substitutes for:

- **Integration, a read-only library over a fixture tree with the directory
  permissions actually dropped**, so a stray write fails the test rather than passing
  unnoticed. Sync, bin, restore, undo, rate, stack, album.
- **Integration, two *processes* over one database file** - not two `Database` handles
  in one process, since `fcntl` locks are per-inode and invisible to a same-process
  test. Both told to sync one fixture library at once; exactly one wins, the loser
  raises `SYNC_IN_PROGRESS`, and the photo count afterwards is the file count rather
  than twice it.

Unit, the ones the document's own arguments hang on:

- Restoring an in-place binned photo renames nothing - asserted by listing the
  directory, since the regression is a silent `a_1.arw` rename that a row assertion
  would miss. Restoring one inside a **writable** library's bin still moves it out
  (the arm a two-arm rule would have broken). Inside a read-only library's, throws
  `READ_ONLY`, and an undo batch containing one is refused before any row is restored.
  A row whose file is gone still raises `IO_ERROR`.
- A binned file whose `mtime` and `size` match its row is never opened - spied on the
  metadata extractor, since the row assertions pass either way and the cost is the
  point. The same spy is the real assertion for a followed rename: **no binned file is
  opened and `photosMoved` is 0**, because the headline row assertions pass even
  against the broken ordering, which self-heals through the within-bin arm.
- A followed rename moves `bin_name` and the binned `file_path` prefixes, leaves
  `deleted_from_path`, and a restore afterwards still lands the photograph where it
  came from. Renaming the bin of a formerly-read-only library leaves its in-place
  binned rows untouched.
- A bind-mounted second path to the bin, and a folder that inherited the bin's
  recycled inode, are **not** followed. Two candidates sharing an inode are not
  followed. A deleted bin folder skips the channel and leaves `is_missing` untouched
  on every binned row.
- Each crossing direction: into the bin keeps `shoot_id`; out of it gains the
  `shoot_id` of where it landed and comes back with `needs_tile` set; a crossing whose
  `mtime` changed is still caught by §6.5's path test and produces one row.
- A binned album member does not outrank a live removal for the same hash (the
  channel-first tie-break).
- Pairing before the apply leaves one row, not a duplicate plus a re-pointed original.
- A scoped sync touches no binned row's `is_missing`, but a bin rename the *watcher*
  reports is still followed and imports no duplicates.
- A create whose insert fails leaves no bin folder behind. `ensureBinFolder`
  re-records the identity when it recreates a deleted bin.
- **A hand-renamed shoot folder in a read-only library leaves its in-place binned rows
  reachable**: one row afterwards, not a live duplicate plus an orphan. This is
  `rewritePathPrefix`'s stale-`file_path` bug (§6.1) and nothing else in the suite
  covers it, because it needs a *shoot* rename over a library whose binned rows sit
  outside any bin.
- A followed bin rename that also marks a row missing does both, rather than the
  `setMissing` guard swallowing the second write (§6.6's ordering).
- Two acquires without a release between do not both succeed, whatever process they
  come from. A 31-second-stale row is reclaimed, a 5-second one is not. A release
  cannot delete another owner's row. An apply whose owner changed rolls back and
  writes nothing. `syncAll` re-attempts a library it skipped.
- `DATA_DIR` inside a library root, and a root inside `DATA_DIR`, are both refused at
  creation and startup. An unwritable `DATA_DIR` fails startup.

E2E: adding a read-only library, binning a selection, checking the Bin, restoring,
and confirming the tree on disk is byte-identical.

## 15. Known limitations

- No bin folder to open in Finder. A binned photograph is visible in the app and
  untouched on disk, and nowhere else. A read-only library's bin also cannot be
  renamed from the app (§2.4) - renaming the folder by hand works and is followed.
- Photographs cannot be moved into or out of shoot folders; albums cover the
  grouping.
- Crossings pair on `file_hash`, a digest of extension, dimensions, mtime, colour
  space, size and orientation rather than of pixels (`hash.ts:7-21`), so two
  byte-identical copies collide by construction. Not new - the live `detectMoves` has
  always had it - but §6.4 extends it to binned rows. §6.5's path test covers the
  common false negative; the false positive remains.
- Two instances sharing `/config` must share `/data`, and only one may bin or move
  photographs (§8.2).
- Any catalogue predating this is recreated (§13), which is only free while there is
  one dev instance.
