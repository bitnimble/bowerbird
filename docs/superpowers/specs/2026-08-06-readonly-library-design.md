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
- Shoot creation restricted to folders that already exist; moving photographs
  into and out of shoot folders refused (§7).

Three of the changes it needs turn out to be worth making for **every** library,
read-only or not, and this document specifies them that way. Each stands alone and
each fixes something already wrong:

- **Generated files leave the library root**, `data_path` is deleted, and config
  and data get separate directories (§3). Removes four guards that only existed to
  survive a user-supplied path.
- **The scan's exclusion of binned files moves from the bin folder to the `photos`
  table** (§5), which closes a hole where a library adopting a folder called `Bin`
  silently drops its photographs, and lets the bin be hand-managed (§6).
- **The sync lock becomes a leased row** (§8), because it protects the catalogue
  rather than the tree, and because its PID-based staleness check is wrong across
  containers today (§8.1).

After all three, a read-only library needs no special case for its data directory
and none for its lock. What is left that is genuinely about `read_only` is §2, §4
and §7.

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
hand. New binnings from that point are in-place (§4). Nothing else happens: with
`data_path` gone (§3) the flip moves no files and touches no other column, which
is the whole of what it used to have to arrange.

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

Generated files leave the library root **for every library**, read-only or not,
and `data_path` is deleted.

Two locations, both the app's, neither inside anybody's photographs:

| | holds | env | Docker |
|---|---|---|---|
| **config** | the SQLite database | `DB_PATH` | `/config` |
| **data** | every generated file, per library | `DATA_DIR` | `/data` |

```
/config/bowerbird.db
/data/<library id>/renditions/<rendition>-<sdr|hdr>/<photoId>.avif
/data/<library id>/hdr/…
```

`getDataPath(library)` becomes `path.join(config.dataDir, library.id)`. Split
from the database because they want different volumes: the catalogue is megabytes
and wants to be backed up, and renditions are the bulk of the footprint and want
bulk storage. Pointing `/data` at a spinning disk while `/config` stays on an SSD
is then a compose line rather than a schema field.

The Bin does not move. Originals belong beside the photographs they came from
(§12.3), and `<root>/<bin_name>` is still exactly where a photographer expects to
find a RAW they deleted.

### 3.1 What this deletes

A user-supplied `data_path` was the source of a whole family of hazards, and each
guard against them goes with it:

- **`assertNoDataDirectoryOverlap`** (`libraries_service.ts:118-129`) and its
  tests. Its entire job was refusing a `data_path` that would swallow another
  library's root, or a root sitting inside one. An app-owned directory keyed by
  library id cannot do either.
- **The data-directory rule in `isPathAllowed`** (`scope.ts:69-71`) and
  `LibraryScope.resolvedDataPath` with it. Nothing generated is under the root any
  more. A legacy `<root>/.bowerbird` left behind on disk is still skipped, by the
  dotfolder rule that was always covering it anyway.
- **The "it contains the library root" guard** in `removeDataDirectory`
  (`libraries_service.ts:37-40`).
- **The rescue-originals-to-the-Bin step** (`libraries_service.ts:42-48`), which
  existed for a pre-Bin-move `<data_path>/bin` and for a `data_path` aimed at the
  photographer's own files. `deleteDataDirectory`'s `findOriginalsAnywhere` check
  stays as the assertion that this is now impossible, rather than as a rescue.
- **`data_path` threaded through queries and signatures**: `dataPathFor`, the
  column in `libraries`, the join in `photos_repository.ts:914`, and
  `processing_service.ts:486`, which reads `pending.root_path, pending.data_path`
  and needs only a library id.
- **§2's read-only special case for the data directory, and the whole of the
  flip-time relocation.** Nothing about `read_only` decides where generated files
  go, because that answer is now the same for every library.

One guard replaces all of it: `DATA_DIR` inside any library's root is refused at
library creation, since the scan would otherwise walk the app's own renditions.
One check against one path, not a pairwise comparison across every library.

### 3.2 Docker

```yaml
volumes:
  - "${PHOTOS_DIR:-./photos}:/photos:ro"   # :ro for a read-only library
  - bowerbird-config:/config
  - "${DATA_DIR:-bowerbird-data}:/data"    # point at bulk storage if you like
environment:
  DB_PATH: /config/bowerbird.db
  DATA_DIR: /data
```

`docker-compose.yml:20-23`'s comment needs rewriting either way: it currently
says renditions live in `<root>/.bowerbird`, which stops being true for every
library and not just read-only ones.

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

Two things this costs:

- **`reconcileShootFolders` must exclude bin paths from `withPhotos`**
  (`sync_service.ts:753-759`), or mirroring makes a shoot for every folder inside
  the bin - which, since the bin mirrors the library's whole folder tree, is a
  duplicate of the entire shoots tree.
- **An unclaimed file in the bin is opened, hashed and has its metadata read**,
  because a file with no row is always "changed". Only hand-binned files are ever
  unclaimed, and only once each: from the next sync on they are claimed and
  subtracted at step 2. A catalogue that binned everything through the app never
  pays this at all.

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

**A binned row whose file has gone gets `is_missing = 1`.** This fixes a standing
bug rather than adding a feature. Nothing sets the flag on a binned row today,
because the scan never walks the bin - so a photograph whose RAW the photographer
deleted out of the Bin folder still appears there, and its original 404s with
nothing on screen to explain why. The display side already works: `photo_grid.tsx:254`
renders a `missing` badge and the Bin page already uses `PhotoGrid`, which is why
a photo binned while *already* missing does show it. Only the flag was
unreachable.

`listMissingForSync` and `listMissing` both filter `is_deleted = 0`, so a missing
binned photo stays out of the missing-photos view and is marked in the Bin
instead. That separation is deliberate: the missing view is a list of things to
go and find, and a binned photograph is not one. `restore` already refuses a
missing file with a clear message.

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

## 8. The sync lock becomes a table

**The lock protects the catalogue, not the tree, so it belongs in the catalogue.**
DESIGN §9.7 says as much - "the cross-process source of truth for *is this library
syncing*" - and the code agrees: `acquireSyncLock` is taken by
`SyncService.run` and `syncAll` and by nothing else (`sync_service.ts:207,566`).
No bin move, no shoot move and no restore ever acquires it.

Which settles the question. Two processes with **separate** databases syncing one
library are both read-only against the tree: they scan, they hash, and each writes
only into its own data directory. Wasted effort, nothing corrupted. The hazard the
lock exists for is two syncs racing over the **same rows** - the diff and its
application are not one transaction, so two runs can both decide a file is new and
insert it twice - and that is by definition the same-database case, which a table
covers exactly.

So:

```sql
CREATE TABLE sync_locks (
  library_id    TEXT PRIMARY KEY REFERENCES libraries(id) ON DELETE CASCADE,
  owner         TEXT NOT NULL,   -- UUID, one per server process
  pid           INTEGER NOT NULL,-- for the log line only
  started_at    TEXT NOT NULL,
  refreshed_at  TEXT NOT NULL
);
```

`ON DELETE CASCADE` means a library removed mid-sync leaves no orphan row.

**Acquire** is one statement, so there is no check-then-claim window to reason
about:

```sql
INSERT INTO sync_locks (library_id, owner, pid, started_at, refreshed_at)
VALUES (?1, ?2, ?3, ?4, ?4)
ON CONFLICT(library_id) DO UPDATE SET
  owner = excluded.owner, pid = excluded.pid,
  started_at = excluded.started_at, refreshed_at = excluded.refreshed_at
WHERE sync_locks.owner = excluded.owner        -- our own, from a previous run
   OR sync_locks.refreshed_at < ?5;            -- the lease has expired
```

`changes()` is 1 when the lock was taken and 0 when a live holder kept it, which is
the `SYNC_IN_PROGRESS` case. SQLite's upsert is the compare-and-swap: the row is
read and written inside one statement, so this needs no `BEGIN IMMEDIATE` and
cannot lose a race the way a `SELECT` followed by an `INSERT` inside a deferred
transaction would - both readers there would see a stale lock and one would fail on
upgrade.

**Refresh**, every 10 seconds while the sync runs:

```sql
UPDATE sync_locks SET refreshed_at = ?2 WHERE library_id = ?1 AND owner = ?3;
```

Scoped to `owner` so a stalled heartbeat cannot resurrect a lock somebody else has
since taken over. `changes() === 0` means exactly that has happened - this process
was declared dead and another is now syncing the same library - so the sync
**aborts** rather than carrying on writing rows underneath the new holder. That
check is the reason the heartbeat is worth having at all, rather than only a
timestamp nobody reads back.

**Release** is `DELETE FROM sync_locks WHERE library_id = ?1 AND owner = ?2`, also
owner-scoped, so a `finally` running late cannot delete a successor's lock.

What this deletes: `sync_lock.ts`'s file handling, `SYNC_LOCK_NAME` and
`deleteSyncLockSync` from `deletions.ts`, the lock's entry in the watcher's ignore
list (`library_watcher.ts:216`) and the comment above it explaining that a sync's
own lock file used to wake the watcher that wrote it, and `.bowerbird-sync.lock`
as a thing that exists at all. It also removes one more write from the library
root for **every** library, which is the whole point of this document arriving at
a place where a read-only library needs no special case here either.

What is genuinely given up: two instances with separate databases no longer
exclude each other's syncs. Per the paragraph above, that costs duplicated
scanning and nothing else. Concurrent *file* moves from two instances were never
covered by this lock - `moveIntoDir`'s `link()`/`COPYFILE_EXCL` claim is what makes
those safe (`files.ts:7-10`), and it still is.

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

The replacement is a **lease**, which is why the table carries `owner` and
`refreshed_at`:

- `owner` is a UUID minted once per server process. A row whose `owner` matches
  this process's own is always reclaimable: that is a restart, and no other
  process can be holding it.
- `refreshed_at` is rewritten every 10 seconds while the sync runs. A lock is
  stale once `refreshed_at` is more than 30 seconds old.
- `pid` is kept for the log line only, and is never asked about.

No namespace assumptions and no PID reuse hazard. The cost is that reclaiming a
crashed sync's lock takes up to 30 seconds rather than being instant, which is
invisible against a sync that runs on a 15-second watcher debounce and a nightly
schedule.

A lock held in a row rather than in a file also ends the question of whether to
reach for `flock(2)`, which would otherwise be the better answer for a file - the
kernel releases it when the holder dies, so there is no staleness heuristic at all.
Neither Node nor Bun exposes it, and FFI to acquire a lock file was always more
machinery than a 30-second window is worth.

### 8.2 Two containers sharing /config

This is the configuration the table has to be right for: two Bowerbird containers
over one library, both mounting the same `/config`, so both open the same SQLite
file. It works, and it is the case the file lock gets **wrong** today.

**SQLite's own locking is namespace-blind, which is the whole point.** It excludes
writers with `fcntl` advisory locks, and those live on the inode in the kernel -
not in a PID namespace, not in a process table. Two containers holding the same
inode through the same volume contend for the same lock, whatever either one calls
its own processes. That is exactly the property §8.1's PID number lacks and cannot
be given: it means one thing in one namespace and something else in another. Moving
the lock into SQLite is not merely relocating it, it is handing the mutual exclusion
to something that can actually see both sides.

The pragmas this needs are already set (`connection.ts:10-12`): WAL, which is
cross-process on one host because both containers mmap the same `-shm` file off
the shared volume, and `busy_timeout = 5000`, so the loser of a write race waits
rather than failing. Nothing new to configure.

What the two containers then do, concretely: both watchers see the file change,
both debounce, one wins the upsert and syncs, the other's `changes()` is 0 and it
raises `SYNC_IN_PROGRESS`.

**The loser queues rather than giving up, and that is deliberate.** It re-records
its paths and re-arms (`library_watcher.ts:325-327`) so the retry stays scoped. The
reason is in the comment above that line and is about timing, not identity: the
holder's scan may have *started before* the loser's change happened, in which case
that scan will not see it, and a loser that concluded "somebody else is syncing, so
my change is covered" would drop it silently until the nightly full sync.

**The redundant retry is close to free, by construction.** A scan decides what to
open by comparing each file's `mtime` and `size` against the row
(`sync_service.ts:957-959`), and the winner has already written the new values into
the database they share. So the loser's retry stats its handful of paths, finds every
one unchanged, opens nothing, hashes nothing, and applies an empty diff. The stat
pass is the cheap half of a scan and the hashing loop is the expensive one - this
skips the expensive one entirely.

So there is no case worth optimising here, and one that argues against trying.
Because `sync_locks` is a row in the loser's *own* database, any lock it loses is
necessarily held by a process writing the same catalogue - which is new information
the file lock could never give it. That still does not license skipping the retry:
the holder may be running a **scoped** sync over paths that do not include the
loser's, in which case it will not see the change however late it started. Skipping
correctly would mean recording the holder's scope in the lock row and comparing
against it, which is a column and a rule to save a few `stat` calls.

Their rendition builds are idempotent whether `/data` is shared or not (the file is
the cache and the builder returns early on one that exists), and two prune sweeps
deleting the same orphan are both `force: true`.

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
somewhere unwise, and there is no such path any more.

`deleteDataDirectory`'s `findOriginalsAnywhere` check stays, now as an assertion
rather than a trigger. If it ever finds an original the removal is abandoned and
the directory left in place, which is what it already does. Losing renditions is
recoverable; deleting a RAW is not, and that asymmetry is worth one walk of a
directory that should never contain one.

## 10. What needs nothing

Verified against the code, not assumed. All of these are database rows or files
under the data directory:

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
                        // data_path: gone
CreateLibraryRequest    read_only: z.boolean().default(false)
                        bin_name: BinNameSchema.nullable().default('Bin')  // forced to null when read_only
                        // data_path: gone
UpdateLibraryRequest    read_only: z.boolean().optional()
                        bin_name: BinNameSchema.optional()   // accepted only while the stored value is null
```

```ts
// config.ts - alongside port, host, dbPath
dataDir: process.env.DATA_DIR ?? './data'
```

`GET /api/browse` listings gain `writable: boolean` per directory entry, from the
probe in §2.1.

`POST /api/libraries` stops accepting `data_path`. A client that still sends one
gets it ignored rather than rejected: it named a location the app no longer has a
concept of, and there is nothing to tell it to do instead.

`POST /api/libraries` forces `bin_name` to `null` when `read_only` is set, rather
than rejecting a supplied one: the field is simply not asked for, and a client
that sends it is not wrong so much as out of date.

## 13. UI

**Add-library dialog** (`add_library_dialog.tsx`) gains one checkbox, *Don't
change anything in this folder*, ticked and disabled with an explanation when the
probe says the folder is unwritable. When it is ticked, the bin-name field is
hidden, because there is no bin.

**Settings** shows the flag per library, with the consequences named: no bin
folder on disk, and shoots that follow the folders as they are. Clearing it asks
for a bin name.

**Bulk bar and the Bin page** keep their labels - the photograph *is* binned, and
that is the word for it - but the Bin page's line about the files (`bin_page.tsx:23`,
"The RAW files still exist, moved into a Bin folder on disk") is now false for a
read-only library and needs to read off the library: moved into `<bin_name>` when
there is one, left exactly where they were when there is not. Either way it stays
a statement about where to find the RAW, which is the question that line answers.

**Photo actions** hide *Add to shoot* and *Remove from shoot* for a read-only
library. *Add to album* is unaffected and is the thing to reach for.

## 14. Schema, not migration

**Nothing migrates.** There are no installs to carry forward - only a dev
catalogue, which gets recreated - so every change here is an edit to `SCHEMA` in
`db/migrations.ts` and there is no `ensureColumn` step, no table rebuild, and no
data move anywhere in this document.

In the `libraries` table:

- add `read_only INTEGER NOT NULL DEFAULT 0`
- `bin_name TEXT` - drop the `NOT NULL DEFAULT 'Bin'`
- delete `data_path`

Plus `sync_locks` (§8) as a new table. Nothing seeds it: an empty lock table is a
library nobody is syncing, which is true at startup.

Not doing this the migration way is the point. A relocation of every rendition
in the catalogue, a rebuild of `libraries` to drop a column SQLite will not drop
in place, and the tests to prove both - all of it exists only to spare a database
that can simply be deleted instead.

The same argument reaches further than this document: the incremental migrations
already in `db/migrations.ts` (`renamePreviewColumnsToRenditions` and the
`ensureColumn` run at the bottom of the file) are carrying a schema history that no
live catalogue is standing on either. Folding them into `SCHEMA` and deleting them
is a bigger and separate change, and it is a call worth making deliberately rather
than as a side effect of this one.

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
- A lock row whose `refreshed_at` is 31 seconds old is reclaimed; one 5 seconds
  old is not, whatever PID it names. A row naming a live PID belonging to another
  owner is still reclaimed once its lease expires - the test that pins §8.1's
  whole point, since it is the case that deadlocks today.
- A lock row carrying this process's own `owner` is reclaimed immediately.
- Two concurrent `syncLibrary` calls: the second throws `SYNC_IN_PROGRESS`, and
  the row is gone afterwards on both the success and the throw path.
- A refresh whose row has been taken over by another `owner` reports 0 changes and
  aborts its sync, rather than continuing to write rows under the new holder.
- A release cannot delete a row another `owner` now holds.
- Deleting a library mid-sync leaves no `sync_locks` row (the cascade).
- `getDataPath` resolves under `DATA_DIR` and nowhere near the library root, for a
  writable library as much as a read-only one.
- `DATA_DIR` inside a library root is refused at library creation.
- Clearing `read_only` without a bin name is refused; with one, it sticks.

Integration (`test/integration`): a read-only library over a fixture tree with
the directory permissions actually dropped, so a stray write fails the test
rather than passing unnoticed. Sync, bin, restore, undo, rate, stack, album.

Also integration, for §8.2: **two processes over one database file**, not two
`Database` handles in one process. Only a second process exercises what the file
lock got wrong - `fcntl` locks are per-inode and would be invisible to a test that
shares a process. Both are pointed at one fixture library and told to sync at once;
exactly one wins, the loser raises `SYNC_IN_PROGRESS`, and the photo count
afterwards is the file count rather than twice it. That last assertion is the one
that matters: double insertion is the corruption the lock exists to prevent, and it
is the thing a same-process test cannot see.

And one for the loser's retry: after the winner finishes, the loser's re-armed sync
adds, removes and modifies nothing. Asserted on the counts rather than on whether
files were opened, because the counts are what a duplicate would show up in.

E2E: one spec adding a read-only library, binning a selection, checking the Bin,
restoring, and confirming the tree on disk is byte-identical to what it was.

## 16. Known limitations

Stated so they are choices rather than surprises:

- No bin folder to open in Finder or Explorer. A binned photograph is visible in
  the app and untouched on disk, and nowhere else.
- Photographs cannot be moved into or out of shoot folders. Albums cover the
  grouping; the folders stay as they are.
- Two instances with separate databases no longer exclude each other's syncs.
  Costs duplicated scanning and nothing else, and concurrent file moves were never
  covered by that lock in the first place (§8).
- Reclaiming a crashed sync's lock takes up to 30 seconds instead of being
  instant, which is the price of not asking about PIDs (§8.1).
- Hand-managed bin changes are noticed by the daily full sync, not within a
  watcher debounce (§5).
- Any catalogue that predates this is not carried forward. It is recreated (§14),
  which is only free while there is one dev instance and stops being free the
  moment there is a user.
- A photographer who moves a binned file *out* of a read-only library's tree
  entirely leaves a binned row marked `is_missing`, with no way for the app to
  know it was deliberate.
