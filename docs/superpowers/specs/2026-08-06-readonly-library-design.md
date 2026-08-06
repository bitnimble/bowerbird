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
| **the live channel** | the existing walk and diff, over the library minus the bin, against `is_deleted = 0` rows |
| **the bin channel** | the same walk and diff, over the bin alone, against `is_deleted = 1` rows (§6) |
| **a crossing** | a move whose two halves land in different channels: the file entered or left the bin |
| **scoped sync** | a watcher-driven sync restricted to named paths, as against the nightly full sync |

## 1. Scope

- A per-library `read_only` flag, checked at creation and changeable afterwards.
- Binning, restoring and undo, with no move on disk.
- Shoot creation restricted to folders that already exist; moving photographs
  into and out of shoot folders refused (§7).
- The API, error and UI surfaces of those (§11-§13).

Five of the changes it needs turn out to be worth making for **every** library,
read-only or not, and this document specifies them that way. Each stands alone and
each fixes something already wrong:

- **Generated files leave the library root**, `data_path` is deleted, and config
  and data get separate directories (§3). Replaces five guards with one.
- **The scan's exclusion of binned files moves from the bin folder to the `photos`
  table** (§5), which is what a read-only library needs in place of the move.
- **Disk gets a say about binning** (§6): the bin gets its own walk, so a binned
  file that was deleted, changed or moved by hand is noticed instead of ignored, and
  a renamed bin folder is followed the way a renamed shoot folder already is. This
  makes `is_missing` reachable on a binned row, which it is not today.
- **`bin_name` stops being write-once** (§2.4): renaming it moves the folder, which
  is what the rule against renaming existed to avoid having to do.
- **The sync lock becomes a leased row** (§8), because it protects the catalogue
  rather than the tree, and because its PID-based staleness check is wrong across
  containers today (§8.1).

After all five, a read-only library needs no special case for its data directory
and none for its lock.

Out of scope: read-only *photographs* within a writable library, per-folder
write permissions, exporting edited renditions anywhere (no export exists yet),
and importing into a read-only library from elsewhere.

**Documents this supersedes**, each qualified because several of these numbers
collide with this document's own: DESIGN §4.1 (the `libraries` columns), DESIGN §6
(the data directory), DESIGN §9.1 (the scan, which gains a second channel), DESIGN
§9.7 (the whole sync lock), DESIGN §12.1 and DESIGN §12.3 (binning and the bin
folder), DESIGN §13.1 (the API surface) and DESIGN §15 (the testing plan). Nothing
this document contradicts is left standing there; DESIGN §9.7 in particular
describes a file that stops existing.

## 2. The flag

Two columns on `libraries`:

```sql
read_only  INTEGER NOT NULL DEFAULT 0   -- the app writes nothing under root_path
bin_name   TEXT                         -- now nullable: NULL means this library has no bin
```

`bin_name` becoming nullable is load-bearing, not tidiness. It is what tells the
app whether `<root>/<bin_name>` means anything, and `NULL` rather than `''`
because `path.join(root, '')` is `root` - an empty bin name would point the bin
channel at the whole library. `string | null` also makes the compiler find the
four `getBinPath` call sites that have to decide what a library with no bin does
(§2.3), one of which is deleted outright.

| `read_only` | `bin_name` | meaning |
|---|---|---|
| 0 | set | today's library |
| 1 | `NULL` | born read-only: nothing on disk can record a binning, so the flag is the only truth |
| 1 | set | flipped to read-only: an existing bin holds RAWs the app put there, and is still honoured |

`read_only = 0` with `bin_name IS NULL` never persists: unlocking a born-read-only
library supplies a bin name in the same request (§2.2).

### 2.1 Detecting a read-only root

**One mechanism, and it writes nothing:** `access(dir, W_OK)`. `GET /api/browse`
reports it as `writable` for the folder being listed - **one boolean per listing,
not one per child entry** - and `POST /api/libraries` checks the same thing for the
root being added.

Not a real write test, though `access` can be fooled by an exotic ACL: a root where
`access` lies is the same case as a volume remounted read-only later, and that one
already surfaces as an `IO_ERROR` from the write that fails. Writing nothing here is
also what makes §15's byte-identical assertion unconditional rather than dependent
on which folders the dialog visited.

A library created with `read_only: false` over a root that fails the check is
refused with `READ_ONLY`, not silently upgraded: the client supplied a `bin_name`
on the assumption the root was writable, and forcing the flag would discard it.

The check runs at creation and when the flag is cleared, and never again.

### 2.2 Changing it afterwards

`PATCH /api/libraries/:id` accepts `read_only`, both directions.

**Setting it** keeps `bin_name`. Files already in the bin stay there, their rows
keep pointing at them, and the bin channel keeps reconciling that folder against
disk (§6) - so the photographer can go on emptying, refilling or reorganising it by
hand. New binnings from that point are in-place (§4). Nothing else happens: with
`data_path` gone (§3) the flip moves no files and touches no other column.

**Clearing it** requires a `bin_name` if the library has none, in the same
request; a `PATCH` naming `bin_name` on its own is a `VALIDATION_ERROR`, because
`read_only = 1` with a `bin_name` and no bin folder on disk is a state the bin
channel would then point at a folder that does not exist. The `access` check
(§2.1) runs first and the request is refused if the root is not writable. The same
"a folder of that name already exists at the root" refusal `POST` applies
(`libraries_service.ts:76-81`) applies here too - without it, naming an existing
folder of photographs as the bin would move every row under it into the bin
channel.

Photographs already binned in place stay where they are, still flagged. Nothing
sweeps them into the newly-named bin, and nothing un-flags them: an in-place binned
file is not in the bin channel's walk, so the bin channel has no opinion about it
(§6.5).

`bin_name` stops being write-once. Renaming it **moves the folder** (§2.4), which is
what the old rule existed to avoid having to do.

### 2.3 What a library with no bin does

`getBinPath` returns `string | null`, `null` when `bin_name` is `NULL`. Its
callers:

- `library_watcher.ts:217` omits the bin from the ignore list; there is nothing to
  ignore.
- `libraries_service.ts:44`'s rescue step is deleted anyway (§3.1).
- `PhotosService.delete` takes the in-place branch (§4).
- §6's bin channel has no root to walk, so it does not run.

### 2.4 Renaming the bin moves the folder

`PATCH /api/libraries/:id` accepts `bin_name` and renames `<root>/<old>` to
`<root>/<new>` on disk. DESIGN §4.1 refuses this today on the grounds that it would
"strand every already-binned RAW in a folder the scan would then walk straight back
in" - which is an argument against changing the setting *alone*. Changing it and
moving the folder together strands nothing.

Refused with `READ_ONLY` for a read-only library: renaming a folder is writing under
the root. Refused with `CONFLICT` when `<root>/<new>` already exists, which is the
same refusal `POST` applies (`libraries_service.ts:76-81`) for the same reason -
adopting a folder the photographer already keeps there would put live photographs
into the bin.

Setting `bin_name` on a library whose stored value is `NULL` is **not** a rename:
there is no folder yet, so it only names where one will be made (§2.2). Likewise a
writable library that has never binned anything has no bin folder on disk - it is
created lazily by `PhotosService.delete` - so the rename is a column write and
nothing more, and there are no binned rows to rewrite either.

Three writes, in this order:

1. `rename(oldBinPath, newBinPath)`. One atomic rename, both paths being children of
   the root, so there is no cross-device case and no copy fallback - this is not
   `moveIntoDir`, which exists to suffix colliding *files*.
2. `bin_name` to the new name.
3. The `file_path` prefix of every binned row, from `<old>/` to `<new>/`.
   `deleted_from_path` is **not** rewritten: it records where the photograph came
   from, which is outside the bin and has not moved.

Steps 2 and 3 commit together. `bin_dev`, `bin_ino` and `bin_birthtime` are left
alone - `rename` preserves the inode, so the identity §6.2 matches on is still the
same folder's.

**The rename goes first, and §6.2 is why that is safe.** A crash between the rename
and the commit leaves `<root>/<new>` on disk with rows still saying `<old>/` and
`bin_name` still `<old>`. That is exactly the state §6.2 already repairs: `<old>/` is
gone, `<new>/` turns up in `dirs` carrying the recorded `bin_ino`, and the next sync
follows it and finishes the job. Committing first would leave the mirror image -
rows naming a folder that does not exist while the real one still carries the old
name - and §6.2 would then follow the old folder and revert the name, fighting the
half-applied rename instead of completing it.

Both writers therefore share one prefix-rewrite helper, which is the shape §6.2 asks
for and now has two callers to justify: `rewritePathPrefix`
(`photos_repository.ts:634-649`) does the two halves the opposite way round and is
the wrong function for both.

Held under `libraryMutex` for the whole operation, like every other mutation that
moves files, so it cannot land mid-scan and rewrite binned paths under a sync's
snapshot. It does not take the sync lease - mutations do not, which is §8.3's stated
limitation for the two-container case and unchanged here.

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
an SSD is then a compose line rather than a schema field. Because generated files
leave the root for every library, `read_only` decides nothing about where they go,
and the flip relocates nothing.

`DATA_DIR` is created at startup, and `<DATA_DIR>/<library id>` plus one directory
per rendition kind at library creation - where `ensureDir(getDataPath(library))`
runs today (`libraries_service.ts:99`). Nothing is created lazily by a rendition
writer. A `DATA_DIR` the process cannot write is a **fatal startup error** naming
the path, rather than a server that starts and fails every rendition with
`IO_ERROR`.

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
- **The watcher's `getDataPath` ignore entry** (`library_watcher.ts:214`),
  pointless once the data directory is outside the watched root.
- **The "it contains the library root" guard** in `removeDataDirectory`
  (`libraries_service.ts:37-40`).
- **The rescue-originals-to-the-Bin step** (`libraries_service.ts:42-48`) - see §9.
- **`data_path` threaded through queries and signatures**: `dataPathFor`, the
  column in `libraries`, the join in `photos_repository.ts:914`, and
  `processing_service.ts:486`, which reads `pending.root_path, pending.data_path`
  and needs only a library id.

One guard replaces all of it, and it runs in **both** directions: `DATA_DIR` inside
a library's root, and a library's root inside `DATA_DIR`. The second direction is
the one that loses photographs - `removeDataDirectory` would delete the tree
recursively - so it cannot be the direction left unchecked. Checked at library
creation **and at startup for every library**, because `DATA_DIR` is an environment
variable that can change under a catalogue that was already valid.

`LibraryScope.binName` stays: §5 leaves the bin rule where it is.

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
  - "${PHOTOS_DIR:-./photos}:/photos:ro"    # :ro for a read-only library
  - bowerbird-config:/config
  - "${DATA_VOLUME:-bowerbird-data}:/data"  # a named volume, or a host path for bulk storage
environment:
  DB_PATH: /config/bowerbird.db
  DATA_DIR: /data
```

The compose variable is `DATA_VOLUME`, deliberately not `DATA_DIR`: that name is
the container-side path and must stay `/data`. One name for both would have a
reader setting `DATA_VOLUME=/mnt/bulk` believing they had also set the app's
`DATA_DIR`.

A **named** volume inherits `/data`'s ownership from the image, which is why
`Dockerfile:70-75` pre-creates and `chown`s it to uid 1000 - a volume mounted over
a root-owned image directory "arrive[s] root-owned and the app cannot write its own
database". A **host path** does not inherit that and must be `chown`ed by whoever
mounts it; §3's fatal startup error names the path and says so.

Three files need editing, not one:

- `docker-compose.yml`, above. Its comment at `:20-23` says renditions live in
  `<root>/.bowerbird` and must be rewritten - that stops being true for every
  library, not just read-only ones.
- `docker-compose.dev.yml`, same shape (`DB_PATH: /data/bowerbird.db` at `:39`,
  `bowerbird-db-dev:/data` at `:51`). Its stale claim is a different one, in the
  `user:` rationale at `:20-23`: "a dev container writes root-owned renditions into
  the live-mounted repo and photo library". Renditions stop going there.
- **`Dockerfile:70-75`**: `/config` needs the identical `mkdir -p` + `chown`, or the
  first start cannot open the database.

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

`restore` gains a branch, and **the position of the file decides which branch,
while `read_only` decides only whether the bin branch may move anything.** Three
arms, because two would break every writable library:

| the row's file | result |
|---|---|
| outside the bin | `markRestored(id, photo.file_path)` and nothing else |
| inside the bin, writable library | today's move out of the bin, unchanged |
| inside the bin, read-only library | refused with `READ_ONLY` |

A writable library's binned files are *all* inside the bin, so a rule that refused
that case would 403 every restore in the product.

The first arm cannot merely skip the move.
`moveIntoDir(from, dirname(from), basename(from))` claims the name the file already
holds, hits `EEXIST`, walks its suffix loop to `a_1.arw`, and then
`unlinkMovedFile` removes the source (`files.ts:31`). The file is not duplicated,
it is **silently renamed** under the photographer, in a library the app is not
supposed to be writing to at all.

It also keeps today's existence check (`photos_service.ts:554`): "and nothing else"
means no move, not no validation. Without it a row whose file has gone - binned
while already missing, or hand-deleted - goes live with `is_missing` cleared by
`markRestored` and no file behind it, and the renditions make the grid look fine
while every original 404s.

The third arm exists because without it the row goes live with its RAW still in the
bin, and the bin channel's next pass re-bins it - a restore the user can repeat for
ever, with `deleted_from_path` replaced by a guess each time. The message says to
clear the flag first.

**Undo by batch** tests every row's file position **before restoring any**: if one
is inside the bin of a read-only library the whole batch is refused with
`READ_ONLY`, naming how many. Inheriting the per-row refusal would land a partial
undo, which is worse than none.

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

> **A path claimed by a binned row is not the live channel's business.**

In `syncLibrary`:

1. `binned = photos.listBinnedForSync(libraryId)` - id, `file_path`, `file_hash`,
   the stored file `mtime` and `file_size`, for `is_deleted = 1` rows. Never
   restricted by scope: it is one indexed query, and §6.3 needs all of it.
2. `dbByPath` inside `scanFiles` is built from `[...dbPhotos, ...binned]`
   (`sync_service.ts:906`), so a binned file's `mtime` and `size` are compared
   against its row like any other and the `unchanged` test at `:957` answers
   correctly. Nothing binned is opened or hashed unless it actually changed.
3. `present` and `changed` are partitioned by the binned paths before `buildDiff`:
   the live channel gets the rest, the bin channel (§6) gets the binned half.

**Step 2 is the whole of the cost story, and it is one line.** Partitioning *after*
the scan instead would throw the work away having already paid for it: with
`dbByPath` built from `listForSync` alone, every binned file looks new, and a
catalogue with 100k binned RAWs decodes 100k RAW headers every night for ever.
Merging the two row sets into the lookup fixes that wherever the partition happens,
so no ordering rule has to be remembered.

**`isPathAllowed`'s bin rule stays where it is** (`scope.ts:59`), and the bin gets
its own walk instead (§6.1). It is a choke point with six callers, all of which want
the bin excluded: the walk (`scan.ts:78`), the watcher
(`library_watcher.ts:229`), `ShootsService.create` (`shoots_service.ts:49`, whose
comment says why - "A folder the scan will never look at cannot hold a shoot"), the
in-library folder browser (`libraries_api.ts:49`), and the two scoped-sync helpers
(`sync_service.ts:868,882`). Move the rule out and each needs its own repair, and
each omission is a bug: a shoot created in the bin, whose `addPhotos` then moves
live RAWs into it; a bin folder in `dirs`, letting
`detectRelocationsByIdentity` relocate a shoot inside the bin; mirroring
duplicating the whole shoots tree under the bin; the bin pickable in the UI. One
guard in a shared function beats four in its callers, so the structures those six
read never contain a bin path - and DESIGN §6's one-predicate rule and DESIGN §9.8
stand unamended.

## 6. The bin channel

The bin gets **its own walk**, whose output goes only to the binned rows. This is
what the photographer asked for in the first place - a *secondary* scan of the bin,
not the bin folded into the primary one - and it is why §5 leaves `isPathAllowed`
alone.

### 6.1 It is the same algorithm, run twice

```
scanBinTree(scope) -> ScannedFile[]        // rooted at getBinPath(library)
```

No `dirs`: nothing needs bin folder identities, which is also what keeps
`detectRelocationsByIdentity` from ever seeing one. Then the existing machinery,
with the binned rows as the database side:

| `buildDiff` says | means | result |
|---|---|---|
| `removed` | the file is gone from the bin | `is_missing = 1` |
| `reappeared` | it is back where the row says | clear `is_missing` |
| `modified` | a different file under that name | re-hash, update the row |
| `added` | unclaimed under the bin | §6.4 |

Those four branches already exist (`sync_algorithm.ts:81-104`) and already mean
exactly this, so none of it is restated here as rules of its own.

`is_missing` on a binned row is unreachable today, because nothing walks the bin.
So a photograph whose RAW was deleted out of the Bin folder still appears there with
an original that 404s and nothing on screen to explain it. The display side already
works: `photo_grid.tsx:254` renders the badge and the Bin page already uses
`PhotoGrid`, which is why a photo binned while *already* missing does show it.

`listMissingForSync` and `listMissing` both filter `is_deleted = 0`, so a missing
binned photo stays out of the missing-photos view and is marked in the Bin instead.
The missing view is a list of things to go and find, and a binned photograph is not
one.

**A scoped sync does not run the bin channel.** The watcher never reports events
inside the bin (`library_watcher.ts:217`, kept: watching a tree that only grows
costs an inotify handle per directory), so a scoped run has no evidence about it and
must not draw conclusions - least of all `is_missing` on rows it did not look at.
Hand-managed bin changes are noticed by the nightly full sync, which is what that
sync is for.

### 6.2 A renamed bin folder is followed, exactly as a renamed shoot folder is

A photographer who renames `<root>/Bin` to `<root>/Rubbish` in Finder has done to
the bin precisely what DESIGN §9.4.1 already handles for a shoot: renamed a folder
outside the app, keeping its contents. It is answered the same way, **by the
folder's own identity rather than by its name**, and it has to be - left undetected
it is the worst outcome in this document. `Rubbish/` would be walked by the live
channel, its files would be unclaimed additions whose hashes match the binned rows
exactly (a rename preserves mtime and size, and `computeFileHash` is a digest of
those - `hash.ts:7-21`), every binned row would read as removed, and §6.3 would
pair all of them as crossings *out* of the bin. The entire bin silently restored,
`deleted_from_path` destroyed with no copy anywhere, and every undo batch left
unresolvable because `idsDeletedInBatch` filters `is_deleted = 1`
(`photos_repository.ts:698`).

Three more columns on `libraries`, mirroring `shoots`' three
(`shoots_repository.ts:126-150`):

```sql
bin_dev        INTEGER   -- the bin folder's identity, NULL until first seen
bin_ino        INTEGER
bin_birthtime  REAL
```

Recorded when the bin is first created (`PhotosService.delete`'s `ensureDir`, which
already `statSync`s in the shoot case) and when a sync first stats a bin that has
none - the same "no identity until something writes one" the shoots reconcile
handles (`sync_service.ts:727-741`).

**The trigger is the identity turning up in `dirs`, not the recorded path being
absent.** A directory reaches `dirs` only if the live walk did not skip it, and the
walk skips by name - so a directory carrying the bin's recorded identity *is* the
bin under a name that no longer matches `bin_name`. That covers the rename, and it
also covers a case-only difference on a case-insensitive filesystem, where
`existsSync(<root>/Bin)` still answers true and an absence test would never fire.

The identification rules are DESIGN §9.4.1's, unchanged, because the ambiguities are
the same: exactly one candidate or it is not an identification, and birthtimes must
agree where both sides report one. Two further constraints are the bin's own:

- **Root-level only**, which is an inherited constraint and not a principle. It
  holds because `BinNameSchema` is a single folder name rather than a path
  (`schemas/libraries.ts:7-12`) and `getBinPath` is `path.join(root_path, bin_name)`,
  so a bin one folder deep is not *expressible* - not unsafe. A candidate whose
  `relPath` contains a `/` is therefore not followed. Nothing else in this design
  needs it: the bin's mirrored layout strips whatever prefix the bin sits at (§6.4),
  and the scan's skip would become a path-prefix test instead of a first-segment one.
  Allowing `Archive/Bin` is a schema change and two one-line edits, if anybody ever
  wants their bin out of the way.
- **Detected after the walk and before `buildDiff`**, so the bin channel can be
  re-rooted at the new path and that subtree removed from the live channel's files
  before either diff runs. The renamed folder is then also spoken for, and cannot be
  claimed by `detectRelocationsByIdentity` as a shoot relocation.

What it writes is what §2.4's app-initiated rename writes, minus the `rename` call
the photographer already performed: `bin_name` to the new name, and the `file_path`
prefix of every binned row, with `deleted_from_path` left alone. The two share one
helper.

That helper is **not** `rewritePathPrefix` (`photos_repository.ts:634-649`), which
does the two halves the opposite way round: `file_path` for `is_deleted = 0` rows and
`deleted_from_path` for `is_deleted = 1`. Right for a shoot, wrong for the bin.
Worth naming, because the two are one edit apart and a future reader will reach for
it.

**When the identity cannot answer, the bin channel is skipped for that run** and the
reason logged: no identity recorded yet, no candidate, more than one, disagreeing
birthtimes, a nested candidate, or a filesystem reporting `ino` 0. The rows are left
exactly as they are. A bin folder whose fate is unclear is not evidence that five
hundred photographs were restored, and the next sync gets another chance.

### 6.3 A crossing is structural, not a rule

A file that entered or left the bin appears as a **removal in one channel and an
addition in the other**. `detectMoves` pairs them by hash exactly as it pairs a
move within a channel, and the *channel each half came from* is the direction - so
there is no position to test, no `isUnderBin` call, and no transition rule to state:

- live removal + bin addition = **hand-binned**. Apply `markDeleted(id, oldPath)`,
  keeping `shoot_id` rather than letting the move's own
  `setFilePathAndShoot(…, shootFor(newPath))` null it - §5 keeps shoots out of the
  bin, so `shootFor` on a bin path is `null`, and an app-driven bin deliberately
  preserves membership (`photos_repository.ts:667-670`).
- bin removal + live addition = **hand-restored**. Apply `markRestored`, and set
  `shoot_id` from `shootFor(newPath)`: `markRestored` does not touch it
  (`photos_repository.ts:725-732`) and `reconcileShootFolders` only restates claims
  under newly created folders (`sync_service.ts:827`), so without this a
  hand-restored photograph lands in the grid with no shoot for good.
- bin removal + bin addition = the file moved **within** the bin. `setFilePath`
  only; it was binned and still is.

Two channels are what make this structural, so keep them separate. Deciding the same
question by testing whether a path is under the bin cannot be made correct: an
in-place binned row is `is_deleted = 1` with its file *outside* the bin, which is
indistinguishable by position from a hand-restore, so a folder rename in a flipped
library silently restores it and nulls its `deleted_from_path`.

**Pairing runs before the apply, and consumes the additions it pairs.**
`result.added` is consumed inside the apply (`sync_service.ts:425-428`), so a pass
that ran afterwards would be pairing rows that already exist: the file would be
inserted as a new photograph *and* have the binned row re-pointed at it, leaving two
rows claiming one path with no UNIQUE to stop them (`idx_photos_file_path` is not
unique, `migrations.ts:138`). One permanent duplicate per hand-moved file. The
pairing and the insert are one decision, made where `detectMoves` already makes it
with `usedAdded` (`sync_algorithm.ts:140-164`).

The live channel keeps first claim on an addition, so a photograph moved between two
live folders can never be swallowed by a binned row.

**Crossings do not go into `result.moves`.** `detectShootRelocations` reads that
array (`sync_service.ts:351`), and a binned file's movement is not evidence about a
live shoot folder. A relocation whose `newFolderPath` is under the bin is dropped
from the combined `relocations` array (`sync_service.ts:355`) for the same reason:
the photo-based arm can relocate a shoot into the bin when the inode cannot answer -
a cross-device move, a copy-and-delete, a restore from backup - and it then filters
those moves out, so nothing downstream would notice a whole shoot living inside the
bin with `is_deleted = 0`.

### 6.4 An unclaimed file under the bin is imported as already-binned

The bin channel's `added` branch. `is_deleted = 1`, and `deleted_from_path` derived
by stripping the bin segment: DESIGN §12.3's layout mirrors the folder a photo came
from, so `<bin>/A/B/c.arw` yields `A/B/c.arw` exactly, and `<bin>/c.arw` yields
`c.arw` - a file path at the library root, as `deleted_from_path` is everywhere
else.

This is the half of the photographer's request that is about *adding*: a RAW they
dropped into the bin folder themselves becomes a row they can see and restore.

Before importing, the bin layout gives a cheaper answer than a hash: if
`<bin>/A/c.arw` is unclaimed and `A/c.arw` is an unpaired **removal** in the live
channel, that is the crossing, and §6.3's first case applies to the existing row.
A path test rather than a hash test, so it survives the case a hash cannot see - the
file was copied into the bin and the original deleted, or touched on the way, so the
mtime changed and the hashes do not match. Without it that crossing produces a
`setMissing` on the live row *and* a second already-binned row for the same frame.

Such a row has no renditions and, because `PENDING_PROCESSING` excludes
`is_deleted = 1` (`photos_repository.ts:255`), nothing will queue any. The Bin page
shows a hole until the photograph is opened. Accepted: building renditions for
something the photographer has already thrown away is work nobody asked for.

### 6.5 Where it runs, and what it counts

The bin channel's walk and diff run alongside the live channel's, before
`detectMoves`, which then sees both. **Every row write it produces is applied inside
the same `photos.transaction` as the live diff** (`sync_service.ts:392-443`) - so a
run that aborts leaves neither half, which is what `SyncCancelled`'s handling
already promises and what §8.2's lease rollback needs.

`scanFiles`' batched first-scan path is gated on `dbPhotos.length === 0`
(`sync_service.ts:315`). With §5 that is "no *live* rows", which is no longer the
same as "no rows", so it becomes `dbPhotos.length === 0 && binned.length === 0`.
Without that, the first sync of the recreated catalogue (§14) over a tree that still
holds the old `<root>/Bin` would insert every RAW in the bin as a **live**
photograph, and `insertBatch`'s justifying comment ("no move can pair without one")
would be false besides. The comment is amended in the same commit.

An in-place binned row is in neither walk - the bin channel does not reach it and
step 3 partitions it out of the live channel - so nothing in §6 has an opinion about
it. That is what makes the flip in §2.2 safe.

Counts: §6.1's `is_missing` transitions and re-hashes are `photosModified`, §6.3's
pairs are `photosMoved`, §6.4's imports are `photosAdded`, and a followed bin rename
(§6.2) is none of them - it renames a folder, it does not change what the catalogue
holds. The bin channel's paths
are part of the sync's progress total, in the same phase as the walk - they are work
the sync is doing, and hiding them makes the bar lie. `photo_count` needs nothing:
it is a subquery over `is_deleted = 0` (`libraries_repository.ts:23-28`).

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
are two call sites: `syncLibrary` (`:207`) and `rebuildStage` (`:566`) - and the
second is not a sync at all. It holds the lock only for a claim (queue +
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

`owner` is minted **per acquire, not per process**. A per-process owner let a run
whose lease had lapsed delete its successor's row on the way out, and let two syncs
in one server both hold the lock. There is no `pid` column: a PID is what §8.1 is
about, and a value nothing reads does not earn one - the owner UUID goes in the log
line instead.

`started_at` and `refreshed_at` are `toISOString()` UTC strings, which is what makes
`refreshed_at < ?` a valid comparison: fixed width, zero-padded, no offset.

`ON DELETE CASCADE` means a library removed mid-sync leaves no orphan row.

**Acquire** is one statement, so there is no check-then-claim window. `?4` is
`now - 30s`; the lease is 30 seconds:

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
cannot lose a race the way a `SELECT` then `INSERT` in a deferred transaction would.

**Refresh is driven by the work, not by a timer.** The same owner-scoped `UPDATE`,
issued from the points the sync already passes through while it holds the event loop
- `reportScan`, which fires per file (`sync_service.ts:231`, called at `:953`), and
`insertBatch` per batch - throttled on a `Date.now()` compare:

```sql
UPDATE sync_locks SET refreshed_at = ?2 WHERE library_id = ?1 AND owner = ?3;
```

A `setInterval` would be the obvious choice and it cannot work here: the scan and
apply are synchronous (`computeFileHash`, `statSync` in the walk, and one
`photos.transaction` over the whole diff, minutes on a large library), so a timer is
starved *precisely* during the window where the lease matters. Refreshing from the
work runs when the loop is blocked, which is the point. It also deletes the timer's
lifecycle rules, its `unref`, and the abort-on-takeover path that only a timer needed.

**Release** is `DELETE FROM sync_locks WHERE library_id = ?1 AND owner = ?2`,
owner-scoped, so a `finally` running late cannot delete a successor's lock.

**The lease covers the scan and the apply only**, and is released before the
detached processing starts - exactly where the file lock is released today (DESIGN
§9.6). A 40-minute rendition build must not hold it.

**`syncAll` retries what it skipped.** It swallows `SYNC_IN_PROGRESS` and moves on
with no retry (`sync_service.ts:176-181`), which under expiry-only reclaim means a
container killed mid-sync and restarted within seconds has that library **dropped
until tomorrow's schedule**, not delayed by 30 seconds. So `syncAll` collects the
libraries it skipped and re-attempts them once at the end of its loop, by which
point a real lease has certainly lapsed and no sleep is needed. The 409 message
distinguishes "held, refreshed Ns ago" from "expires in Ns", because after a crash
"a sync is already running for this library" is a lie.

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
than being instant, which the watcher already handles by re-arming and `syncAll`
now handles by retrying.

### 8.2 The lease is re-checked inside the apply transaction

Refreshing from the work (§8) keeps the lease alive through the scan, but there is
one stretch it cannot reach: the single closing transaction. That is where the
check has to be, and it is the load-bearing one.

**The apply re-reads `SELECT owner FROM sync_locks WHERE library_id = ?` as its
first statement and rolls back on a mismatch.** Same transaction, so no window.
`db.transaction(fn)` rolls back and rethrows on a throw, and `syncLibrary`'s catch
turns that into the 409 the watcher already re-queues.

**It must be `BEGIN IMMEDIATE`, not the default.** `db.transaction()` is
`BEGIN DEFERRED`: making a `SELECT` the first statement takes the read snapshot
there, and the first write then has to upgrade - which returns
`SQLITE_BUSY_SNAPSHOT` if another connection committed in between, and
`busy_timeout = 5000` (`connection.ts:12`) does **not** retry that. Today the
apply's first statement is a write, so it takes the write lock up front and the
timeout covers it. Adding a read in front of it without `.immediate()` would
manufacture a spurious-failure mode in exactly the two-container configuration §8.3
exists for. `PhotosRepository.transaction` does not expose `.immediate` today, so
widening that helper is part of this change.

Each batch on the first-scan path opens with the same `SELECT owner` and rolls
itself back on a mismatch, then the run aborts with `SYNC_IN_PROGRESS`. Batches it
already committed are **not** rolled back, and that is stated rather than hidden: a
first import that loses its lease leaves the photographs it had already inserted,
which the next sync reconciles.

### 8.3 Two containers sharing /config

This is the configuration the table has to be right for: two Bowerbird containers
over one library, both mounting the same `/config`, so both open the same SQLite
file. It works, and it is the case the file lock gets **wrong** today.

**SQLite's own locking is namespace-blind, which is the whole point.** It excludes
writers with `fcntl` advisory locks, and those live on the inode in the kernel -
not in a PID namespace, not in a process table. Two containers holding the same
inode through the same volume contend for the same lock, whatever either one calls
its own processes. That is exactly the property §8.1's PID number lacks and cannot
be given. It is also why `flock(2)` is moot: SQLite already holds a kernel-level,
namespace-blind lock on the inode, and neither Node nor Bun exposes one to acquire
directly.

The pragmas this needs are already set (`connection.ts:10-12`): WAL, which is
cross-process on one host because both containers mmap the same `-shm` file off
the shared volume, and `busy_timeout = 5000`.

**Sharing `/config` requires sharing `/data`.** A supported-configuration statement,
not advice. `needs_tile`, `needs_renditions` and `renditions_built_at` are columns in
the shared database; the rendition files are per-`DATA_DIR`. With separate data
directories, whichever container builds a rendition clears the flags for both,
`PENDING_PROCESSING` (`photos_repository.ts:255`) then excludes those rows for
everyone, and the other container serves 404s for `full` and `max` for ever with
nothing able to queue the work.

**Two containers are read-mostly.** They may both sync; only one may bin or move
photographs. `libraryMutex` is process-global (`library_mutex.ts:6-10`, whose own
comment names this gap), so it is what stops a bin move landing mid-scan and it
cannot see the other container. Mutations taking the lease and *waiting* rather than
failing is the fix, and it is out of scope here.

On a sync: both watchers see the change, both debounce, one wins the upsert, the
other's `changes()` is 0 and it raises `SYNC_IN_PROGRESS`. The loser re-records its
paths and re-arms (`library_watcher.ts:325-327`) rather than concluding its change
is covered - the holder's scan may have started before that change happened. The
retry then stats its handful of paths, finds every one unchanged against the rows the
winner already updated, and applies an empty diff.

One clock, because one host. Two hosts sharing `/config` means SQLite over a network
filesystem, where WAL's shared memory does not work and the database is unsafe
regardless of anything in this document. Unsupported, and was before the lock moved.

## 9. Removing a library

`removeDataDirectory` deletes `<DATA_DIR>/<library id>`, which is the app's own
directory and outside every root. Its rescue step - moving any original found in
there into the library's bin (`libraries_service.ts:42-48`) - is deleted with
`data_path` (§3.1): it existed for a `data_path` the photographer had aimed
somewhere unwise, and there is no such path any more. It also cannot survive: even a
flipped library with a bin is one the app may not write under, so there is nowhere
it is allowed to rescue to.

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
watcher, rendition building, the orphan sweep, and the quality-check page
(`tmpdir`).

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

Raised by:

- `ShootsService.create` for a folder that does not exist, **in a read-only
  library**.
- `ShootsService.addPhotos` and `removePhotos`, in a read-only library.
- `PhotosService.restore` and undo, for a row whose file is inside the bin **of a
  read-only library** (§4). A writable library's in-bin restore is unaffected.
- `LibrariesService.create` for `read_only: false` over a root that fails the
  `access` check, and `update` when clearing `read_only` on such a root.
- `LibrariesService.update` for a `bin_name` rename on a read-only library (§2.4).
  The same call raises `CONFLICT`, not `READ_ONLY`, when the new name is already a
  folder at the root: that one is refused in a writable library too.

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
                        bin_name: BinNameSchema.optional()   // renames the folder (§2.4); required in
                                                             // the request that clears read_only on a
                                                             // library whose bin_name is null
```

```ts
// config.ts - alongside port, host, dbPath
dataDir: path.resolve(process.env.DATA_DIR ?? './data')
```

`GET /api/browse` listings gain **one** `writable: boolean` for the folder being
listed, from `access(W_OK)` (§2.1). Child entries carry none.

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
hidden, because there is no bin. Because `access` can be wrong (§2.1), a
`READ_ONLY` from `POST` re-ticks the checkbox and re-shows the dialog rather than
surfacing a bare error.

**Settings** shows the flag per library, with the consequences named: no bin
folder on disk, and shoots that follow the folders as they are. Clearing it asks
for a bin name.

**The bin-name field becomes editable** for a writable library, and says what it
does: the folder is renamed on disk and the photographs inside it move with it
(§2.4). It stays read-only for a read-only library, with the reason. A `CONFLICT`
names the folder that is in the way rather than reporting a bare failure, since the
remedy is to pick another name.

**Bulk bar and the Bin page** keep their labels - the photograph *is* binned, and
that is the word for it - but the Bin page's line about the files
(`bin_page.tsx:23`, "The RAW files still exist, moved into a Bin folder on disk")
is false for a read-only library and must read off the library: moved into
`<bin_name>` when there is one, left exactly where they were when there is not. A
binned photograph whose file has moved carries the `missing` badge until a full
sync pairs it (§6.3).

**Restore** stays visible but disabled for a binned photograph whose file is inside
a read-only library's bin, with the reason and "clear the flag first" in the
tooltip - the same policy as the shoot items.

**Photo actions** hide *Add to shoot* and *Remove from shoot* for a read-only
library. *Add to album* is unaffected and is the thing to reach for.

## 14. Schema, not migration

**Nothing migrates.** There are no installs to carry forward - only a dev
catalogue, which gets recreated - so every change here is an edit to `SCHEMA` in
`db/migrations.ts`: no `ensureColumn` step, no table rebuild, and no data move
anywhere in this document.

In `libraries`: add `read_only INTEGER NOT NULL DEFAULT 0`, add `bin_dev INTEGER`,
`bin_ino INTEGER` and `bin_birthtime REAL` (§6.2), make `bin_name TEXT` nullable
(drop `NOT NULL DEFAULT 'Bin'`), delete `data_path`. Plus `sync_locks` (§8) as a new
table.

A `sync_locks` row present at startup means "stale within 30 seconds", not
"syncing": a crashed process leaves its row, and expiry is what clears it. Startup
deletes nothing.

Not doing this the migration way is the point. A relocation of every rendition in
the catalogue, a rebuild of `libraries` to drop a column SQLite will not drop in
place, and the tests to prove both - all of it exists only to spare a database that
can simply be deleted instead. The ten incremental migrations already in
`db/migrations.ts` are carrying the same dead weight, but folding those into
`SCHEMA` is a separate change and not this document's call.

## 15. Testing

Unit, against the existing service tests:

- Binning a read-only library moves nothing, sets `is_deleted`, and leaves
  `file_path` equal to `deleted_from_path`.
- Restoring an in-place binned photo renames nothing. Asserted by listing the
  directory: the regression is a silent `a_1.arw` rename, so a test on the row
  alone would pass while the file moved.
- Restoring a photo whose file is inside the bin of a **writable** library still
  moves it out to `deleted_from_path`. This is the arm a two-arm rule would have
  broken for every existing library.
- Restoring one inside the bin of a **read-only** library throws `READ_ONLY`, and an
  undo batch containing one is refused **before any row is restored**.
- Restoring a row whose file is gone still raises `IO_ERROR` rather than going live
  with `is_missing` cleared.
- A binned file whose `mtime` and `size` still match its row is never opened:
  asserted by spying on the metadata extractor, since the row assertions pass
  either way and the cost is the point.
- The bin channel's four branches: gone sets `is_missing`; back at its path clears
  it; a different file under a claimed binned name is re-hashed; an unclaimed one
  arrives `is_deleted = 1` with `deleted_from_path` stripped of the bin segment, and
  `<bin>/c.arw` yields `c.arw`.
- A crossing each way: a live file moved into the bin becomes binned and **keeps its
  `shoot_id`**; a binned file moved out becomes live and **gains the `shoot_id` of
  where it landed**.
- A crossing whose `mtime` changed is still recognised, via §6.4's path test, and
  produces one row rather than a missing live row plus a new binned one.
- Pairing happens before the apply: a hand-moved binned file leaves **one** row.
- **An in-place binned photo whose folder is renamed stays binned**, keeps
  `deleted_from_path`, and stays resolvable by its batch.
- A renamed bin folder is **followed**: `bin_name` and every binned row's
  `file_path` prefix move to the new name, `deleted_from_path` does not, and nothing
  is restored, imported or marked missing. This is the test that matters most in
  §6 - undetected it silently restores the whole bin.
- A bin folder renamed *and* moved into a subfolder is not followed (it cannot be
  expressed), and the bin channel is skipped rather than guessing. Same for two
  candidate folders sharing an inode, and for a library with no recorded bin
  identity yet.
- A bin spelled `bin` against a `bin_name` of `Bin` on a case-insensitive
  filesystem is followed by the same rule, in one sync, and imports no duplicates.
- A renamed bin folder is not claimed as a shoot relocation.
- A scoped sync does not touch `is_missing` on any binned row.
- A library with `bin_name = null` runs no bin channel at all.
- `create`, `addPhotos` and `removePhotos` on a read-only library's shoots throw
  `READ_ONLY`; renaming one does not.
- Creating a library with `read_only: false` over an unwritable root is refused with
  `READ_ONLY`, not silently flagged. An unwritable `DATA_DIR` fails startup rather
  than starting.
- Renaming `bin_name` (§2.4) moves the folder, rewrites every binned row's
  `file_path` prefix, and leaves `deleted_from_path` alone. A restore afterwards
  still lands the photograph where it originally came from - the assertion that
  proves the two halves were split correctly.
- The rename is refused with `CONFLICT` when a folder of the new name already exists
  at the root, and with `READ_ONLY` for a read-only library.
- Renaming on a library that has never binned anything moves nothing and rewrites
  nothing; renaming from `NULL` is not a rename at all.
- A rename that commits the disk half and then fails is completed by the next sync
  via §6.2, not left half-applied. Asserted by renaming the folder, leaving the
  columns stale, and syncing.
- `getDataPath` resolves under `DATA_DIR` for a writable library as much as a
  read-only one, and is absolute regardless of the working directory. `DATA_DIR`
  inside a library root, and a library root inside `DATA_DIR`, are both refused at
  creation and at startup.
- **Two acquires without a release in between do not both succeed**, whether or not
  they come from one process - `owner` is per acquire, so nothing about a caller's
  identity gets it in early.
- A lock row 31 seconds stale is reclaimed; one 5 seconds stale is not. A release
  cannot delete a row another `owner` holds. Deleting a library mid-sync leaves no
  row.
- An apply transaction whose lock row has changed `owner` rolls back and writes
  nothing, and a batched first scan that loses its lease keeps its committed batches
  and inserts nothing after (§8.2).
- `syncAll` re-attempts a library it skipped with `SYNC_IN_PROGRESS` rather than
  dropping it until the next schedule.

Integration (`test/integration`): a read-only library over a fixture tree with
the directory permissions actually dropped, so a stray write fails the test
rather than passing unnoticed. Sync, bin, restore, undo, rate, stack, album. This
is the highest-value test in the document.

Also integration: **two processes over one database file**, not two `Database`
handles in one process. Only a second process exercises what the file lock got
wrong - `fcntl` locks are per-inode and would be invisible to a test that shares a
process. Both are pointed at one fixture library and told to sync at once; exactly
one wins, the loser raises `SYNC_IN_PROGRESS`, and the photo count afterwards is the
file count rather than twice it. Double insertion is the corruption the lock exists
to prevent, and a same-process test cannot see it.

E2E: one spec adding a read-only library, binning a selection, checking the Bin,
restoring, and confirming the tree on disk is byte-identical to what it was.

## 16. Known limitations

Stated so they are choices rather than surprises:

- No bin folder to open in Finder or Explorer. A binned photograph is visible in
  the app and untouched on disk, and nowhere else.
- Photographs cannot be moved into or out of shoot folders. Albums cover the
  grouping; the folders stay as they are.
- A read-only library's bin cannot be renamed from the app either (§2.4), since that
  is a write under the root. Renaming the folder by hand works and is followed
  (§6.2), which is the same answer this design gives everywhere else.
- Crossings pair on `file_hash`, which is a digest of extension, dimensions, mtime,
  colour space, size and orientation rather than of pixels (`hash.ts:7-21`), so two
  byte-identical copies of one RAW collide by construction. Not new - the live
  `detectMoves` has always had it - but §6.3 extends it to binned rows. §6.4's path
  test covers the common false negative; the false positive remains.
- Hand-managed bin changes are noticed by the nightly full sync, not within a
  watcher debounce (§6.1).
- A bin folder rename the inode cannot identify - moved into a subfolder, two
  candidates sharing an inode, a filesystem reporting `ino` 0, or no identity
  recorded yet - is not followed. The bin channel skips that run and the rows are
  left alone (§6.2), so the bin is simply not reconciled until the folder is put
  back or the name is fixed by hand.
- A file imported already-binned (§6.4) has no renditions and nothing will queue
  any; the Bin page shows a hole until it is opened.
- Two instances with separate databases no longer exclude each other's syncs (§8).
  Two sharing `/config` must share `/data`, and only one of them may bin or move
  photographs (§8.3).
- Reclaiming a crashed sync's lock takes up to 30 seconds, and a first import that
  loses its lease leaves its already-committed batches behind (§8.2).
- Any catalogue that predates this is not carried forward. It is recreated (§14),
  which is only free while there is one dev instance and stops being free the
  moment there is a user. Legacy `<root>/.bowerbird` trees are left on disk for the
  photographer to delete (§3.1).
- A photographer who moves a binned file *out* of a read-only library's tree
  entirely leaves a binned row marked `is_missing`, with no way for the app to
  know it was deliberate.
