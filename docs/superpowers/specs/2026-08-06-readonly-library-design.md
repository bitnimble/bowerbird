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

Terms, used exactly and only this way throughout:

| term | meaning |
|---|---|
| **read-only** | the library's `read_only` flag is set: the app writes nothing under `root_path` |
| **the bin** | the folder `<root_path>/<bin_name>`, when the library has a `bin_name` |
| **binned** | `is_deleted = 1`, whatever the file's position on disk |
| **in-place binning** | binned with no move: `file_path` unchanged |
| **claimed** | a path some row's `file_path` names |
| **hand-binned** | a file the photographer moved into the bin themselves, outside the app |

## 1. Scope

- A per-library `read_only` flag, probed at creation and changeable afterwards.
- Binning, restoring and undo, with no move on disk.
- The catalogue's own generated files relocated out of the library root.
- The scan's exclusion of binned files moved from the bin folder to the `photos`
  table, which also lets the bin be hand-managed (§5, §6). This applies to every
  library, read-only or not.
- Shoot creation restricted to folders that already exist; moving photographs
  into and out of shoot folders refused (§7).

Out of scope: read-only *photographs* within a writable library, per-folder
write permissions, exporting edited renditions anywhere (no export exists yet),
and importing into a read-only library from elsewhere.

## 2. The flag

A column on `libraries`:

```sql
read_only  INTEGER NOT NULL DEFAULT 0   -- the app writes nothing under root_path
bin_name   TEXT                         -- now nullable: NULL means this library has no bin
```

`bin_name` becoming nullable is load-bearing, not tidiness. `path.join(root, '')`
is `root`, so an empty-string bin name would make every path in the library test
as "under the bin", and §6's reconcile would flag the entire catalogue as binned.
`NULL` makes the type `string | null` and the compiler finds every site that has
to decide what a library with no bin does.

`read_only` and `bin_name` are independent, and both matter:

| `read_only` | `bin_name` | meaning |
|---|---|---|
| 0 | set | today's library |
| 1 | `NULL` | born read-only: nothing on disk records a binning, so the flag is the only truth |
| 1 | set | flipped to read-only: an existing bin holds RAWs the app put there, and is still honoured |
| 0 | `NULL` | never persists: unlocking a born-read-only library supplies a bin name in the same request (§2.2) |

### 2.1 Detecting a read-only root

At creation, `POST /api/libraries` probes the root: `openSync(path.join(root,
'.bowerbird-write-test'), 'wx')`, then close and unlink. `wx` is `O_CREAT |
O_EXCL`, so the probe cannot overwrite anything that happens to be at that path,
and a lingering test file from a killed process reads as `EEXIST` rather than as
an unwritable volume - which is the right answer either way, since a root the app
cannot create a file in is one it cannot bin into.

The folder browser exposes the same probe (`GET /api/browse` gains a `writable`
field per listing), so the Add-library dialog can tick and disable the read-only
checkbox the moment the photographer stands on an unwritable folder, with the
reason shown rather than a create that fails.

The probe runs at creation and when the flag is cleared, and never again. A volume
remounted read-only afterwards surfaces as an `IO_ERROR` from the write that
fails, which is what it is.

### 2.2 Changing it afterwards

`PATCH /api/libraries/:id` accepts `read_only`, both directions.

**Setting it** keeps `bin_name`. Files already in the bin stay there, their rows
keep pointing at them, and the bin keeps being reconciled against disk (§6) - so
the photographer can go on emptying, refilling or reorganising that folder by
hand. New binnings from that point are in-place (§4).

**Clearing it** requires a `bin_name` if the library has none, supplied in the
same request. The probe (§2.1) runs first and the request is refused if the root
is not writable. Photographs already binned in place stay where they are, still
flagged: nothing sweeps them into the newly-named bin, because moving a
photographer's files as a side effect of a settings change is precisely what this
feature exists to avoid.

`bin_name` remains impossible to *change*. It can go from `NULL` to a name, once,
and never from one name to another - renaming it would strand every already-binned
RAW, which is why it is create-only today.

## 3. Where the catalogue's own files go

`data_path` defaults to `<root_path>/.bowerbird` (`paths.ts:15`), which a
read-only library cannot have. At creation, a read-only library with no explicit
`data_path` gets one written into the row:

```
<dirname(config.dbPath)>/libraries/<library id>
```

Stored explicitly rather than derived, so every existing reader of
`getDataPath()` is untouched and the location does not move if `DB_PATH` changes
later. The database's own directory is the app's data directory by definition -
it is what `DB_PATH` already means in Docker and in the Tauri build.

`assertNoDataDirectoryOverlap` gains one rule: a `data_path` inside a read-only
root is refused, since the app could not create it.

Everything else follows: renditions, HDR checks and the orphan sweep all address
`data_path` and need no change at all. The quality-check page already writes to
`tmpdir`.

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

`restore` needs an explicit branch and cannot merely skip the move.
`moveIntoDir(from, dirname(from), basename(from))` claims the name the file
already holds, hits `EEXIST`, and walks its suffix loop to mint `a_1.arw` - a
duplicate original, in a library the app is not supposed to be writing to at all.
Read-only restore is `markRestored(id, photo.file_path)` and nothing else.

Undo by batch (`deleted_batch`) needs no change: it resolves ids and calls
`restore`.

Renditions are kept, exactly as they are for a bin move (§12.1), which is what
keeps the Bin page browsable.

## 5. The exclusion moves from the folder to the table

Today two facts conspire to keep a binned file out of the catalogue:
`listForSync` selects only `is_deleted = 0` rows (`photos_repository.ts:739`),
and the scan skips the bin folder by name (`scope.ts:59`). The file is invisible
because it is somewhere the walk does not go. Remove the move and the file is in
scope with no row to match, so every sync imports it as a *new* photograph while
the original row stays flagged forever: one duplicate per binned photo, per sync.

The exclusion becomes what it always meant:

> **A path claimed by a binned row is not the live catalogue's business.**

Concretely, in `SyncService.run`:

1. `binned = photos.listBinnedForSync(libraryId)` - id, `file_path`, `file_hash`
   for `is_deleted = 1` rows. For a scoped (watcher-driven) sync, restricted to
   the paths in scope, mirroring `listForSyncByPaths`.
2. The claimed paths are subtracted from `presentPaths` and from `changed` before
   `buildDiff` runs.
3. `buildDiff` and `detectMoves` are untouched. They see a library with no binned
   files in it, which is the shape they were written for.

`isPathAllowed` stops skipping `bin_name`, so the bin is walked like any other
folder. Two things improve for writable libraries as a side effect:

- A folder of the photographer's own called `Bin`, adopted by a library that
  named its bin something else, is no longer silently dropped from the import.
  That hole is why `POST /api/libraries` refuses a root already holding a folder
  of the chosen bin name, and why the Add-library dialog has a field to work
  around it. The refusal stays (it is still true that the app is about to take
  that folder over) but it is no longer the only thing standing between the
  photographer and quietly missing photographs.
- The bin's contents become observable, which is what §6 is built on.

Costs, both real and both accepted:

- **The first full sync after this ships hashes every already-binned file once.**
  A file with no row is always "changed", so it is opened, hashed and has its
  metadata read. From the second sync on they are claimed and subtracted at step
  2, so they are never opened again. One-off, proportional to the bin.
- **`reconcileShootFolders` must exclude bin paths from `withPhotos`**
  (`sync_service.ts:753-759`), or mirroring makes a shoot for every folder inside
  the bin - which, since the bin mirrors the library's whole folder tree, is a
  duplicate of the entire shoots tree.

The watcher keeps ignoring the bin (`library_watcher.ts:217`). Its reasoning
holds: the bin only grows, and watching it costs an inotify handle per directory
inside it. Hand-managed bin changes are therefore noticed by the daily full sync
rather than within a debounce window, which is what that sync is for.

## 6. Reconciling the bin against the flag

With the bin walked, disk can finally speak about binning, and it does so as a
reconcile rather than as a report. After the diff and the moves are applied, for
every row **this sync touched** (added, moved, modified or reappeared - a row
nobody touched cannot have changed sides), and only for a library that has a
`bin_name`:

| situation | result |
|---|---|
| row's `file_path` is under the bin, `is_deleted = 0` | `markDeleted(id, origin)` - hand-binned |
| row's `file_path` is outside the bin, `is_deleted = 1` | `markRestored(id, file_path)` - hand-restored |
| both already agree | nothing |

`origin` is where the photograph came from, which `deleted_from_path` has to hold
for a restore to land: the path the file moved *from* when this sync paired a
move, and the bin-stripped path when the file was simply found sitting there.

`markDeleted` and `markRestored` already exist and already do the right thing,
including zeroing `needs_tile`/`needs_renditions` on the way in and clearing
`is_missing` and `deleted_from_path` on the way out. A reconcile-driven binning
carries no `deleted_batch`, so it is not part of anybody's undo.

A library with no `bin_name` has no bin, so this pass does not run and
`is_deleted` is only ever changed by the app. That is exactly right: nothing on
the disk of a born-read-only library can express a binning.

Note this keys on `bin_name`, not on `read_only`. A library flipped to read-only
keeps its bin and keeps being reconciled, which is what makes "let me manage that
folder myself" work after the flip.

Two further rules complete the picture:

**A relocated binned file is followed, not re-imported.** A binned row whose
claimed path is no longer on disk, paired against the leftover additions by
`file_hash`, is a binned file that moved - within the bin, or out of it. This is
`detectMoves` again, called a second time with the binned rows as the removed
side and the leftover additions as the added side. No new algorithm, and the
pairing rules (album bias, duplicate handling) come along for free. The pair
applies as `setFilePath` on the binned row, after which the table above decides
whether it is still binned.

**An unclaimed file under the bin is imported as already-binned.** `is_deleted =
1`, and `deleted_from_path` derived by stripping the bin segment from its path:
§12.3's layout mirrors the folder a photo came from, so `<bin>/A/B/c.arw` yields
`A/B/c.arw` exactly. A file dropped in the bin root yields the library root,
which is the best available answer and is where a restore will put it.

**A binned row whose file has gone gets `is_missing = 1`.** Today this is
unobservable, so the Bin page shows a photograph whose original 404s with nothing
to explain it. `listMissingForSync` and `listMissing` both filter `is_deleted =
0`, so a missing binned photo does not appear in the missing-photos view; it
appears in the Bin, marked. `restore` already refuses it with a clear message.

## 7. Shoots

A shoot is a folder (§4.3), and membership is decided by the folder a file sits
in (§9.4). "Add these photographs to that shoot" therefore *is* a file move, and
there is no honest way to virtualise it: `reconcileShootFolders` restates
membership from the path whenever a new mirrored shoot appears
(`sync_service.ts:827`), so a database-only override would silently revert.

Read-only libraries therefore:

- **Create shoots only over folders that already exist.** `ShootsService.create`
  already distinguishes this case (`const existed = existsSync(absFolder)`); for
  a read-only library, `!existed` is a `READ_ONLY` error instead of an
  `ensureDir`. Mirroring already makes a shoot for every folder holding
  photographs, so in practice most shoots exist before anyone asks.
- **Refuse `addPhotos` and `removePhotos`** with `READ_ONLY`. The UI hides the
  menu items rather than offering an action that cannot work, and the empty state
  points at albums.

Albums are the answer, and they need no changes at all: they are pure membership
rows, they already accept the same `PhotoTarget` shapes as shoots
(`albums_presenter.ts:69-74`), and they are already how a photograph belongs to
several groupings at once.

Everything else about shoots keeps working, because none of it touches disk:
renaming, descriptions, banner photos, ordering, deletion with `photos: 'keep'`
or `'remove'` (which writes a folder rule and removes rows - §4.7 - and never a
file), and mirroring itself.

## 8. The sync lock

`acquireSyncLock` writes `<root>/.bowerbird-sync.lock`. For a read-only library
it writes `<data_path>/.bowerbird-sync.lock` instead.

This is a real reduction in what the lock guarantees, and it should be recorded
rather than glossed. The lock is at the root because that is the one path two
independent server processes are certain to share; two servers with their own
databases also have their own `data_path`, so a lock there no longer excludes
them. A read-only library shared by two servers is protected only by each
server's in-process `libraryMutex`.

The tradeoff is acceptable because the thing the lock protects against is two
syncs interleaving their *writes*, and a read-only library's sync writes nothing
under the root. Two concurrent scans of the same read-only tree waste effort;
they cannot corrupt anything.

`deleteSyncLockSync` guards on the basename only, so it needs no change.
`library_watcher.ts:216` ignores the lock at the root; it must also ignore the
one in `data_path`, which it already does by ignoring `data_path` wholesale.

## 9. Removing a library

`removeDataDirectory` deletes `data_path`, which for a read-only library sits
outside the root and is therefore fine. Its rescue step is not: it moves any
original found under the data directory into the library's bin
(`libraries_service.ts:45-46`), which writes to the root.

For a read-only library there should be nothing to rescue - the data directory
was created by this app, outside the root, and only ever held generated files.
If `findOriginalsAnywhere` finds one anyway, the removal is abandoned with a
warning and the directory left in place, which is what `deleteDataDirectory`
already does when a rescue leaves something behind. Losing renditions is
recoverable; writing a RAW into a library the photographer asked the app not to
touch is not.

## 10. What needs nothing

Verified against the code, not assumed. All of these are database rows or files
under `data_path`:

Ratings, triage verdicts, notes, albums and album membership, stacks and
auto-stacking, shoot names/descriptions/banners/orderings, folder rules
(`excluded` and `plain`), every library and app setting, metadata refresh, the
scan, the watcher, rendition and HDR-check building, the orphan sweep, and the
quality-check page (`tmpdir`).

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
`ShootsService.addPhotos`, `ShootsService.removePhotos`, and
`LibrariesService.update` when clearing `read_only` on a root that fails the
probe.

Not raised by binning, restoring or undo: those succeed, differently.

## 12. API and schema

```ts
// schemas/libraries.ts
LibrarySchema           read_only: z.boolean().default(false)
                        bin_name: z.string().nullable()
CreateLibraryRequest    read_only: z.boolean().default(false)
                        bin_name: BinNameSchema.nullable().default('Bin')  // forced to null when read_only
UpdateLibraryRequest    read_only: z.boolean().optional()
                        bin_name: BinNameSchema.optional()   // accepted only while the stored value is null
```

`GET /api/browse` listings gain `writable: boolean` per directory entry, from the
probe in §2.1.

`POST /api/libraries` forces `bin_name` to `null` when `read_only` is set, rather
than rejecting a supplied one: the field is simply not asked for, and a client
that sends it is not wrong so much as out of date.

## 13. UI

**Add-library dialog** (`add_library_dialog.tsx`) gains one checkbox, *Don't
change anything in this folder*, ticked and disabled with an explanation when the
probe says the folder is unwritable. When it is ticked, the bin-name field is
hidden (there is no bin), and a line states where the catalogue's own files will
be kept, since that is no longer inside the folder being added.

**Settings** shows the flag per library, with the consequences named: no bin
folder on disk, and shoots that follow the folders as they are. Clearing it asks
for a bin name.

**Bulk bar and the Bin page** keep their labels - the photograph *is* binned, and
that is the word for it - but the Bin page states that the files have not moved,
so nobody goes looking for a folder that was never made.

**Photo actions** hide *Add to shoot* and *Remove from shoot* for a read-only
library. *Add to album* is unaffected and is the thing to reach for.

## 14. Migration

One migration, in `db/migrations.ts`:

- `ALTER TABLE libraries ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0`
- `bin_name` to nullable. SQLite cannot drop a `NOT NULL`, so this is the
  table-rebuild the file already does elsewhere; existing rows keep their names
  and no existing library ever sees `NULL`.

No data migration. Every existing library is writable with a bin, which is
exactly the state the new columns describe.

The change in §5 needs no migration but does change behaviour for existing
libraries on their next full sync: the bin is walked, its files are matched to
the rows already claiming them, and only genuinely unclaimed files - which means
hand-binned ones - are imported. A library whose bin the photographer has never
touched sees no row change at all, at the cost of one pass of hashing.

## 15. Testing

Unit, against the existing service tests:

- Binning a read-only library moves nothing, sets `is_deleted`, and leaves
  `file_path` equal to `deleted_from_path`.
- Restoring a read-only library mints no `_1` suffix. This is the regression that
  justifies the explicit branch, so it is asserted by filename.
- A binned path is subtracted from the diff: a sync of a read-only library with
  one binned photo adds nothing and removes nothing.
- A file under the bin claimed by nobody arrives as `is_deleted = 1` with
  `deleted_from_path` stripped of the bin segment.
- A live row whose file is found under the bin becomes binned; a binned row whose
  file is found outside it becomes live; a library with `bin_name = null` sees
  neither.
- A binned file moved within the bin keeps one row, moved `file_path`, still
  binned.
- A binned row whose file has gone becomes `is_missing`.
- Mirroring over a library with a populated bin makes no shoot inside the bin.
- `create`, `addPhotos` and `removePhotos` on a read-only library's shoots throw
  `READ_ONLY`; renaming one does not.
- Clearing `read_only` without a bin name is refused; with one, it sticks.

Integration (`test/integration`): a read-only library over a fixture tree with
the directory permissions actually dropped, so a stray write fails the test
rather than passing unnoticed. Sync, bin, restore, undo, rate, stack, album.

E2E: one spec adding a read-only library, binning a selection, checking the Bin,
restoring, and confirming the tree on disk is byte-identical to what it was.

## 16. Known limitations

Stated so they are choices rather than surprises:

- No bin folder to open in Finder or Explorer. A binned photograph is visible in
  the app and untouched on disk, and nowhere else.
- Photographs cannot be moved into or out of shoot folders. Albums cover the
  grouping; the folders stay as they are.
- Cross-process sync exclusion degrades to per-`data_path` (§8).
- Hand-managed bin changes are noticed by the daily full sync, not within a
  watcher debounce (§5).
- The first full sync after this ships hashes every already-binned file once
  (§5).
- A photographer who moves a binned file *out* of a read-only library's tree
  entirely leaves a binned row marked `is_missing`, with no way for the app to
  know it was deliberate.
