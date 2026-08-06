# Read-Only Libraries, Design

Date: 2026-08-06

A **read-only library** is one Bowerbird never writes to. Its photographs, and the
folders holding them, are exactly as the photographer left them: an archive
volume, a NAS export mounted read-only, a shared drive, or simply a collection
the photographer would rather no software rearranged.

Everything the catalogue knows still works, because almost none of it was ever
about the files. Ratings, triage verdicts, notes, albums, stacks, shoot labels
and the renditions themselves are all database rows and generated files, and none
of them needs a byte of the library root. What genuinely needs to write is a much
shorter list than the code suggests, and most of it needs to write only because
that is how it was built, not because the feature demands it.

Binning is the example that motivates this. Today a binned photograph is a RAW
moved into `<root>/<bin_name>/…` and a row flagged `is_deleted`. The move is not
what makes it binned - the flag is. The move exists so the next scan does not
re-import the file, and there is a cheaper way to arrange that.

**A bare `§N` is a section of this document. A reference to the main design is
written `DESIGN §N`.**

Terms, used exactly and only this way throughout:

| term | meaning |
|---|---|
| **read-only** | the library's `read_only` flag is set: the app writes nothing under `root_path` |
| **the bin** | the folder `<root_path>/<bin_name>`, for a library whose `bin_name` is not `NULL` |
| **binned** | `is_deleted = 1`, whatever the file's position on disk |
| **in-place binning** | binned with no move: `file_path` unchanged |
| **claimed** | a path some row's `file_path` names |
| **unclaimed** | a path no row's `file_path` names |
| **hand-binned** | a file the photographer moved into the bin themselves, outside the app |
| **hand-restored** | a file the photographer moved out of the bin themselves, outside the app |

## 1. Scope

- A per-library `read_only` flag, probed at creation and changeable afterwards.
- Binning, restoring and undo, with no move on disk.
- Shoot creation restricted to folders that already exist; moving photographs
  into and out of shoot folders refused (§7).
- The API, error and UI surfaces of those (§11-§13).

Three of the changes it needs turn out to be worth making for **every** library,
read-only or not, and this document specifies them that way. Each stands alone and
each fixes something already wrong:

- **Generated files leave the library root**, `data_path` is deleted, and config
  and data get separate directories (§3). Removes four guards that only existed to
  survive a user-supplied path.
- **The scan's exclusion of binned files moves from the bin folder to the `photos`
  table** (§5), which makes the bin's contents observable and so lets it be
  hand-managed (§6) and lets `is_missing` reach a binned row at all.
- **The sync lock becomes a leased row** (§8), because it protects the catalogue
  rather than the tree, and because its PID-based staleness check is wrong across
  containers today (§8.1).

After all three, a read-only library needs no special case for its data directory
and none for its lock.

Out of scope: read-only *photographs* within a writable library, per-folder
write permissions, exporting edited renditions anywhere (no export exists yet),
and importing into a read-only library from elsewhere.

**Documents this supersedes**, each qualified because several of these numbers
collide with this document's own: DESIGN §4.1 (the `libraries` columns), DESIGN §6
(the data directory and the scan's exclusions), DESIGN §9.7 (the whole sync lock),
DESIGN §9.8's ignore-list paragraph, DESIGN §12.1 and DESIGN §12.3 (binning and the
bin folder), DESIGN §13.1 and DESIGN §15. Nothing this document contradicts is left
standing there; DESIGN §9.7 in particular describes a file that stops existing.

## 2. The flag

Two columns on `libraries`:

```sql
read_only  INTEGER NOT NULL DEFAULT 0   -- the app writes nothing under root_path
bin_name   TEXT                         -- now nullable: NULL means this library has no bin
```

`bin_name` becoming nullable is load-bearing, not tidiness. It is what tells the
app whether `<root>/<bin_name>` means anything, and `NULL` rather than `''`
because `path.join(root, '')` is `root` - an empty bin name would make every path
in the library test as "under the bin" and §6 would read the whole catalogue as
binned. `string | null` also makes the compiler find the three sites that have to
decide what a library with no bin does (§2.3).

| `read_only` | `bin_name` | meaning |
|---|---|---|
| 0 | set | today's library |
| 1 | `NULL` | born read-only: nothing on disk can record a binning, so the flag is the only truth |
| 1 | set | flipped to read-only: an existing bin holds RAWs the app put there, and is still honoured |

`read_only = 0` with `bin_name IS NULL` never persists: unlocking a born-read-only
library supplies a bin name in the same request (§2.2).

### 2.1 Detecting a read-only root

**Browsing asks without writing.** `GET /api/browse` reports `writable` for the
folder being listed - **one boolean per listing, not one per child entry** - from
`access(dir, W_OK)`. Nothing is created, which matters in a document whose thesis
is not writing in the photographer's folders: a probe per entry would create and
unlink a file in every directory the photographer merely walked past, and cost a
round trip each on a network share. `access` can be fooled by an exotic ACL, and
that is acceptable here because the answer only pre-ticks a checkbox.

**Creating probes for real.** `POST /api/libraries` writes
`.bowerbird-write-test-<random>` with `wx` (`O_CREAT | O_EXCL`), then closes and
unlinks it in a `finally`. Randomised and `finally`-unlinked because a fixed name
has two failure modes that a `W_OK` check does not: two concurrent probes of one
folder fail each other, and a file left by a killed process makes a perfectly
writable root report unwritable **for ever**, with no in-app remedy - the scan
ignores dotfiles, so nothing would ever notice or clear it. `EEXIST` is therefore
a genuine collision and is retried once with a fresh name; only `EROFS`, `EACCES`
and `EPERM` mean read-only.

A library created with `read_only: false` over a root that fails the probe is
refused with `READ_ONLY`, not silently upgraded: the client supplied a `bin_name`
on the assumption the root was writable, and forcing the flag would discard it.

The probe runs at creation and when the flag is cleared, and never again. A volume
remounted read-only afterwards surfaces as an `IO_ERROR` from the write that
fails, which is what it is.

### 2.2 Changing it afterwards

`PATCH /api/libraries/:id` accepts `read_only`, both directions.

**Setting it** keeps `bin_name`. Files already in the bin stay there, their rows
keep pointing at them, and the bin keeps being reconciled against disk (§6) - so
the photographer can go on emptying, refilling or reorganising that folder by
hand. New binnings from that point are in-place (§4). Nothing else happens: with
`data_path` gone (§3) the flip moves no files and touches no other column.

**Clearing it** requires a `bin_name` if the library has none, in the same
request; a `PATCH` naming `bin_name` on its own is a `VALIDATION_ERROR`, because
`read_only = 1` with a `bin_name` and no bin folder on disk is a state §6 would
then start reconciling against a folder that does not exist. The probe (§2.1) runs
first and the request is refused if the root is not writable. The same "a folder of
that name already exists at the root" refusal `POST` applies
(`libraries_service.ts:76-81`) applies here too - without it, naming an existing
folder of photographs as the bin would have §6 read every row under it as binned.

Photographs already binned in place stay where they are, still flagged: nothing
sweeps them into the newly-named bin, because moving a photographer's files as a
side effect of a settings change is precisely what this feature exists to avoid.
§6's transition rule is what keeps them flagged rather than un-binning them.

`bin_name` is **write-once**: `PATCH` accepts it only while the stored value is
`NULL`, and never replaces one name with another. Renaming it would strand every
already-binned RAW in a folder the scan would then walk back into.

### 2.3 What a library with no bin does

`getBinPath` returns `string | null`, `null` when `bin_name` is `NULL`. Its
callers:

- `library_watcher.ts:217` omits the bin from the ignore list; there is nothing to
  ignore.
- `libraries_service.ts:44`'s rescue step is deleted anyway (§3.1).
- `PhotosService.delete` takes the in-place branch (§4).
- §5's `isUnderBin` answers `false` for every path.

## 3. Where the catalogue's own files go

Generated files leave the library root **for every library**, read-only or not,
and `data_path` is deleted.

Two locations, both the app's, neither inside anybody's photographs:

| | holds | env | Docker |
|---|---|---|---|
| **config** | the SQLite database | `DB_PATH` | `/config` |
| **data** | every generated file, per library | `DATA_DIR` | `/data` |

```
/config/bowerbird.db
/data/<library id>/renditions/grid/<photoId>.avif
/data/<library id>/renditions/full-hdr/<photoId>.avif
```

One directory per rendition, suffixed `-hdr` only when the rendition is stored as
HDR (`renditions.ts:49-51`) - there is no `-sdr` suffix, and nothing writes an
`hdr/` directory: that name survives only as a legacy sweep target in
`GENERATED_DIRS` (`deletions.ts:16`).

`getDataPath(library)` becomes `path.join(config.dataDir, library.id)`, and
`config.dataDir` is **resolved absolute at config load**, so `getDataPath` does not
depend on the process's working directory and §3.1's containment check compares
absolute paths.

Split from the database because they want different volumes: the catalogue is
megabytes and wants to be backed up, and renditions are the bulk of the footprint
and want bulk storage. Pointing `/data` at a spinning disk while `/config` stays on
an SSD is then a compose line rather than a schema field.

`DATA_DIR` is created at startup and `<DATA_DIR>/<library id>` at library
creation, exactly where `ensureDir(getDataPath(library))` runs today
(`libraries_service.ts:99`). Nothing is created lazily by a rendition writer. A
`DATA_DIR` the process cannot write is a **fatal startup error** naming the path,
rather than a server that starts and fails every rendition with `IO_ERROR`.

The Bin does not move. Originals belong beside the photographs they came from
(DESIGN §12.3), and `<root>/<bin_name>` is still exactly where a photographer
expects to find a RAW they deleted.

### 3.1 What this deletes

A user-supplied `data_path` was the source of a whole family of hazards, and each
guard against them goes with it:

- **`assertNoDataDirectoryOverlap`** (`libraries_service.ts:118-129`) and its
  tests. Its entire job was refusing a `data_path` that would swallow another
  library's root, or a root sitting inside one.
- **The data-directory rule in `isPathAllowed`** (`scope.ts:69-71`) and
  `LibraryScope.resolvedDataPath` with it. Nothing generated is under the root any
  more. A legacy `<root>/.bowerbird` left behind is still skipped, by the dotfolder
  rule that was always covering it.
- **`LibraryScope.binName`**, once the bin test leaves `isPathAllowed` (§5), and
  **the watcher's `getDataPath` ignore entry** (`library_watcher.ts:214`), pointless
  once the data directory is outside the watched root.
- **The "it contains the library root" guard** in `removeDataDirectory`
  (`libraries_service.ts:37-40`).
- **The rescue-originals-to-the-Bin step** (`libraries_service.ts:42-48`) - see §9.
- **`data_path` threaded through queries and signatures**: `dataPathFor`, the
  column in `libraries`, the join in `photos_repository.ts:914`, and
  `processing_service.ts:486`, which reads `pending.root_path, pending.data_path`
  and needs only a library id.
- **The read-only special case for the data directory an earlier draft needed, and
  the flip-time relocation with it.** Nothing about `read_only` decides where
  generated files go.

One guard replaces all of it, and it runs in **both** directions: `DATA_DIR` inside
a library's root, and a library's root inside `DATA_DIR`. The second direction is
the one that loses photographs - `removeDataDirectory` would delete the tree
recursively - so it cannot be the direction left unchecked. Checked at library
creation **and at startup for every library**, because `DATA_DIR` is an environment
variable that can change under a catalogue that was already valid.

**Legacy `<root>/.bowerbird` trees are abandoned deliberately.** With `dataPathFor`
gone the orphan sweep can no longer reach them, so a dev machine keeps a directory
of dead renditions inside the photographs. Deleting it is a one-line manual step,
and §14 recreates the catalogue anyway.

### 3.2 Docker

Note `/data` is currently the *database* volume (`docker-compose.yml:18,25`:
`DB_PATH: /data/bowerbird.db` on `bowerbird-db:/data`). This repurposes it, so the
volume name changes with it rather than silently inheriting a database.

```yaml
volumes:
  - "${PHOTOS_DIR:-./photos}:/photos:ro"   # :ro for a read-only library
  - bowerbird-config:/config
  - "${DATA_DIR:-bowerbird-data}:/data"    # point at bulk storage if you like
environment:
  DB_PATH: /config/bowerbird.db
  DATA_DIR: /data
```

Three files, not one:

- `docker-compose.yml`, above. Its comment at `:20-23` says renditions live in
  `<root>/.bowerbird` and must be rewritten - that stops being true for every
  library, not just read-only ones.
- `docker-compose.dev.yml`, which has the same shape and the same stale comment.
- **`Dockerfile:70-75`**, which pre-creates and `chown`s `/data` to uid 1000
  precisely because a named volume mounted over a root-owned image directory
  "arrive[s] root-owned and the app cannot write its own database". `/config` needs
  the identical `mkdir -p` + `chown`, or the first start cannot open the database.

## 4. Binning without a bin

`PhotosService.delete` gains one branch. When the library is read-only:

- the file is not moved and no directory is made
- `file_path` is left alone
- `markDeleted(id, photo.file_path, batch)` runs as it does today, so
  `deleted_from_path` equals `file_path`

This is not new machinery. `photos_service.ts:456` already does exactly this for
a photo whose file has gone before the bin move could run, down to the
`row.binRelPath !== row.wasAt` guard that skips `setFilePath`. In-place binning is
that branch generalised: the read-only library is the case where the file is
present and the move is the thing that is absent.

The rollback path (`photos_service.ts:498-507`) becomes unreachable for a
read-only library, because `row.to === row.from` for every row and it already
skips those. Nothing moved, so a failed commit leaves nothing to undo.

`restore` needs an explicit branch and cannot merely skip the move, but **the
branch is on where the file is, not on `read_only`**:

- **File outside the bin** (every in-place binning): `markRestored(id,
  photo.file_path)` and nothing else. Skipping the move is not enough -
  `moveIntoDir(from, dirname(from), basename(from))` claims the name the file
  already holds, hits `EEXIST`, walks its suffix loop to `a_1.arw`, and then
  `unlinkMovedFile` removes the source (`files.ts:31`). The file is not duplicated,
  it is **silently renamed** under the photographer, in a library the app is not
  supposed to be writing to at all.
- **File inside the bin**, which a library flipped to read-only still has: refused
  with `READ_ONLY`. The only honest restore is a move out of the bin and the app
  may not make it. Clearing the flag first is the answer, and the message says so.
  Without this branch the row goes live with its RAW still in the bin, and §6's
  next pass re-bins it - a restore the user can repeat for ever, with
  `deleted_from_path` replaced by a guess each time.

**Undo by batch** resolves ids and calls `restore`, so it inherits that: a batch is
refused whole with `READ_ONLY` if any of its rows' files are inside the bin, naming
how many. A half-landed undo is worse than none.

Renditions are kept, exactly as they are for a bin move (DESIGN §12.1), which is
what keeps the Bin page browsable.

## 5. The exclusion moves from the bin folder to the `photos` table

Today two facts conspire to keep a binned file out of the catalogue:
`listForSync` selects only `is_deleted = 0` rows (`photos_repository.ts:739`),
and the scan skips the bin folder by name (`scope.ts:59`). The file is invisible
because it is somewhere the walk does not go. Remove the move and the file is in
scope with no row to match, so every sync imports it as a *new* photograph while
the original row stays flagged forever: one duplicate per binned photo, per sync.

The exclusion becomes what it always meant:

> **A path claimed by a binned row is not the live catalogue's business.**

Concretely, in `syncLibrary`:

1. `binned = photos.listBinnedForSync(libraryId)` - id, `file_path`, `file_hash`,
   `date_updated`, `file_size` for `is_deleted = 1` rows. A scoped
   (watcher-driven) sync restricts it to binned rows whose **`file_path`** is one
   of the scoped paths, mirroring `listForSyncByPaths`.
2. The claimed paths are removed from `files` **before `scanFiles` runs**, and
   handled by the binned pass below instead.
3. `buildDiff` and `detectMoves` are untouched. They see a library with no binned
   files in it, which is the shape they were written for.

**Step 2 is before the scan, not after it, and that ordering is the whole cost
argument.** `scanFiles` decides what to open by looking each file up in
`dbByPath`, built from `dbPhotos` - which is `listForSync`, so it excludes every
binned row. A binned file therefore has no record, `unchanged` is false, and
`extract()` + `computeFileHash()` run on it (`sync_service.ts:956-963`).
Subtracting from `present` and `changed` *after* the scan would throw that work
away having already paid for it: a catalogue with 100k binned RAWs would decode
100k RAW headers every night, for ever.

`isPathAllowed` stops testing `bin_name`, so the bin is walked like any other
folder. That test does not simply vanish - it becomes an explicit
`isUnderBin(library, relPath)` beside `getBinPath`, which is the one place the bin
is spelled (`paths.ts:52`), and is reapplied at the callers that were relying on
`isPathAllowed` for something other than the scan:

- **`ShootsService.create`** (`shoots_service.ts:49`), whose own comment says why:
  "A folder the scan will never look at cannot hold a shoot: the bin … Its photos
  would be moved in and then never seen again." Without this the bin becomes a
  legal shoot target, and in a *writable* library `addPhotos` then moves live RAWs
  into it (`shoots_service.ts:141`) - after which §6 reads them as hand-binned.
  "Add to shoot" would silently bin the selection. `addPhotos`' destination gets
  the same check.
- **The in-library folder browser** (`libraries_api.ts:49`), or the bin becomes a
  pickable folder in the UI.
- **`dirs`, before shoot-relocation detection.** `detectRelocationsByIdentity`
  matches recorded shoot identities against every scanned directory
  (`sync_algorithm.ts:185-231`). Walking the bin puts bin folders in that set, so
  dragging a shoot folder into the bin by hand - a plain rename, inode and
  birthtime preserved - reads as a relocation, and `rewritePathPrefix` moves every
  one of that shoot's photos to a path inside the bin. Before this change `dirs`
  structurally could not contain a bin path.
- **`reconcileShootFolders`'s `withPhotos`** (`sync_service.ts:752-756`), plus its
  `stale` and `doomed` sets, or mirroring makes a shoot for every folder inside the
  bin - and since the bin mirrors the library's whole folder tree, that is a
  duplicate of the entire shoots tree.

This is a deliberate divergence from DESIGN §6's rule that the scan and the watcher
answer "what does this library contain" from one predicate, and DESIGN §9.8's claim
that they "cannot disagree". The bin becomes the one exception - walked by the scan,
still in the watcher's `ignore` list (`library_watcher.ts:217`) - because watching
it costs an inotify handle per directory in a tree that only grows. Hand-managed bin
changes are noticed by the daily full sync, which is what that sync is for. Both
DESIGN sections are amended to say so, or an implementer will "fix" the divergence
back.

## 6. The binned pass

With the bin walked, disk can speak about binning. Four rules, and the first three
run for **every** library, with or without a bin: an in-place binned file can be
deleted, changed or moved by the photographer exactly as a bin-moved one can.

### 6.1 Each claimed binned path is stat'd

The binned pass takes the paths step 2 removed from `files` and does for them what
the live scan does for the rest - which is the only way §6's other rules can know
anything, and the reason "not the live catalogue's business" cannot mean "never
looked at again":

| the file at the claimed path | result |
|---|---|
| absent | `is_missing = 1` |
| present, `mtime`+`size` match the row | clear `is_missing` if set; nothing else |
| present, `mtime`+`size` differ | re-hash and re-read metadata; update the row |

The middle row is not redundant. Without it a binned row flagged missing whose file
the photographer puts back keeps a `missing` badge for ever, because nothing else
would look at that path again. The third stops a *different* RAW appearing under a
binned name from being served, and restored, as the original - the live pass has
caught exactly that since it was written.

Setting `is_missing` on a binned row fixes a standing bug. Nothing can set it
today, because the scan never walks the bin, so a photograph whose RAW was deleted
out of the Bin folder still appears there with an original that 404s and nothing
on screen to explain it. The display side already works: `photo_grid.tsx:254`
renders the badge and the Bin page already uses `PhotoGrid`, which is why a photo
binned while *already* missing does show it. Only the flag was unreachable.

`listMissingForSync` and `listMissing` both filter `is_deleted = 0`, so a missing
binned photo stays out of the missing-photos view and is marked in the Bin instead.
That separation is deliberate: the missing view is a list of things to go and find,
and a binned photograph is not one.

### 6.2 A relocated binned file is followed, not re-imported

A binned row whose claimed path §6.1 found absent, paired against the additions the
live `detectMoves` left unpaired, is a binned file that moved. This is
`detectMoves` again, called a second time with the binned rows as the removed side.

**It runs before the apply transaction, and the additions it consumes are removed
from the set that gets inserted.** `result.added` is consumed inside the apply
(`sync_service.ts:425-428`), so a pass that ran afterwards would be pairing rows
that already exist: the file would be inserted as a new live photograph *and* have
the binned row re-pointed at it, leaving two rows claiming one path with no UNIQUE
to stop them (`idx_photos_file_path` is not unique, `migrations.ts:138`). One
permanent duplicate per hand-moved file. The pairing and the insert are one
decision, made where `detectMoves` already makes it with `usedAdded`
(`sync_algorithm.ts:141-164`).

The live pass always has first claim on an addition, so a photograph moved between
two live folders can never be swallowed by a binned row.

A scoped sync is asymmetric here and must not be: its additions come from whatever
the watcher named, while step 1 restricted `binned` to the scoped paths. If a move's
source event is coalesced away - which parcel does, and `MAX_SCOPE` truncation does
- the destination arrives as an addition with no binned row to pair it against, and
inserts a duplicate that no later sync can repair, because a binned row has no
cross-sync move-source pool (`listMissingForSync` filters `is_deleted = 0`).
**So: whenever a scoped sync has at least one unpaired addition left, it re-reads
the library's binned rows unrestricted before running this pass.** One query, only
when there is something to pair.

### 6.3 An unclaimed file under the bin is imported as already-binned

`is_deleted = 1`, and `deleted_from_path` derived by stripping the bin segment:
DESIGN §12.3's layout mirrors the folder a photo came from, so `<bin>/A/B/c.arw`
yields `A/B/c.arw` exactly. `<bin>/c.arw` yields `c.arw` - the same basename at the
library root, since `deleted_from_path` is a file path everywhere else too.

Such a row has no renditions and, because `PENDING_PROCESSING` excludes
`is_deleted = 1` (`photos_repository.ts:255`), nothing will queue any. The Bin page
shows a hole until the photograph is opened. Accepted: it is a file the app never
imported, and building renditions for something the photographer has already thrown
away is work nobody asked for.

### 6.4 Live and binned follow the file across the bin boundary

Only for a library whose `bin_name` is not `NULL`, and keyed on the **transition**,
not on the position:

| the file moved | result |
|---|---|
| from outside the bin to inside it | `markDeleted(id, oldPath)` - hand-binned |
| from inside the bin to outside it | `markRestored(id, newPath)` - hand-restored |
| an addition, under the bin | §6.3 |
| anything else | nothing |

**A transition, because a position would un-bin every in-place binning.** An
in-place binned row is `is_deleted = 1` with its file *outside* the bin, which is
indistinguishable by position from a photograph the photographer dragged out - so a
position rule would silently restore it, null its `deleted_from_path`, and (because
`markRestored` leaves `deleted_batch` set while clearing `is_deleted`) drop it from
its batch's undo, `idsDeletedInBatch` never resolving it again
(`photos_repository.ts:698`). A folder rename anywhere in a flipped library would be
enough to trigger it. The transition rule cannot: an in-place binned row that has
not crossed the boundary has not moved relative to it, so nothing fires.

Where "moved" comes from is the move pass, so this needs no extra bookkeeping: a
`MoveEntry` carries both paths, and §6.2's pairs carry both paths. A modified or
reappeared row has one path and therefore no transition.

`markDeleted` and `markRestored` already exist. Two caveats the spec leans on:
`markDeleted` zeroes `needs_tile`/`needs_renditions` (`photos_repository.ts:682`)
and `markRestored` does **not** set them back, so a row this pass bins and later
un-bins is live with no renditions and no pending flag - `repairGridTile` covers the
grid tile on open and the rest build on demand, so it is recoverable, and
`markRestored` gaining `needs_tile = 1` is the one-line fix. A reconcile-driven
binning carries no `deleted_batch`, so it is not part of anybody's undo.

### 6.5 What the counts say

Reconcile-driven binnings and restores count as `photosModified`, §6.2's pairs as
`photosMoved`, and §6.3's imports as `photosAdded`. `photo_count` needs nothing: it
is a subquery over `is_deleted = 0` (`libraries_repository.ts:23-28`), so it moves
for free.

## 7. Shoots

A shoot is a folder (DESIGN §4.3), and membership is decided by the folder a file
sits in (DESIGN §9.4). "Add these photographs to that shoot" therefore *is* a file
move, and there is no honest way to virtualise it: `reconcileShootFolders` restates
membership from the path whenever a new mirrored shoot appears
(`sync_service.ts:827`), so a database-only override would silently revert.

Read-only libraries therefore:

- **Create shoots only over folders that already exist.** `ShootsService.create`
  already distinguishes this case (`const existed = existsSync(absFolder)`); for
  a read-only library, `!existed` is a `READ_ONLY` error instead of an
  `ensureDir`. Mirroring already makes a shoot for every folder holding
  photographs, so in practice most shoots exist before anyone asks.
- **Refuse `addPhotos` and `removePhotos`** with `READ_ONLY`. The guard has to land
  before `ensureDir(destDir)` at `shoots_service.ts:124`, which runs outside the
  mutex. The UI hides the menu items rather than offering an action that cannot
  work, and the empty state points at albums.

Albums are the answer, and they need no changes at all: they are pure membership
rows, they already accept the same `PhotoTarget` shapes as shoots
(`albums_presenter.ts:69-74`), and they are already how a photograph belongs to
several groupings at once.

Everything else about shoots keeps working, because none of it touches disk:
renaming, descriptions, banner photos, ordering, deletion with `photos: 'keep'`
or `'remove'` (which writes a folder rule and removes rows - DESIGN §4.7 - and
never a file), and mirroring itself.

## 8. The sync lock becomes a table

**The lock protects the catalogue, not the tree, so it belongs in the catalogue.**
DESIGN §9.7 says as much - "the cross-process source of truth for *is this library
syncing*".

Be precise about what it does today, because it is less than it looks.
`syncLibrary` takes the lock and *then* enters `libraryMutex.run`, and the comment
there says why (`sync_service.ts:222-224`): "file lock first keeps sync-vs-sync
fail-fast (409), while the mutex makes file-moving mutations queue behind this
scan". So **in one process the correctness comes from `libraryMutex`** and the lock
only buys the 409. Its sole unique contribution is cross-process exclusion. There
are three callers, not two: `syncLibrary` (`:207`), and `rebuildStage` (`:566`),
which is not a sync at all - it holds the lock only for a claim (queue +
generation + status), and `sync_locks` has to serve that too.

Two processes with **separate** databases syncing one library are both read-only
against the tree: they scan, they hash, and each writes only into its own data
directory. Wasted effort, nothing corrupted. The hazard is two syncs racing over the
**same rows** - the diff and its application are not one transaction, so both can
decide a file is new and insert it twice - and that is by definition the
same-database case, which a table covers exactly.

```sql
CREATE TABLE sync_locks (
  library_id    TEXT PRIMARY KEY REFERENCES libraries(id) ON DELETE CASCADE,
  owner         TEXT NOT NULL,   -- UUID, one per ACQUIRE
  started_at    TEXT NOT NULL,   -- toISOString(), UTC
  refreshed_at  TEXT NOT NULL    -- toISOString(), UTC
);
```

`owner` is minted **per acquire, not per process**, and there is no `pid` column: a
PID is what §8.1 is about and a value no code reads does not earn a column. The
owner UUID is in the log line instead.

`started_at` and `refreshed_at` are `toISOString()` UTC strings, which is what makes
`refreshed_at < ?` a valid comparison - fixed width, zero-padded, no offset. That is
normative: a local-offset or variable-precision timestamp would silently make every
lease immortal or instantly stale.

`ON DELETE CASCADE` means a library removed mid-sync leaves no orphan row.

**Acquire** is one statement, so there is no check-then-claim window:

```sql
INSERT INTO sync_locks (library_id, owner, started_at, refreshed_at)
VALUES (?1, ?2, ?3, ?3)
ON CONFLICT(library_id) DO UPDATE SET
  owner = excluded.owner,
  started_at = excluded.started_at, refreshed_at = excluded.refreshed_at
WHERE sync_locks.refreshed_at < ?4;   -- the lease has expired
```

`changes()` is 1 when the lock was taken and 0 when a live holder kept it, which is
the `SYNC_IN_PROGRESS` case. SQLite's upsert is the compare-and-swap: the row is
read and written inside one statement, so this needs no `BEGIN IMMEDIATE` and
cannot lose a race the way a `SELECT` then `INSERT` in a deferred transaction would
- both readers there would see a stale lock and one would fail on upgrade.

**Expiry is the only way in.** An earlier draft also reclaimed a row whose `owner`
matched the asking process, reasoning that it must be a leftover from a restart.
With `owner` per process that clause defeated the lock for its own process: a manual
sync and a watcher sync in one server both matched, both got `changes() = 1`, and
the first to finish ran the owner-scoped release and **deleted the row from under
the one still running** - after which any other process could acquire cleanly and
race it. The rationale was circular, assuming the exclusion the lock is meant to
provide. A crashed run's row now expires like any other, and a restart waits out
the lease.

**Refresh**, every 10 seconds while the scan and apply run:

```sql
UPDATE sync_locks SET refreshed_at = ?2 WHERE library_id = ?1 AND owner = ?3;
```

Owner-scoped, so a stalled heartbeat cannot resurrect a lock somebody else has
taken over.

**Release** is `DELETE FROM sync_locks WHERE library_id = ?1 AND owner = ?2`, also
owner-scoped, so a `finally` running late cannot delete a successor's lock.

**The lease covers the scan and the apply only**, and is released before the
detached processing starts - exactly where the file lock is released today (DESIGN
§9.6). A 40-minute rendition build must not hold it.

**Timer lifecycle.** The refresh interval starts immediately after a successful
acquire and is cleared in the same `finally` that releases the lock. It is
`unref`'d, so it cannot hold the process open.

### 8.1 Liveness stops depending on the PID

The staleness check is broken today, independently of anything else in this
document, and moving the lock into the database does not fix it by itself: two
containers can share one `/config` volume and still have separate PID namespaces.
`ownerPid` reads the holder's PID and `pidAlive` asks `process.kill(pid, 0)` **in
the asking process's own PID namespace**, which is not the namespace the number
was minted in:

- Container A holds the lock as its PID 1. Container B checks PID 1, finds its own
  init, and concludes the lock is live. It refuses to sync **permanently** - not
  once, but every attempt, forever.
- Container A holds it as PID 37, which does not exist in B. B declares the lock
  stale, deletes it, and both sync at once - the exact interleaving the lock
  exists to prevent.

Which one happens depends on the number. It is not Docker-specific either: a PID
reused after a hard kill gives the same permanent refusal on a plain host.

A lease has no such ambiguity: a timestamp means the same thing in every namespace.
The cost is that reclaiming a crashed sync's lock takes up to 30 seconds rather
than being instant, which is invisible against a sync that runs on a 15-second
watcher debounce and a nightly schedule.

A lock held in a row also ends the question of whether to reach for `flock(2)`,
which would otherwise be the better answer for a file - the kernel releases it when
the holder dies, so there is no heuristic at all. Neither Node nor Bun exposes it,
and FFI to acquire a lock file was always more machinery than a 30-second window is
worth.

### 8.1.1 The lease is re-checked inside the apply transaction

The heartbeat alone does not make the lease safe, because the only way to lose one
while still running is the one way that also stops the heartbeat firing. Both live
on the same event loop as the sync, and the sync blocks it: `computeFileHash` is
synchronous, `statSync` in the walk, and the apply is one synchronous
`photos.transaction` over the whole diff (`sync_service.ts:392-443`) - minutes on a
large library. So:

1. Sync A is inside the apply. Heartbeat timers queue and cannot run.
2. 30 seconds pass. B sees the lease expired, acquires, and starts scanning from a
   `listForSync` snapshot that predates A's commit.
3. A's transaction commits its whole diff. *Then* A's heartbeat fires and finds
   `changes() === 0`, with nothing left to abort.

So the check that matters is not the heartbeat's: **the apply transaction re-reads
`SELECT owner FROM sync_locks WHERE library_id = ?` as its first statement and rolls
back on a mismatch.** Same transaction, so no window. A heartbeat reporting 0 changes
aborts the run through the same `AbortController` as `DELETE /api/libraries/:id/sync`
and raises `SYNC_IN_PROGRESS`; that is the polite path, and the in-transaction check
is the load-bearing one.

The batched first-scan path needs the same check per batch, because it commits
`INSERT_BATCH`-sized transactions as it goes (`sync_service.ts:275-287`). Batches it
already committed are **not** rolled back, and that is stated rather than hidden: a
first import that loses its lease leaves the photographs it had already inserted,
which the next sync reconciles.

### 8.2 Two containers sharing /config

This is the configuration the table has to be right for: two Bowerbird containers
over one library, both mounting the same `/config`, so both open the same SQLite
file. It works, and it is the case the file lock gets **wrong** today.

**SQLite's own locking is namespace-blind, which is the whole point.** It excludes
writers with `fcntl` advisory locks, and those live on the inode in the kernel -
not in a PID namespace, not in a process table. Two containers holding the same
inode through the same volume contend for the same lock, whatever either one calls
its own processes. That is exactly the property §8.1's PID number lacks and cannot
be given. Moving the lock into SQLite is not merely relocating it, it is handing the
mutual exclusion to something that can see both sides.

The pragmas this needs are already set (`connection.ts:10-12`): WAL, which is
cross-process on one host because both containers mmap the same `-shm` file off
the shared volume, and `busy_timeout = 5000`, so the loser of a write race waits
rather than failing.

**Sharing `/config` requires sharing `/data`.** This is a supported-configuration
statement, not advice. `needs_tile`, `needs_renditions` and `renditions_built_at`
are columns in the shared database; the rendition files are per-`DATA_DIR`. With
separate data directories, whichever container builds a rendition clears the flags
for both, `PENDING_PROCESSING` (`photos_repository.ts:255`) then excludes those rows
for everyone, and the other container serves 404s for `full` and `max` for ever with
nothing able to queue the work. The alternative is per-data-dir pending flags, which
these are not and should not become.

**Two containers are read-mostly.** They may both sync; only one may bin or move
photographs. `libraryMutex` is process-global (`library_mutex.ts:6-10`, whose own
comment names this gap), so it is what stops a bin move landing mid-scan - and it
cannot see the other container. With B binning while A scans, A's snapshot predates
B's commit and their diffs disagree about which row claims the bin path. Mutations
taking the lease and *waiting* rather than failing is the fix, and it is out of
scope here; until then, binning from two containers at once is unsupported.

What the two containers do on a sync, concretely: both watchers see the file change,
both debounce, one wins the upsert and syncs, the other's `changes()` is 0 and it
raises `SYNC_IN_PROGRESS`.

**The loser queues rather than giving up, and that is deliberate.** It re-records
its paths and re-arms (`library_watcher.ts:325-327`) so the retry stays scoped. The
reason is about timing, not identity: the holder's scan may have *started before*
the loser's change happened, in which case that scan will not see it, and a loser
that concluded "somebody else is syncing, so my change is covered" would drop it
silently until the nightly full sync.

**The redundant retry is close to free, by construction.** A scan decides what to
open by comparing each file's `mtime` and `size` against the row
(`sync_service.ts:957-959`), and the winner has already written the new values into
the database they share. So the loser's retry stats its handful of paths, finds every
one unchanged, opens nothing, hashes nothing, and applies an empty diff. The stat
pass is the cheap half of a scan and the hashing loop is the expensive one - this
skips the expensive one entirely.

So there is no case worth optimising, and one that argues against trying. Because
`sync_locks` is a row in the loser's *own* database, any lock it loses is
necessarily held by a process writing the same catalogue - information the file lock
could never give it. That still does not license skipping the retry: the holder may
be running a **scoped** sync over paths that do not include the loser's, in which
case it will not see the change however late it started. Skipping correctly would
mean recording the holder's scope in the lock row and comparing against it, which is
a column and a rule to save a few `stat` calls.

One clock, because one host. The lease compares timestamps written by whichever
process wrote them, so two hosts would need their clocks to agree - but two hosts
sharing `/config` means SQLite over a network filesystem, where WAL's shared memory
does not work and the database is unsafe regardless of anything in this document.
That configuration is unsupported, and was before the lock moved.

## 9. Removing a library

`removeDataDirectory` deletes `<DATA_DIR>/<library id>`, which is the app's own
directory and outside every root. Its rescue step - moving any original found in
there into the library's bin (`libraries_service.ts:42-48`) - is deleted with
`data_path` (§3.1): it existed for a `data_path` the photographer had aimed
somewhere unwise, and there is no such path any more. It also cannot survive, since
a read-only library has nowhere to rescue *to*.

`deleteDataDirectory`'s `findOriginalsAnywhere` check stays, now as an assertion
rather than a trigger. It costs a recursive walk of a directory that should hold
nothing but `<photoId>.avif` files, and it is worth it: `rm -rf` is the one call
here that cannot be undone, and losing renditions is recoverable where losing a RAW
is not. If it ever finds an original the removal is abandoned and the directory left
in place, which is what it already does.

## 10. What needs nothing

Verified against the code, not assumed. All of these are database rows or files
under the data directory:

Ratings, triage verdicts, notes, albums and album membership, stacks and
auto-stacking, shoot names/descriptions/banners/orderings, folder rules
(`excluded` and `plain`), every library and app setting, metadata refresh, the
scan, the watcher, rendition building, the orphan sweep, and the quality-check
page (`tmpdir`).

Not the HDR-check page: it was removed (DESIGN §10.7), and no route, presenter or
writer for it exists. The `hdr/` sweep target in `GENERATED_DIRS` is its last
trace.

Raw editing parameters are not persisted anywhere at all today, so there is
nothing for a read-only library to fail at. When they are persisted, they belong
in the database, and this design is the reason to say so now rather than in a
sidecar beside the RAW.

## 11. Errors

`ErrorCode` gains `READ_ONLY`, mapped to **403**. Distinct from
`VALIDATION_ERROR` because the request is well-formed and would have succeeded
against another library, and the client needs to tell the photographer *why* it
was refused rather than that they typed something wrong.

Raised by: `ShootsService.create` for a folder that does not exist,
`ShootsService.addPhotos`, `ShootsService.removePhotos`, `PhotosService.restore`
and undo for a row whose file is inside the bin (§4), `LibrariesService.create`
for `read_only: false` over a root that fails the probe, and
`LibrariesService.update` when clearing `read_only` on a root that fails it.

Not raised by binning: that succeeds, differently.

## 12. API and schema

```ts
// schemas/libraries.ts
LibrarySchema           read_only: z.boolean().default(false)
                        bin_name: z.string().nullable()
                        // data_path: gone
CreateLibraryRequest    read_only: z.boolean().default(false)
                        bin_name: BinNameSchema.nullable().default('Bin')  // forced to null when read_only
                        // data_path: gone
UpdateLibraryRequest    read_only: z.boolean().optional()
                        bin_name: BinNameSchema.optional()   // only while stored is null, and only
                                                             // in a request that also clears read_only
```

```ts
// config.ts - alongside port, host, dbPath
dataDir: path.resolve(process.env.DATA_DIR ?? './data')
```

`GET /api/browse` listings gain **one** `writable: boolean` for the folder being
listed, from `access(W_OK)` (§2.1). Child entries carry no probe.

`POST /api/libraries` stops accepting `data_path`; a client that still sends one
gets it ignored rather than rejected, since it named a location the app no longer
has a concept of. It forces `bin_name` to `null` when `read_only` is set, for the
same reason.

The existing "root already holds a folder named `bin_name`" refusal applies only
when a `bin_name` is supplied - a read-only create has none to collide with.

## 13. UI

**Add-library dialog** (`add_library_dialog.tsx`) gains one checkbox, *Don't
change anything in this folder*, ticked and disabled with an explanation when the
listing reports `writable: false`. When it is ticked, the bin-name field is
hidden, because there is no bin.

**Settings** shows the flag per library, with the consequences named: no bin
folder on disk, and shoots that follow the folders as they are. Clearing it asks
for a bin name.

**Bulk bar and the Bin page** keep their labels - the photograph *is* binned, and
that is the word for it - but the Bin page's line about the files
(`bin_page.tsx:23`, "The RAW files still exist, moved into a Bin folder on disk")
is false for a read-only library and must read off the library: moved into
`<bin_name>` when there is one, left exactly where they were when there is not.
Either way it stays a statement about where to find the RAW, which is what that
line is for. A binned photograph whose file has moved carries the `missing` badge
until a sync pairs it (§6.2).

**Photo actions** hide *Add to shoot* and *Remove from shoot* for a read-only
library. *Add to album* is unaffected and is the thing to reach for.

## 14. Schema, not migration

**Nothing migrates.** There are no installs to carry forward - only a dev
catalogue, which gets recreated - so every change here is an edit to `SCHEMA` in
`db/migrations.ts`: no `ensureColumn` step, no table rebuild, and no data move
anywhere in this document.

In `libraries`: add `read_only INTEGER NOT NULL DEFAULT 0`, make `bin_name TEXT`
nullable (drop `NOT NULL DEFAULT 'Bin'`), delete `data_path`. Plus `sync_locks`
(§8) as a new table.

A `sync_locks` row present at startup means "stale within 30 seconds", not
"syncing": a crashed process leaves its row, and expiry is what clears it (§8).
Startup deletes nothing.

Not doing this the migration way is the point. A relocation of every rendition in
the catalogue, a rebuild of `libraries` to drop a column SQLite will not drop in
place, and the tests to prove both - all of it exists only to spare a database that
can simply be deleted instead.

The same argument reaches further than this document. `db/migrations.ts` carries
eleven incremental migrations, several of them substantial - `migrateShootsToFolderUniqueness`
is a full table rebuild (`:347-397`), `halveQuantizersLibavifWasAlreadyHalving` is
stamped through `PRAGMA user_version`, and there are `migrateThumbnailsToRenditions`,
`migrateSelectedToTriage`, `migrateProcessingStages`, `splitRawDenoiseIntoLumaAndChroma`,
`dropRenditionHdrVideo`, `dropSupersededOrderingIndexes`, `requireLibraryNames` and
`renamePreviewColumnsToRenditions` besides. None of them is holding up a live
catalogue either. Folding the lot into `SCHEMA` is a bigger change than this one and
a call worth making deliberately rather than as a side effect.

## 15. Testing

Unit, against the existing service tests:

- Binning a read-only library moves nothing, sets `is_deleted`, and leaves
  `file_path` equal to `deleted_from_path`.
- Restoring an in-place binned photo renames nothing. Asserted by listing the
  directory: the regression is a silent `a_1.arw` rename, so a test on the row
  alone would pass while the file moved.
- Restoring a photo whose file is inside the bin of a read-only library throws
  `READ_ONLY`, and an undo batch containing one is refused whole.
- A binned path is subtracted before `scanFiles`, not after: a sync of a library
  with binned photos opens none of them. Asserted by spying on the metadata
  extractor, because the row-level assertions pass either way and the cost is the
  whole point.
- §6.1's three arms: absent sets `is_missing`; a file put back **clears** it;
  a different file at a claimed binned path is re-hashed.
- §6.2 pairs before the apply: a hand-moved binned file leaves **one** row, not a
  duplicate plus a re-pointed original. This is the corruption that a
  pass-after-apply would cause, so it is asserted on the row count for that path.
- §6.2's scoped case: a scoped sync whose only event is a move's destination still
  pairs against the library's binned rows.
- §6.3: an unclaimed file under the bin arrives `is_deleted = 1` with
  `deleted_from_path` stripped of the bin segment, and `<bin>/c.arw` yields `c.arw`.
- §6.4 as a transition: a live file moved into the bin becomes binned; a binned
  file moved out becomes live; **an in-place binned photo whose folder is renamed
  stays binned**, keeps `deleted_from_path`, and stays resolvable by its batch.
  That last one is the test for the bug a position rule would introduce.
- A library with `bin_name = null` sees §6.4 not run at all, but still sees §6.1
  and §6.2.
- Mirroring over a library with a populated bin makes no shoot inside the bin, and
  a shoot folder dragged into the bin by hand is **not** followed as a relocation.
- `ShootsService.create` refuses a folder under the bin, in a writable library too.
- `create`, `addPhotos` and `removePhotos` on a read-only library's shoots throw
  `READ_ONLY`; renaming one does not.
- A lock row whose `refreshed_at` is 31 seconds old is reclaimed; one 5 seconds old
  is not. **Two acquires from one process do not both succeed** - the test for the
  own-owner clause this design removed, and the case that would silently
  double-insert.
- A release cannot delete a row another `owner` now holds.
- An apply transaction whose lock row has changed `owner` rolls back and writes
  nothing (§8.1.1).
- Deleting a library mid-sync leaves no `sync_locks` row (the cascade).
- `getDataPath` resolves under `DATA_DIR` for a writable library as much as a
  read-only one, and is absolute regardless of the process's working directory.
- `DATA_DIR` inside a library root is refused, and a library root inside `DATA_DIR`
  is refused, at creation and at startup.
- Clearing `read_only` without a bin name is refused; naming a `bin_name` that
  already exists as a folder at the root is refused; with a fresh one it sticks.
- A stale `.bowerbird-write-test-*` file does not make a writable root report
  read-only.

Integration (`test/integration`): a read-only library over a fixture tree with
the directory permissions actually dropped, so a stray write fails the test
rather than passing unnoticed. Sync, bin, restore, undo, rate, stack, album. This
is the highest-value test in the document.

Also integration, for §8.2: **two processes over one database file**, not two
`Database` handles in one process. Only a second process exercises what the file
lock got wrong - `fcntl` locks are per-inode and would be invisible to a test that
shares a process. Both are pointed at one fixture library and told to sync at once;
exactly one wins, the loser raises `SYNC_IN_PROGRESS`, and the photo count
afterwards is the file count rather than twice it. That last assertion is the one
that matters: double insertion is the corruption the lock exists to prevent, and it
is the thing a same-process test cannot see.

And one for the loser's retry: after the winner finishes, the loser's re-armed sync
adds, removes and modifies nothing.

E2E: one spec adding a read-only library, binning a selection, checking the Bin,
restoring, and confirming the tree on disk is byte-identical to what it was. The
browse probe writing nothing (§2.1) is what makes that assertion meaningful rather
than dependent on which folders the dialog visited.

## 16. Known limitations

Stated so they are choices rather than surprises:

- No bin folder to open in Finder or Explorer. A binned photograph is visible in
  the app and untouched on disk, and nowhere else.
- Photographs cannot be moved into or out of shoot folders. Albums cover the
  grouping; the folders stay as they are.
- §6.2 pairs on `file_hash`, which is a digest of extension, dimensions, mtime,
  colour space, size and orientation rather than of pixels (`hash.ts:7-21`), so two
  byte-identical copies of one RAW collide by construction. A binned row whose file
  was hand-deleted can therefore be paired against a fresh import of the same frame
  and follow it. This is not new - the live `detectMoves` has always had it - but
  §6.2 extends it to binned rows.
- Two instances with separate databases no longer exclude each other's syncs. Costs
  duplicated scanning and nothing else (§8).
- Two instances sharing `/config` must share `/data`, and only one of them may bin
  or move photographs (§8.2).
- Reclaiming a crashed sync's lock takes up to 30 seconds instead of being
  instant, and a first import that loses its lease leaves its already-committed
  batches behind (§8, §8.1.1).
- Hand-managed bin changes are noticed by the daily full sync, not within a
  watcher debounce (§5).
- A file imported already-binned (§6.3) has no renditions and nothing will queue
  any; the Bin page shows a hole until it is opened.
- An unreadable file in the bin is re-opened and re-failed on every sync, since it
  never reaches `changed` and so never becomes claimed.
- Any catalogue that predates this is not carried forward. It is recreated (§14),
  which is only free while there is one dev instance and stops being free the
  moment there is a user. Legacy `<root>/.bowerbird` trees are left on disk for the
  photographer to delete (§3.1).
- A photographer who moves a binned file *out* of a read-only library's tree
  entirely leaves a binned row marked `is_missing`, with no way for the app to
  know it was deliberate.
