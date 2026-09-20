# Bowerbird design: Import, sync and deletion

A chapter of [`DESIGN.md`](../../DESIGN.md). The chapters are numbered as one document, so
`DESIGN §N` anywhere in the repo, and a `§N` cited here that is not below, both mean the
section the index in `DESIGN.md` maps §N to.

---

## 7. Supported File Formats

Two families, and the difference between them is a mosaic.

**The RAWs**, always: Sony ARW (`.arw`), Canon CR2/CR3 (`.cr2`, `.cr3`), Fujifilm RAF (`.raf`) and
DNG (`.dng`), case-insensitive.

**The finished pictures**, where the library asked for them (`include_non_raw`, §4.1): JPEG
(`.jpg`, `.jpeg`), PNG (`.png`), HEIC/HEIF (`.heic`, `.heif`, `.hif`) and AVIF (`.avif`). Off by
default, because beside a folder of RAWs they are usually the camera's own copies of frames the
library already holds and importing both makes every frame two rows.

The sync scanner matches files by extension. All other files are silently ignored. The extension set is the *scan filter*; the actual decoder/metadata reader is chosen later by header sniff (§10, §11), so a further format is added by registering a reader plus extending this set. The same table carries the media type the original is served under (§13.5).

The table is the *only* gate, because everything asking "is this one of ours" goes through it: the full walk, the watcher (both the event it acts on and the scoped sync's paths), and `findOriginalsAnywhere`, which is what carries a stray original out of a data directory before that directory is deleted (§8.1). A format added here is therefore both ingested and protected from that sweep, in one edit; one added to only half of them would be imported and then deleted with the renditions.

**Three questions, not one**, because the callers are not asking the same thing:

- `importsFormat(scope, name)` is the scan filter, and it is the only one that consults the
  library's setting.
- `isOriginal(name)` is every format the application can hold, whatever a library imports - a
  HEIC is an original in a library that does not take them.
- `isStrayOriginal(name)` is what the deletion guards ask, and it is `isOriginal` minus AVIF.
  Every rendition this application writes is AVIF (§10.2), so under `DATA_DIR` an `.avif` is one
  of ours; reading it as an original would refuse to sweep a single rendition and refuse to
  remove any library's data directory.

```typescript
const RAW_MEDIA_TYPES = new Map([
  ['.arw', 'image/x-sony-arw'],
  ['.cr2', 'image/x-canon-cr2'],
  ['.cr3', 'image/x-canon-cr3'],
  ['.raf', 'image/x-fuji-raf'],
  ['.dng', 'image/x-adobe-dng'],
]);

const RENDERED_MEDIA_TYPES = new Map([
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'],
  ['.heic', 'image/heic'], ['.heif', 'image/heif'], ['.hif', 'image/heif'],
  ['.avif', 'image/avif'],
]);

function importsFormat(scope: LibraryScope, filename: string): boolean {
  const extension = path.extname(filename).toLowerCase();
  return RAW_MEDIA_TYPES.has(extension) || (scope.includeNonRaw && RENDERED_MEDIA_TYPES.has(extension));
}
```

### 7.1 What a finished picture does not have

**The mosaic, and everything fitted to it.** GALOSH is fitted to a photosite's own noise on the
colour filter array and the dust search reads the same lattice, so a frame somebody else's camera
has already demosaiced has neither - the Detail pair and the Dust panel are closed for one, and
`PreparedHeader.mosaic` is what closes them. Nor is there a demosaic to run, an as-shot illuminant
to move away from, or a camera matrix for the defringe to propagate its channel correlations
through.

**A camera match.** The match is fitted by comparing our render against the camera's own JPEG; a
JPEG *is* that render, so there is no second rendering of the frame to compare it to and the grade
takes its neutral arm exactly as a rendition with `match_embedded_jpeg` off does.

**An embedded preview**, except for a JPEG, where the file *is* one. A PNG, a HEIC or an AVIF has
nothing to lift, so it renders - which is what a RAW that embeds nothing already does - and
`hasEmbeddedJpeg` is what keeps the viewer from asking for a file that cannot exist.

Everything below those runs unchanged: the coding, the defringe, the lens gather, the sharpen, the
grade, the crop, the roll-off and the whole editor. `native/rawshim/src/decode.rs` is the one seam
between the two front ends, and `linearise.slang` is the rendered family's answer to the
conditioning and the demosaic at once - the transfer undone, the gain map applied, the primaries
converted, cropped, halved and turned upright, in one pass.

**AVIF is the one format a browser cannot open.** libavif is already linked for the renditions the
server writes and reads one back exactly; the editor links no C at all, and the only pure-Rust AV1
decoder under a licence this project can take reaches for `libc` types
`wasm32-unknown-unknown` does not have. So an AVIF gets a catalogue row, a grid tile, renditions
and a viewer, and the editor says why it cannot open one rather than showing a black frame. HEIC
has no such gap: `heif.rs` reads the boxes and `hevc.rs` the bitstream, both pure Rust, on both
hosts.

**Canon needed no second reader, and that is the point of the split.** The decoder reads CR3 and parses its header like any other format - LibRaw's did then and rawler's does now - so the decode, the embedded preview, the exposure and the body and lens names all arrived working. Three things did not, and each is a place the ARW-only assumption had hardened into code rather than a Canon feature:

- **The capture zone.** `exif_zone.ts` read the offset tags straight out of the TIFF header a RAW "already is". A CR3 is an ISO base-media file; its EXIF sits in a `CMT2` box under `moov`, as a complete little TIFF of its own. Walking the box tree that far and handing the block to the same IFD reader is the whole of it (§11.1).
- **The masked-border crop.** Measured against the raw frame rather than against the window LibRaw already emitted, so on every body that declares an inset crop - which is every Canon - it was applied twice. That arithmetic is gone with the decoder: rawler states the manufacturer's own crop and it is applied once (§11.1).
- **GPS.** Canon reports a parsed fix on every frame and zeroes it when there was none, which read as 0,0: a real place, in the Gulf of Guinea. An all-zero triple is now "not recorded".

**CR2 came for free on top of that**, and is the case the split was meant to make cheap: it is a plain TIFF, so the capture-zone reader takes its first branch rather than the box walk, and the crop and GPS fixes above are per-body rather than per-format. Verified on EOS 600D frames - 18MP at the dimensions the header states, portrait orientation, lens and exposure, and an embedded JPEG for the grid tile. A 2011 body predates EXIF 2.31, so it records no capture zone at all and reports `null`, which is the absence the tag is nullable for rather than anything unread.

---

## 9. Sync Algorithm

The sync algorithm is the most complex component. It is a stateless comparison between the database (prior state) and the filesystem (current state).

### 9.1 Phase 1: Scan

For each library:

1. Resolve the library's `root_path`.
2. List all files under `root_path`, descending into subfolders only when the library's `include_subfolders` is set (§4.1), and skipping:
   - Any hidden directories (starting with `.`), which is what a legacy `<root>/.bowerbird` falls under (§6).
   - The library's bin, `<root>/<bin_name>` and everything under it (§12.3), so soft-deleted files are never re-imported. Anchored at the root, unlike the rules above it: that is the only place a bin is ever made, and matching the name at every depth would take a folder of the user's own called `Bin` out of the library in silence.
   - Any directory carrying an `excluded` rule (§4.7), and therefore everything beneath it.

   These four questions live together in `src/utils/scope.ts`, and the **watcher asks them too** (§9.8). It had its own copy of the first two rules, which is two lists to keep in agreement about what the library contains; with the last two added the cost of them drifting is a folder the user excluded still waking a sync on every change, and scoped syncs queued for paths the scan will then ignore.

   They split in two, and the split is not cosmetic. Four of them read the path alone and answer the same whether what sits there is a file or a folder, since each is about a *segment*: that is `isPathAllowed`. Only `include_subfolders` needs to know which it is looking at, because a root-only library keeps the files in its root and discards the folders beside them - the same string answers differently depending on what it names. The scan always knows what it is looking at, so `isDirInScope` is the two halves together. A watcher event names a path and not what kind of thing is at it, so the watcher asks `isPathAllowed` and settles the remaining question for files alone; a stray folder path costs nothing downstream, because the scoped sync tests it with `isDirInScope` before reading it.
3. Filter to the extensions this library takes (§7): the RAWs always, and the finished pictures where `include_non_raw` is set. This yields the set of **present** file paths.
4. Query the database for all non-deleted photo records in this library (each carries its stored `date_updated` = last-seen mtime and `file_size`).
5. **Stat quick-check (avoid opening unchanged files).** For each present file, `stat` it (cheap; no open). If a DB record exists at that path **and** its stored `date_updated` and `file_size` both match the current mtime and size, the file is **unchanged**: reuse its stored hash and do **not** open it. Only files that are new, or whose mtime/size differ, are opened to extract metadata (§11) and compute the **file hash** (§9.2). Call this opened subset **changed**. A no-op sync therefore opens no RAW at all. (Like rsync's default quick-check, this misses a content change that preserves *both* mtime and size, which is rare in practice; a forced full re-hash is the escape hatch if ever needed.)
6. Build the diff from the present set and the changed set:

```
present  : Set<path>                        (every supported file on disk)
changed  : Map<path, { hash, metadata }>    (only new / mtime-or-size-changed files, i.e. opened)
db_inputs: List<{ path, PhotoRecord }>      (one entry per INPUT of every non-deleted record, §4.2.1)

For each entry in db_inputs:
  if path NOT in present → mark as REMOVED
  else if path in changed AND changed.hash differs from record.hash → mark as MODIFIED
  else if record.is_missing → mark as REAPPEARED   (present, unchanged, was missing)

For each entry in changed:
  if path is an input of no record → mark as ADDED
```

Unchanged files (present but not in `changed`) produce no diff entry, so they are never opened and never re-hashed.

The catalogue's side is **one entry per input** rather than per photograph, which is what carries a
change on disk to everything composed from that file: a file two records name is diffed once
against each, and both are marked. For almost every record that is the one file it is.

The REAPPEARED case matters: a file that went missing and returns **at its original path with the same content** is neither modified nor moved, so without this it would stay flagged `is_missing = 1` forever. (Reappearance at a *different* path is handled by move detection.)

#### 9.1.1 The bin channel

The scan runs **twice**, over two channels: the walk above against the non-deleted rows (**live**), and a second walk of `<root>/<bin_name>` against the `is_deleted = 1` rows (**bin**). Same code, same diff, different pair of inputs.

> **A path claimed by a binned row is not the live channel's business.**

A bin folder outside the walk says that sentence by where it sits; the table has to say it instead, because a photograph can be binned **in place** (§12.1) - flagged, with its file still sitting in the live tree. The binned rows are therefore read on every run and their paths partitioned out of the live half *before* the diff, not after: with the live rows alone every binned file looks new, and 100k binned RAWs would decode 100k RAW headers nightly.

What the second channel buys is that `is_missing` becomes reachable on a binned row. Without it, a photograph whose RAW was deleted out of the Bin by hand sits there for ever with an original that 404s.

- **A crossing** is a pair whose halves land in different channels: a removal in one and an addition in the other, which is a file hand-binned or hand-restored. The channel tags give the direction, so there is no position to test - and position could not answer it anyway, an in-place binned row being `is_deleted = 1` with its file outside the bin. Crossings stay out of `moves`, which `detectShootRelocations` reads: a binned file's movement is not evidence about a live shoot folder.
- **An unclaimed file under the bin is imported already-binned**, with where it would restore to read off the mirrored layout. A path test runs before the hash one: a file copied into the bin and the original deleted has its own mtime, and so its own hash.
- **A hand-renamed bin folder is followed** by the recorded identity, exactly as a shoot is (§9.4.1). Undetected it is the worst outcome in the design: the live walk takes the renamed folder's files as unclaimed additions whose hashes match the binned rows exactly, and every binned row pairs as a crossing *out* of the bin - the whole bin restored and `deleted_from_path` destroyed. Excluding the folder is unconditional; **rewriting `bin_name` needs two more conditions**, because dropping the recorded-path absence test admits a bind mount, a hardlinked directory and a recycled inode, and following any of them would silently bin a real shoot.
- **A scoped sync runs no bin channel.** The watcher does not watch the bin, so a scoped run has no evidence and must not conclude `is_missing` on rows it did not look at. The rename detection is the one exception: it is a `dirs` test and costs nothing, and a Finder rename of a root-level folder *is* delivered by the watcher.
- **A missing bin root is a skip, not a throw**, and not an empty walk either: the run remakes the folder, records its new identity and leaves every binned row alone. Not for a read-only library, which keeps the bin it had from before the flag and whose photographer may have deleted that folder deliberately - remaking it would be a write under a root the app may not write to.
- **Only a candidate that still might be the bin is excluded from the live walk.** Exclusion is unconditional while the identity is ambiguous, because any of those folders may be the bin. It is *not* applied to one already shown not to be - a folder that inherited the freed inode and holds none of the bin's files - because dropping a real shoot from the live walk marks its photographs missing, which is the same harm as following it reached more quietly.

The two conditions on rewriting `bin_name` are worth stating exactly, because getting the second wrong is what makes the first useless. The recorded path must fail to `stat`, or resolve to a **different** `dev:ino` - not merely be absent, since a case-only rename on a case-insensitive filesystem still resolves, to the same inode, and is handled by exclusion alone. And the candidate must **hold a file some binned row claims**, tested by looking for that file *inside the candidate*: asking whether the library has anything in its bin is true of every library that has ever binned anything, and lets the recycled inode straight through.

So how often the bin is reconciled depends on the nightly full sync (`full_sync_at`) and on the watcher's 256-path fallback. A large hand-managed change self-corrects promptly; three files dropped in by hand stay under the threshold and wait for a full run. The Settings copy for `full_sync_at` names the bin among what the nightly run reconciles, so turning it off is an informed choice.

Result per library:
```typescript
interface LibraryDiff {
  libraryId: string;
  removed: Array<{ filePath: string; photoId: string; fileHash: string }>;
  added: Array<{ filePath: string; fileHash: string; metadata: FileMetadata }>;
  modified: Array<{ filePath: string; photoId: string; oldHash: string; newHash: string; metadata: FileMetadata }>;
  reappeared: string[];  // photo ids present at their original path, currently is_missing
}
```

### 9.2 File Hash

The file hash is a SHA-1 digest of the following metadata properties, concatenated in a deterministic order:

1. File extension (lowercase, e.g. `.arw`, `.cr3`)
2. Image width (pixels)
3. Image height (pixels)
4. Date modified (filesystem mtime, ISO string)
5. Color space (string identifier; the constant sRGB output space, see §11.1)
6. File size in bytes
7. Orientation/rotation (EXIF orientation 1 to 8, or `0` if not present; rows written before the decoder changed hold LibRaw's `flip` code instead, §11.1)

**mtime is included** so an in-place pixel edit that preserves dimensions/size/orientation is still detected as MODIFIED and re-processed (without it, such an edit is invisible). Note the tradeoff: an import/restore that resets mtime without changing content will spuriously mark untouched photos MODIFIED and re-process them. A pure backup *read* (this server as rsync source) does not change mtime, so ordinary cloud backups do not trigger this.

**Critical rule:** Under no circumstances should the hash computation read past the file header/metadata. Every supported format keeps its metadata at the front of the file - an ARW is a TIFF, a CR3 puts its EXIF in a `CMT2` box near the head of `moov` - so reading resolution and orientation is safe. The implementation must not decode pixel data.

The hash input string is formatted as:
```
<extension>|<width>|<height>|<mtime>|<colorspace>|<filesize>|<orientation>
```

Then: `sha1(inputString)` → hex string.

### 9.3 Phase 2: Move Detection

After **all** libraries have been scanned, process the diffs to detect moves. Move detection operates **per-library** (a file moving between libraries is treated as a delete + add).

For each library's diff:

1. Build a `Map<fileHash, RemovedEntry[]>` from the removed list.
2. Build a `Map<fileHash, AddedEntry[]>` from the added list.
3. Also consider modified entries: a modified entry means the file at that path has a **new** hash. The **old** hash of a modified file could match an added file elsewhere (the original was moved, and a modified copy replaced it). See the special case below.
4. For each hash that appears in **both** the removed map and the added map:
   - Pair them up as moves (one removed + one added = one move).
   - If there are more removed entries than added entries for the same hash, the excess remain as removals. When choosing which to keep as moves, **prefer keeping photos that are in albums** (query `album_photos` for the photo IDs). This preserves album membership.
   - If there are more added entries than removed entries, the excess remain as additions.

**Special case — modified + added with original hash:**

If a file at path A has been **modified** (hash changed from H1 to H2), and there is an **added** file at path B with hash H1:

- This means the original file (H1) was moved to path B, and a modified version (H2) now exists at path A.
- The correct interpretation: update the existing photo record at path A with the new hash H2, and create a new photo record for the file at path B (which has hash H1).
- Do **not** move the existing record to path B.

To implement this: before processing moves, iterate over modified entries and check if their old hash appears in the added map. If so, keep that entry in the added map so it becomes a new photo (do not treat the modified file's old hash as a move source), and leave the modified entry as-is (the existing record gets updated with the new hash).

5. The final move list:
```typescript
interface MoveEntry {
  photoId: string;          // from the removed entry
  oldFilePath: string;      // from the removed entry
  newFilePath: string;      // from the added entry
  fileHash: string;
}
```

### 9.4 Phase 3: Apply Changes

Process in this order within a database transaction:

1. **Moves:** Update the recipe's path for each moved photo (§4.2.1). Clear `is_missing` if it was set. **Reconcile shoot membership from the destination path:** if `newFilePath` falls under a known shoot's `folder_path`, set the photo's `shoot_id` to the **most-specific (longest-matching) `folder_path`** shoot (so a file under `NYC/Day1` maps to `Day1`, not the ancestor `NYC`); if it moved out to the library root (or a non-shoot folder), clear `shoot_id`. This keeps DB shoot membership consistent with files the user relocated on disk directly (rather than via the shoots API).
2. **Modifications:** Update `file_hash`, `width`, `height`, `orientation`, `date_updated`, and both pending flags for each modified photo, plus any other changed metadata columns (GPS, `date_taken`). Clear `is_missing` if it was set.
3. **Additions:** Insert new photo records:
   - `id` = a new entity ID, drawn through `withNewId` (§3)
   - `library_id` = the library being synced
   - `recipe` = a `file` recipe naming the relative path from the disk scan (§4.2.1)
   - `file_hash` = computed hash
   - `width`, `height`, `orientation` = from metadata
   - `shoot_id` = the most-specific (longest-matching `folder_path`) shoot containing this file, else NULL
   - `date_added` = current server datetime, normalized to UTC (§4)
   - `date_taken` = UTC-normalized EXIF capture time (§11.1) if available, else NULL
   - `date_updated` = filesystem mtime
   - `latitude`, `longitude` = from EXIF GPS data if available
   - `needs_tile = 1`, `needs_renditions = 1`
   - `is_missing = 0`
   - `is_deleted = 0`
   - `rating = 0`
   - `triage = NULL`
4. **Reappearances:** Clear `is_missing = 0` for each reappeared photo. No other change (content and path are unchanged).
5. **Removals:** Set `is_missing = 1` for each removed photo. Do not delete files or records. Count only photos that transition `is_missing` from `0` to `1` toward `photos_removed`; a record already at `is_missing = 1` reappears in the removed list every scan (so delayed move-matching in §9.3 can still pair it), but it is not a new removal and must not be re-counted. This keeps `photos_removed` a per-sync delta consistent with `photos_added`/`photos_moved`/`photos_modified`.

**A run with no rows commits as it scans, in batches of 1000 files or two seconds, whichever comes first.** The time bound is what a small library depends on: the scan builds each photo's grid tile while the RAW is open (§10.4), so a batch of a thousand is minutes of work, and an import smaller than one batch would show an empty library for the whole run. A first import is hours of opening and hashing, and one closing transaction makes all of it contingent on reaching the end: kill the server at hour three and three hours of decodes are gone, with the next run starting from nothing. Applying a *partial* scan is normally unsafe for the reason §9.10 gives (absence from a half-built `present` set reads as a removal), but that reasoning needs rows to be absent from. When `dbPhotos` is empty (a library's first sync, and a scoped sync whose paths are all new) the diff can only be additions: no removal can be derived, so no move can pair either. Each batch is then true on its own, whatever the scan goes on to find, and a killed import resumes at the batch it reached rather than at zero; the rows it wrote carry the mtime and size that make §9.1's quick-check skip them, so the resumed scan does not re-open them either.

Only that case qualifies. Against a populated library an addition can still turn out to be the far half of a move, so its inserts stay in the closing transaction where move detection can still claim them. Shoot membership is safe to resolve early for the same reason a batch is: a shoot relocation (§9.4.1) takes existing photos to move, and a run with no rows has none.

### 9.4.1 Shoot reconciliation

Two steps wrap the apply phase, and both exist because **the folders on disk are the truth and the shoots are the catalogue's account of them**. Relocation runs *before* step 1, so membership is resolved against corrected paths rather than being cleared and rebuilt; mirroring runs *after* the transaction, once the scan's folders and photo counts are settled.

**Relocation: a shoot's folder moved.** Nothing on disk distinguishes a renamed folder from one deleted and another created, and the watcher cannot help - the kernel pairs the two halves of a rename with a cookie that no portable JS watcher exposes. Two independent answers, tried in order:

1. **The inode.** A shoot records its folder's `ino` and `birthtimeMs` (§4.3), and the scan already walks every directory, so it can key them by `dev:ino` as it goes (the same key `scanFiles` uses to collapse hardlink pairs). A shoot whose `folder_path` is gone, whose recorded identity turns up at another path, **is** that folder: not an inference, so no time window, no all-or-nothing photo test, and no need for the folder to hold any photos. It resolves a rename made while the server was down just as well as one made while it was running, which no watcher event can do.
2. **The photos** (`detectShootRelocations`, `scan_relocations.ts`). If every file that was under `A/` is now under `B/`, each keeping its position within the folder, then `A` became `B`. Deliberately all-or-nothing: a partial match means files were also added, removed or reshuffled, so the folder's identity is genuinely ambiguous and a wrong guess silently adopts someone else's folder. `folderStillOnDisk` separates a folder that moved from photos merely reorganised inside one that did not - sorting a shoot's frames into a new `Selects/` subfolder moves every one of them keeping each filename, which is indistinguishable from a rename by the paths alone.

The second is not redundant once the first exists: a move to **another filesystem** (a copy under the covers) mints a new inode, and so does a restore from backup, where every inode in the library is new at once. The inode answers precisely, the photos answer approximately, and the cheap precise one is asked first.

Either way the whole subtree follows by prefix, and descendant shoots come with it. A relocated shoot also answers every photo move beneath it at once - the paths shift by a prefix and membership does not change - so those moves drop out of the per-photo loop and the folder becomes two `UPDATE`s rather than one per frame.

**The gap this leaves**, deliberately: create `B`, copy the photos over, then delete `A`, *while the server is running*. The sync after the copy imports `B` as new photos while `A` still exists, so when `A` goes there are no additions left to pair with its removals. No moves, therefore no relocation by either route - the shoot's photos go `is_missing` and the copies in `B` belong to no shoot. Reconciling that is a photo-level problem rather than a shoot-level one (the same thing happens to a single photo copied and deleted with no shoot involved), so it belongs to the deferred flow that lets the user pair a missing photo with its counterpart, not here. Done in one `mv`, or with the server down, it is a single diff and route 2 handles it.

**Mirroring: folders become shoots.** After the transaction:

- Every folder holding at least one non-deleted photo, with no shoot and no `plain` rule (§4.7), gets one. `name` is the folder's own name, `parent_id` is derived from `folder_path` exactly as `create` derives it (§8.5), and the identity columns are filled from the walk.
- Shoots whose folder no longer exists **and which hold no photos** are deleted. Both halves are required: a folder that is gone but still has rows is a library whose files went missing, not a shoot to discard.
- Existing shoots are matched by `folder_path` **only, never by name**, so a shoot the user has renamed is not seen as absent and recreated as a duplicate beside itself.

Folders that hold no photos of their own are **not** made into shoots, even when their descendants are. A pass-through folder is structure rather than a set of photographs, and the Shoots page draws the hierarchy from the shoots' own `folder_path`s (§18.3.4), so nothing is lost by leaving it out - and a shoot record that exists only to be a spacer is one more thing to name, count, delete and explain.

### 9.5 Phase 4: Trigger Processing

After all changes are applied, call `ProcessingService.processUnprocessed()` to begin background generation for every photo owing either stage (`needs_tile` or `needs_renditions`) with `is_missing = 0`.

**A scoped run passes the photos it reconciled; a full run passes none, meaning the whole library.** The watcher fires on one changed file, and draining everything the library still owes off the back of that is not what the change asked for, quite apart from making the strip report that one file as a thousand outstanding renditions. So a scoped sync hands over the ids it inserted or modified (moves and reappearances changed no pixels, so they owe nothing), and the status counts against that same set.

That leaves the backlog to the two triggers that are *about* the whole library: a manual `POST /sync` and the daily reconcile (§9.8). This is deliberate, and it is what picks up work a killed process left half-done; nothing runs at startup (§9.6).

`ProcessingService` merges concurrent requests for one key by widening, never narrowing: a full run joining a batch a scoped run started comes away having processed the library, not that run's handful of files.

### 9.6 Sync Status Tracking

The sync service maintains an in-memory status object per library:

```typescript
interface SyncStatus {
  libraryId: string;
  status: 'idle' | 'processing' | 'rendition';
  photosToScan: number;
  photosScanned: number;
  photosAdded: number;
  photosRemoved: number;
  photosMoved: number;
  photosModified: number;
  photosProcessing: number;
  photosProcessed: number;
  photosPerSecond: number | null;
}
```

This is updated as the sync progresses and is exposed via the API for client polling.

**The scan is `processing` and the rendition backlog is `rendition`.** The walk is not only a walk - it opens, hashes, reads metadata and builds each photograph's grid tile (§10.4) - so naming it after the cheapest thing it does undersold it to the one client that reads this. The second phase is named for what it builds.

**Both phases of a run report progress, not just the second one.** `photosProcessed` against what was queued covers rendition building; `photosScanned` against `photosToScan` covers the scan, which on a first import is the longer of the two: minutes of opening and hashing every file, during which a status that only carried zeros left the client with a phase name and nothing else. The counters are updated from the loop that opens and hashes, which is where a scan's whole cost is (the `stat` pass before it opens nothing), and `photosToScan` is only known once that pass has collapsed hardlink pairs, so a run reads 0/0 for the walk and the stats, then counts through the files. Both settle on the number of files found, so the client renders one bar per phase off the same pair of numbers.

**The rate a first scan reports is what its last committed batch managed**, `photosPerSecond`, measured across the batch (§9.4) rather than sampled between two of a client's polls: the workers land in bursts, and a figure taken between two polls a second apart swings by a factor of several, which is a figure nobody can read an ETA off. The clock starts at the first progress report rather than at the top of the run, so the `stat` pass - which opens nothing - does not drag the first batch's figure down. It is null in every other phase, which have no batches to time; the client counts its own polls there, over a five-second window.

No generation guard on those writes, unlike the ones after the scan: the sync lease is not released until scan and apply are both done, so no newer generation of the same library can exist to stomp.

**A process with no status in memory reads the outstanding work off the database.** The status object does not survive a restart, but the work does: `needs_tile` / `needs_renditions` are columns, so a library the last process had half-imported comes back owing exactly what it owed. Reporting a flat `idle` with zeros there is a lie the client cannot see past; the strip would show nothing to do while thousands of renditions were missing. `getScanStatus` therefore falls back to `countPendingProcessing` and reports it as `photosProcessing` against `idle`: work waiting, not work running.

**Nothing starts it.** Startup wires the watcher, the daily reconcile and the prune, and triggers no sync (`src/index.ts`); reading the status does not either. A restart mid-import resumes when the user asks, when the watcher sees a file change, or at `SYNC_FULL_AT`, and the status is what tells them there is something to ask for. Automatic resume would mean a server that comes back up saturating its cores on a job the user may have killed it to stop.

`last_synced_at` is the other half of this, and the durable one: it is a column, so it survives the restart the status does not, and says how stale the catalogue is (§4.1).

### 9.7 Sync Lock

Sync is locked **per library**, so two different libraries can sync concurrently while the same library cannot be synced twice at once. The lock is a **leased row** in `sync_locks`, keyed by library id and holding an owner token minted per acquire, plus the ISO instants the lease started and was last refreshed. It guards the catalogue rather than the tree, which is where it belongs: the tree is what a read-only library forbids writing to, and a lock file at the root was one write per library that had nothing to do with the photographs.

- `scanLibrary(id)` acquires the lease with a single upsert whose `WHERE` clause is the staleness test, so there is no check-then-claim window; if a live holder keeps it, `SYNC_IN_PROGRESS` (409).
- `scanAll()` acquires each library's lease independently as it processes it; a library whose lease is held is collected and **re-attempted once** at the end of the loop, by which point a lease left by a killed process has lapsed.
- **Stale-lease recovery:** a lease is reclaimable 30s after its last refresh. A run refreshes from the work rather than from a timer - the walk, both scan loops and each insert batch - because the scan and apply are synchronous and a `setInterval` is starved precisely when the lease matters.
- The lease is released in a `finally`, scoped to its own owner so a late release cannot delete a successor's lock. The apply re-reads the owner as the first statement of a `BEGIN IMMEDIATE` transaction and rolls back on a mismatch: it is the one stretch no refresh point can reach.

Liveness deliberately does not depend on a PID. `process.kill(pid, 0)` asks in the *asking* process's PID namespace, which is not the one the number was minted in: two containers over one volume would either refuse to sync for ever (B finds its own init at A's PID 1) or both sync at once (A's PID 37 does not exist in B). A timestamp means the same thing everywhere.

The in-memory `SyncStatus` (§9.6) is process-local and lost on restart; the `sync_locks` row is the cross-process source of truth for "is this library syncing". A row present at startup means "stale within 30 seconds", not "syncing", so startup deletes nothing.

### 9.8 Sync Triggers: Creation, Manual, Scoped Watcher, Polled Root, Daily Backstop

`scanLibrary` runs in five ways:

0. **On creation**, from `LibrariesService`'s lifecycle listener. A full scan, not awaited by the create: the request answers as soon as the row exists, and a first import is minutes of opening and hashing that the status endpoint reports on like any other run (§9.6). A library nobody has imported holds nothing, so making that import a second, separate button leaves the answer to "where are my photographs" sitting behind one - and the settings a create asks for (subfolders, the bin name) are exactly the ones that decide what this scan brings in, which is why they are on the dialog rather than in Settings afterwards (§18.3).
1. **Manual**, `POST /api/libraries/:id/sync`. A full scan (whole tree).
2. **Scoped (watcher)**, the `LibraryWatcher` accumulates the changed relative paths in each debounce window and calls `scanLibrary(id, { paths })`. A scoped sync **does not walk the tree, and does not read a directory either**: it stats the changed paths themselves and reconciles them against the DB rows at those paths, plus every already-missing row (the move-source pool). Its cost scales with the number of changed paths, not with library size and not with how many photographs sit beside them.
   - File-scoped, because the watcher names both halves of a move (§9.8). A `readdir` of each changed path's parent would find a target that was never reported - insurance against an event stream already chosen for reporting both halves, paid for on every scoped run by reading a directory that may hold thousands of frames. A move whose halves land in different windows still pairs, through the missing pool rather than through the directory.
   - The failure it gives up on is visible and repairable: a target nothing reported leaves the photograph flagged missing in the UI, and a manual sync (or the nightly full reconcile) restores it. Which is also what a modification nothing reported does, and what every change made while the server was down does.
   - A debounce window with more than 256 distinct changed paths (bulk import) falls back to a full sync.
3. **Polled**, for a library whose root is on a filesystem that delivers no events at all (below). `LibraryWatcher` walks the folders it contains every `watch_poll_interval_ms` (default 20s), and calls `scanLibrary(id, { dirs })` with the ones whose mtime moved. A poll sees *that* a folder changed and never *which* file did, so those two shapes are what a scoped run reconciles: a named path is stat'ed, a named folder is listed against the rows recorded directly in it. Direct children only, in both directions - descending would list files whose rows were never fetched, and read every one as an unclaimed addition. The 256-path fallback covers both together.
   - A folder that could not be read says nothing rather than emptying itself: only a folder actually listed contributes its rows to the diff, so a permissions error or an unmounted root leaves its photographs alone. `ENOENT` is the exception, because an empty listing against the rows recorded in it is exactly how a deleted folder becomes a folder of removals.
   - What it cannot see is a file rewritten in place under an unchanged name, which moves no folder's mtime. The daily reconcile catches those, as it does the events a watch drops.
4. **Daily full reconcile**, `DailyScan` runs `scanAll()` once a day at `SYNC_FULL_AT` (local `HH:MM`, default `03:00`, `""` disables), overlap-guarded and re-scheduled each day so it holds its wall-clock time across DST. This is the correctness **backstop** for anything the event-driven watcher missed: dropped or coalesced events, and every edit made while the server was down. It's overnight by default because a full scan holds the library mutex (§9.9) for its whole duration.

**The watcher is `@parcel/watcher`, not `node:fs` and not `chokidar`.** Two independent requirements, and only one library meets both.

*It has to name where a folder went.* Measured against a real tree, Bun's recursive `fs.watch` reports a directory rename, a directory *move*, and an `rm -rf` identically: one `rename` event naming only the **source**. The destination is never named, even when it is inside the watched tree. That is enough to know something left and nothing about where it went, so a folder rename could only be resolved by the nightly full walk.

*It has to cost one watch per directory.* This is where `chokidar` fails, and the reason it was tried and dropped. It calls `fs.watch` on every **file** as well as every directory: measured on a 200-directory, 10,000-file tree, 10,201 inotify watches and 120 MB against `fs.watch`'s 201 and 34 MB. A 300k-frame library therefore wants ~300k watches, against a kernel default of 8,192 and a common distribution default of 65,536. Past the limit it emits an error *per failing path*, so the retry below would re-walk the whole tree every five minutes for ever. The per-file watches buy nothing either: the handler keeps only the path, and the directory's own watch already reports its children.

`@parcel/watcher` takes 204 watches and 35 MB on that same tree, settles in 55 ms, and names both halves of every move - same level, into a subfolder, out to the root - including the rename of a folder holding no photographs, which §9.4.1's photo evidence structurally cannot see. Its `ignore` list takes the data directory, the bin (§12.3) and the excluded folders, so none of those subtrees is walked at all rather than filtered afterwards, and the per-event check applies the scan's own rules (§9.1) so the two cannot disagree about what the library contains. The bin earns its place there twice over: it is one known path, and it only grows, mirroring the whole folder tree as photographs are binned.

**An event the library does not contain schedules nothing.** Arming the debounce for every batch handed over and deciding relevance afterwards, per path, lets a batch where nothing survived that filter run the timer down to a sync with an empty path set - which is a *full* one, because an empty scope is how a dirty re-run asks for the whole tree. A batch that records nothing arms no timer, which answers the class rather than each path that raised it. (The sync lock is the standing example of what that would catch: a file at the library root would have every sync's own lock wake the watcher that started the next one, for ever. It is a row, §9.7, and writes nothing under the root at all.)

**Nor does a file the library will never hold.** A text file, a sidecar, a JPEG export saved beside the raws is in scope by *path* - `isPathAllowed` is about folders - so handing it to a scoped sync like a candidate photograph spends a whole sync run (a mutex, a lease, a transaction, a settled announcement) concluding it was never one. The watcher settles it instead, with one `stat`, asked only of paths whose extension is not one of ours (§7) so a bulk import stats nothing extra. A folder always passes, because an empty one's rename reports no other event at all and dropping it would lose the shoot relocation (§9.4.1); so does a path that is already gone, which is a deletion and could have been either.

It is a native module, which is why its prebuilt bindings matter: they cover linux x64 and arm64 in both glibc and musl, plus macOS and Windows, so nothing is compiled at install time on any platform this runs on.

**The one place it cannot go is the desktop app's own bundled server**, which is a single compiled file with no `.node` beside it. So `watch_backend.ts` *asks* for the addon rather than importing it, and where the answer is no - there, and nowhere else - stands up Bun's recursive `fs.watch` behind the same interface. That arm gives up both measured properties above: an ignored subtree costs a watch descriptor because it is filtered after the event, and a move arrives as two unrelated paths. Neither is a correctness loss, because a move is detected by hash rather than by being told (§9.4.1) and both halves land in one debounce window. What it must not give up is the *shape*: an unmounted root has to reject, as parcel's does, because §9.8's retry loop is armed off that rejection and a subscription that resolved while watching nothing is one the watcher holds - and holding one is what makes it skip every retry after.

A moved folder reports as the folder, with no per-file events beneath it. That is enough: §9.4.1 identifies it by inode and the subtree's paths shift by a prefix, which is two `UPDATE`s rather than one per frame.

**A library on a network filesystem is polled instead, and the two never both run for one library.** inotify is a hook in *this* kernel's VFS: it fires for changes this machine performed. A photograph copied onto the NAS by another client lands on the server and never crosses our mount, so there is no event to deliver and the watch sits healthy and silent - the failure looks exactly like nothing having happened. Nothing in the Linux NFS client fixes this. NFSv4.1 specifies directory delegations (`GET_DIR_DELEGATION`/`CB_NOTIFY`) for precisely this, and neither the Linux client nor knfsd implements them; `fanotify` is the same VFS layer and refuses network filesystems outright. So `src/utils/fstype.ts` reads `/proc/self/mountinfo` for the filesystem the root resolves onto - longest matching mount point, a later line winning a tie, since that is what an overmount means - and anything remote takes the poll path rather than a watch. A host that cannot answer (not Linux) is watched, which is the behaviour every local root already had.

Polling only folder mtimes is what makes 20 seconds affordable. A folder's mtime moves when an entry is added to it, removed from it or renamed in it, so a pass is one `stat` and one `readdir` per folder rather than a `stat` per photograph: measured over NFS on a 30,521-file, 226-folder tree, **68 ms against 4.7 s** for the same walk stat'ing every file. It is re-armed at the end of each pass rather than on an interval, so a slow walk - or the sync that follows it - is never overlapped by the next one. The mount's own attribute cache is the floor on freshness regardless (`acdirmax`, a minute by default), which is the real argument against a much shorter interval.

### 9.9 Library Mutex

Sync snapshots the DB, then scans **asynchronously**, then applies. A user mutation that moves files (shoot add/remove/rename, photo delete) landing mid-scan would make that snapshot stale. `libraryMutex` (one process-global instance) serializes those mutations against sync **per library**: whoever arrives second queues rather than failing, since these are interactive requests.

- `scanLibrary` takes the sync **lease first, then the mutex**. Lease-first keeps sync-vs-sync fail-fast (`SYNC_IN_PROGRESS`, 409, §9.7); the mutex only makes *mutations* wait. Mutations never take the lease, so there is no cycle to deadlock on.
- The mutex is acquired at exactly one level per operation (e.g. in `rename`, not its caller `update`), since it is not re-entrant.
- This closes the mutation-vs-scan race class at the source, rather than guarding each symptom. The per-write guards it supersedes are kept anyway (path-guarded `setMissing`, the `(dev, ino)` collapse, the re-checks before FK writes) because they also cover the cross-process case the in-memory mutex cannot.

### 9.10 Stopping a sync

`DELETE /api/libraries/:id/sync` aborts the library's current run. The generation token (§9.6) *is* the `AbortController`, so "which run" and "how to stop it" are one thing, and a stop can never reach a newer generation than the one that was asked for.

What a stop means depends on which phase it lands in, and neither leaves anything half-applied:

- **During the scan**, the loop that opens and hashes checks between files, so a stop lands within one file's decode rather than at the end of the walk. On a populated library every write is a single transaction *after* the scan, so abandoning it applies nothing: `scanLibrary` returns an idle status rather than raising, because the caller asked for this, and the detached processing in its `finally` never starts.
  - **Except on a first scan, which keeps what it reached.** A half-built `present` set is normally unusable, and dangerously so: absence from it is how §9.1 detects a removal, so applying a truncated scan would mark every file it had not got to as missing. That reasoning needs rows to be absent from. When the run has none - `dbPhotos` is empty, which is a library's first sync, and also a scoped sync whose paths are all new - no removal can be derived, and therefore no move either, since a move pairs a removal with an addition. All a stopped scan can then hold is "these files are new", which is as true of a scan that saw half the library as of one that saw all of it, so it is applied and the files it never reached are simply added by the next sync. Otherwise a stopped 50k-frame import would throw away every file it had already read and hashed.
  - That case is exactly the one §9.4 commits in batches, so most of what a stop keeps is already on disk before the stop arrives; all the stop itself adds is the tail of the batch in hand. A kill is the same event without the courtesy of asking, and it keeps the same work for the same reason.
  - The stop is still a stop: the processing that follows a partial commit is handed the same aborted generation, so it queues nothing and the photos land owing their renditions. `last_synced_at` is stamped, which says when a sync last ran rather than that the catalogue is complete.
- **During processing**, the pool retires each worker as its current job lands instead of killing it mid-encode, which would leave a half-written rendition. What is already on disk stays - a tile is valid whether or not the rest of the run finished - and the photos it never reached keep their `needs_tile` / `needs_renditions` flags, so the next sync picks them up. The status settles to idle through the same tail that a completed run does.

**The pool is asked whether to stop, rather than handed a signal.** A batch is keyed by library and outlives the sync that started it: a later sync of the same library coalesces into the running batch (§10.2) and whatever it passed is dropped by that dedup. Given a fixed `AbortSignal`, the batch would go on watching a generation that has already finished, and a stop aimed at the current one would reach nothing; the button would do exactly nothing, silently, and only when two syncs happened to overlap. `ScanService` therefore passes a predicate that reads whichever generation is current at the moment it is asked.

Deleting a library aborts its run for the same reason: its rows are cascade-gone, so there is nothing left to finish.

**Why the full scan stats every file.** Skipping the stat for files in directories whose mtime is unchanged was tried and removed: the stat is the *only* cost it saves (the mtime+size quick-check already skips the expensive decode for unchanged files), and skipping it also skips the `(dev, ino)` collapse that `moveIntoDir`'s non-atomic `link()`-then-`unlink()` window depends on. A cross-directory move bumps only the destination directory's mtime, so the source stays "unchanged" and is pruned; the destination is then inserted as a new photo while the source row survives, leaving a duplicate. Making it safe means restoring the stat, which leaves no saving.

---

## 11. Metadata Extraction (`metadata.ts`)

Used during sync to populate photo records and compute file hashes.

### 11.1 Implementation

Metadata is read by the same reader as the decode (§10), which is rawler for every format. That it comes from a RAW decoder at all rather than from a general image library is worth keeping the reason for: libvips, while it was here, had no RAW loader at all, and coaxed into opening an ARW as a generic TIFF it reported the embedded preview's dimensions rather than the full-res sensor values.

For every supported format, metadata comes from **a header parse in `native/rawshim/src/header.rs`**: `get_decoder` then `raw_metadata` for the EXIF block (orientation, capture time, GPS, exposure, body and lens), plus one *dummy* `raw_image` for the shape, which reads the frame's dimensions and `crop_area` without decompressing anything. No pixel data is decoded, and this is the fast path used per file during scan. The dimensions come from that dummy decode rather than from EXIF deliberately: EXIF describes the picture the camera would have made, and the recommended crop and the orientation both move it, where the catalogue's row has to agree with the rendition it will show. `colorSpace` is the constant `sRGB`: nothing reads a per-file source space, and the field exists as informational metadata and a stable, non-varying hash input rather than as something measured. The EXIF capture time is naive (the tag carries no zone), and `header.rs` parses `DateTimeOriginal` itself and treats it as UTC, so the seconds it hands back re-encode as a `Z` UTC ISO string (§4) that stores the camera's wall clock verbatim whatever the server's zone is. A decoder exposing the time only as a `time_t` derived with `mktime` forces a round trip through the process's own zone, and reading that back as an instant slides every capture date by the server's offset. The stored value is a wall clock rather than an instant, so the client formats it in UTC (`captureDateTime`) rather than in the viewer's zone, which would slide it a second time. The zone itself comes from a second, direct read of the file: `exif_zone.ts` walks IFD0 into the Exif IFD and returns `OffsetTimeOriginal` (0x9011), falling back to `OffsetTime` (0x9010), into the `date_taken_offset` column. An ARW *is* a TIFF, so that walk starts at byte zero. A CR3 is an ISO base-media file, so the box tree is walked first - `moov` into the `uuid` box, to `CMT2`, which holds the Exif IFD as a complete little TIFF of its own - and the same IFD reader takes it from there. Bounded to the first 256KB, so it costs a page or two rather than a read of a 25MB file, and null when a pointer leads past that window. The tags arrived in EXIF 2.31 (2016), so older bodies record nothing and the column stays NULL: a Sony ILCE-7CR and a Canon EOS R8 both write `+11:00`, an ILCE-6300 writes no offset at all. Blank and malformed values ("      ", `+1100`) are read as absent rather than as UTC. It is deliberately not a hash input (§9.2), for the same reason `dateTaken` is not: the hash is a change detector for a file the scan has already decided to open, which only happens once mtime or size differs (§9.1), and mtime is itself hashed. Descriptive metadata therefore adds no detection the hash does not already have. Rewriting the zone tag in place while preserving mtime and size defeats the quick-check before a hash is ever computed, so hashing it would not catch that case either. `date_taken` stays the wall clock either way, so ordering and the date filters are unaffected by whether a body recorded a zone; the offset is what the viewer shows beside the time and what a true instant would be derived from. The reader also `stat`s the file to fill `mtime`/`fileSize`, so the scan-time result carries them all the way to Phase 3 apply (§9.4) without a second `stat` inside the transaction.

**A parsed GPS block is not the same as a fix.** Canon sets `gpsparsed` on every frame and leaves the degree triples at zero when the body had no fix, so trusting the flag alone put a whole catalogue at 0,0 - which is not a null, it is a point in the Gulf of Guinea, and it maps. An all-zero latitude *and* longitude therefore reads as "not recorded".

`width`/`height` are the **display (upright) dimensions**, i.e. after the orientation is applied. What the dummy decode reports is still in **sensor orientation**, so the reader swaps the two axes itself for EXIF orientations 5 to 8. This is deliberate: the generated renditions are baked upright (§10.4), so storing upright dimensions means `width`/`height` always match the served rendition's aspect. `orientation` is retained separately only as informational metadata and as a file-hash input (§9.2); **clients must not apply it to the served renditions, which are already upright** (doing so would double-rotate).

**`orientation` is the EXIF tag, 1 to 8, and it did not always mean that.** LibRaw handed over dcraw's `flip` encoding - 0/3/5/6 - and rows written before the decoder changed still hold it; nothing rewrites them, because the column is informational and a re-scan of a changed file overwrites it anyway. The name has stayed put through both, so read it as "whatever the reader of the day recorded" rather than as one encoding.

```typescript
interface FileMetadata {
  width: number;   // display/upright width (post-orientation)
  height: number;  // display/upright height (post-orientation)
  colorSpace: string;
  orientation: number;   // EXIF orientation, 1 to 8; informational only (see note above)
  dateTaken: string | null;  // ISO datetime
  latitude: number | null;
  longitude: number | null;
  iso: number | null;
  shutterSpeed: number | null;  // seconds; 1/250s is 0.004
  aperture: number | null;      // f-number
  focalLength: number | null;   // mm
  cameraMake: string | null;
  cameraModel: string | null;
  lensModel: string | null;
  mtime: string;   // filesystem mtime, ISO datetime; hash input (§9.2) and date_updated source (§9.4)
  fileSize: number;  // bytes; hash input (§9.2)
}

async function extractMetadata(filePath: string): Promise<FileMetadata> {
  // stat() + the rawshim header parse, no unpack
}
```

Body and lens come from the metadata block: `make`/`model`, and `lens.lens_name` falling back to the EXIF `LensModel`. A fixed-lens body leaves the lens blank or writes `---`, and both spellings are stored as NULL (`rawshim_ops.ts`): "unknown" rather than a lens named `---`.

**Sensor crop.** The readable sensor is larger than the picture: there are masked columns carrying the black level and rows the manufacturer does not consider valid. Decoding that area verbatim bakes black bars down two edges of every rendition, so both the header read and the decode crop to `crop_area` - the manufacturer's own recommended crop, which is also what the camera's embedded JPEG shows - and fall back to the whole frame where the file states none. The two paths must agree: the stored `width`/`height` describe the picture the rendition shows, and `decodes_the_frame_the_camera_says_it_took` and `the_recorded_dimensions_are_the_dimensions_that_get_decoded` pin them together.

**The arithmetic this replaced is worth recording, because the failure it caused looked plausible.** LibRaw emitted a frame already trimmed to its own margins and stated the camera's crop separately, so only the part of that crop falling outside the emitted window was ours to remove - and subtracting it from the raw frame instead double-applied it on every body where the margin was already the crop origin, which is every Canon. An EOS R8 lost a further 168 columns and 108 rows, and because the excess came off two sides rather than four the result was not a smaller picture but a differently framed one: 5811x3879 where the camera's own JPEG is 6000x4000, shifted up and left. It also cost the JPEG match (§10.5), which models an overall rescale but has no term for a translation: acceptance across 27 EOS R8 frames was 15/27 before and 27/27 after, median deltaE 4.11 to 1.89, against 27/27 and 1.35 for a Sony set of the same size. Three Sony geometries were over-cropped by 8-32 columns on the right edge by the same arithmetic, which is why it was not a Canon special case. With one stated crop and nothing already applied to it there is no second window to measure against, and the whole class is gone; the frame moved by a couple of dozen pixels of border in the process, LibRaw having emitted 4024x6024 and 3999x5999 where the manufacturer says 4000x6000 on both.

The header struct crossing the FFI is `#[repr(C)]` and ours rather than an upstream C layout, and its size is checked at the first call, so a field that moves is a mismatch rather than plausible garbage - which is what six tables of hardcoded offsets into five C structs would risk. `raw_header.integration.test.ts` pins the known-correct values for the checked-in fixture.

### 11.2 Hash Computation (`hash.ts`)

```typescript
import { createHash } from 'crypto';

function computeFileHash(filePath: string, metadata: FileMetadata): string {
  const ext = path.extname(filePath).toLowerCase();

  const input = [
    ext,
    metadata.width,
    metadata.height,
    metadata.mtime,
    metadata.colorSpace,
    metadata.fileSize,
    metadata.orientation,
  ].join('|');

  return createHash('sha1').update(input).digest('hex');
}
```

---

## 12. Deletion

When a user requests deletion of one or more photos:

### 12.1 Steps

For each photo:

1. **Keep the renditions.** They are *not* removed. The Bin is a view the user browses to find something to restore, and it is useless if every frame in it is a grey placeholder. The two AVIFs are roughly 1% of the size of the RAW the Bin is already retaining, so deleting them saves almost nothing and costs the feature. They are removed only when a photo is permanently purged.

2. **Move the RAW into the Bin, if this library has one:**
   - Determine the bin path, where `<bin>` is the library's `bin_name` (§12.3): `<library_root>/<bin>/<folder the photo was in>/<original_filename>`. A photo at `A/B/c.arw` bins to `<bin>/A/B/c.arw`; one in the root bins to `<bin>/c.arw`.
   - If a file with the same name already exists in the Bin, append a numeric suffix (e.g. `IMG_0001_1.ARW`, `IMG_0001_2.ARW`).
   - Move (rename) the file. Do **not** copy-and-delete.
   - **A read-only library takes neither step.** Nothing moves, no directory is made, the recipe's path is left alone and `deleted_from_path` ends up equal to it. A row with no file of its own takes the same branch, there being nothing to move (§4.2.1). This is not new machinery: it is the branch a photo whose file had already gone has always taken. The move was never what made a photograph binned - the flag is; the move existed so the next scan would not re-import the file, and the bin channel (§9.1.1) arranges that from the table instead.

3. **Update DB record:**
   - Set `is_deleted = 1`.
   - Clear both pending flags.
   - Do **not** delete the record.

### 12.2 Restore

`POST /api/photos/restore` is the undo of a soft-delete. Delete records the pre-Bin path in `deleted_from_path`, and restore moves the RAW back to exactly that path, clears `is_deleted` and blanks the column. Both pending flags go back to 1, because the delete zeroed them: a photograph that comes back having never had its renditions built would otherwise sit unbuilt for ever.

**It branches on where the file is, not on the flag**, and it has three arms rather than two - the middle one is every writable library there is:

| the row's file | result |
|---|---|
| outside the bin | the flag clears, nothing moves |
| inside the bin, writable | today's move out of the bin |
| inside the bin, read-only | refused with `READ_ONLY` |

The first arm cannot merely skip the move: `moveIntoDir` would claim the name the file already holds, hit `EEXIST`, walk its suffix loop to `a_1.arw` and then unlink the source - the file is not duplicated, it is silently renamed under the photographer. It keeps the existence check, though: "no move" is not "no validation", and a row whose file has gone would otherwise go live with `is_missing` cleared and every original 404ing behind renditions that still look fine. The third arm exists because the row would otherwise go live with its RAW still in the bin, and the bin channel would re-bin it on the next sync - a restore repeatable for ever, with `deleted_from_path` replaced by a guess each time. **An undo by batch tests every row's position before restoring any of them**: a half-landed undo is worse than none.

**An undo names the bin, not its photographs.** Delete also stamps every row it takes with a `deleted_batch` the *client* generates, and the undo posts that batch back (`PhotoTargetSchema`, §14). The ids never travel: a bin of a million would be a 36MB response and a 36MB request to reverse it, and the selection those photos came from resolves to different ones the moment they leave the collection (§18.3.3). Client-generated so the undo survives an answer that never arrives - the delete may outlive the socket, and it is exactly then that being able to reverse it matters.

**Everything that is not per-file is done per batch.** Both `delete` and `restore` read their rows in one query rather than a detail payload each, resolve the library and take `libraryMutex` once, create each Bin directory once, and commit a chunk of flags at a time. Per photo - which is what these were - it was a join plus a second query for album membership neither reads, a mutex acquire, and its own transaction: **2.231ms per photo before a byte moved on disk**, or 34 minutes to bin a million. Batched, and now measured *including* the renames, it is **0.14ms per photo**.

The chunk is what bounds the exposure a per-photo commit would bound: the files move, then the flags commit, so a crash in between leaves at most one chunk of RAWs in a Bin the scanner does not look at. A DB failure rolls its chunk's moves back.

- Shoot and album membership need no restoring: soft-delete never touches `shoot_id` or `album_photos`, so both survive the round trip.
- If something else occupies the original path by then, the move takes a numeric suffix rather than overwriting a live photo.
- A row predating the column restores to the library root; the next sync reconciles its shoot from the path.
- Restore is what the client's undo toast calls, so binning is always reversible from the UI.

### 12.3 Bin Folder

**One bin per library, at `<library_root>/<bin_name>/`, laid out inside itself like the library around it.** A photo binned from `A/B/c.arw` goes to `<bin_name>/A/B/c.arw`; one binned from the root goes to `<bin_name>/c.arw`. `bin_name` is `Bin` unless the library was created with another (§4.1), and every bin path comes from `getBinPath` (§6) rather than being spelled anywhere else.

The mirror is what makes one bin possible. Flat, a bin is a heap in which `IMG_0001.ARW` from three shoots are three files distinguished only by the numeric suffix the collision handling adds - fine for the catalogue, which knows, and useless to anyone reading the folder. Mirrored, the bin is browsable on its own terms: where a file came from is written in the path, so it can be recovered by hand if the catalogue is ever lost. Bins inside each shoot folder bought the same legibility, but scattered: one library's deleted photographs in as many places as it has folders, each needing its own skip rule, and none of it visible in one place.

**Never under the data directory.** A Bin holds originals, and the data directory is the one tree the system deletes wholesale (§6, §10.6); a bin inside it would mean removing a library, or clearing `DATA_DIR` by hand, silently destroying every photograph the user had binned. The bin therefore sits beside the photographs it came from, where the only thing that can remove it is the user.

The scanner skips `<root>/<bin_name>` and everything under it, so soft-deleted files are never re-imported. That is a rule about the root, not about the name: see §9.1.

**A binned photo's folder is `deleted_from_path`, not where its file now is.** A bin-resident file is in the bin, so the recipe's path points there and no longer shares a prefix with the folder it was taken from - which every folder-scoped operation is keyed on. `listUnderFolder` therefore matches live rows on their input paths and binned ones on `deleted_from_path`, which is the origin it actually wants - not because the two agree for a row binned in place. They are written together and only the recipe replicates, so on any other peer they routinely disagree.

A folder rename (§9.4.1) rewrites the recipe's path for the live rows and `deleted_from_path` for every binned one. **It rewrites a binned row's recipe path too, exactly when that row was binned in place** - which is when the file was under the renamed folder and moved with it. A bin-resident one did not move: it is in the bin, not in the folder, and only where it restores *to* has changed. Being under the renamed folder is what says which is which - the bin is a single folder at the library root and can never sit inside a shoot folder - and deliberately not "`deleted_from_path` equals where the file is", which is the same test only on the peer that did the binning. Without that arm, an in-place binned row under a hand-renamed folder is left pointing at nothing while the file at the new path imports as a second, live photograph: one duplicate per in-place binned photo under any renamed folder. `is_missing` is still only cleared for rows proven present, which a binned row is not.

Removing a folder from the library (§4.7) takes the deleted rows with the live ones, since what leaves is the catalogue's record of that folder. No file is touched either way - the live ones stay in the folder and the binned ones stay in the bin, both now out of scope, so the next sync re-imports neither.

**A folder already sitting at that name is adopted, and the name is asked for at creation so the photographer knows it.** The live scan skips `<root>/<bin_name>` sight unseen, but the bin channel walks it (§9.1.1): an unclaimed file under the bin is imported as already-binned, with `deleted_from_path` read off the mirrored layout. So a root that already keeps its own `Bin` loses nothing by adopting it - every photograph inside arrives in the catalogue, in the Bin rather than in the collection, one restore away from the grid. That is still a different library from the one someone may have meant, which is what the Add-library dialog warns about against the folder listing it already has: a choice made before the library exists, rather than a refusal that leaves the photographer to guess what the app wants.

**The folder exists from the moment the library does**, made and `stat`ed into the identity columns before the row is inserted, in the order `ShootsService.create` uses. One helper owns creating it, and records the identity whenever it creates: without a single owner, an `ensureDir` on the delete path silently recreates a hand-deleted bin with a **new inode** while the columns still name the dead one, after which no rename of it can ever be followed - and that freed inode number is the likeliest to be recycled into the false-positive case the follow has to refuse. A bin this create *made* and a *failed* insert left behind is removed, through `utils/deletions.ts` like every other deletion and guarded twice: it must be exactly this library's bin, and `rmdir` fails while anything at all is inside it. An adopted folder is not removed: it was the photographer's before the create, and a create that failed for something else is no reason to take it away.

`PATCH` with a `bin_name` is a **rename**, which moves the folder (§4.1). Nothing in the app removes the folder, but the photographer can, so every consumer handles its absence: the bin channel skips the run and remakes it (§9.1.1), and a rename refuses with an `IO_ERROR` naming the remedy - recreating would be right for a deleted folder and wrong for a moved one, where it would orphan the real bin.

### 12.4 Hiding

**Hiding is not a soft delete.** Binning says a photograph is on its way out: the file moves into the bin, the row is `is_deleted`, and the Bin is a place you go to look at it. Hiding says the opposite - keep everything, stop showing it to me. Nothing on disk moves, no rendition is dropped, no edit is touched, and the row is otherwise an ordinary live photograph; all that changes is what a listing answers with. The case is the corner of a library that is real and finished with: the scans, the test frames, the client job that shipped two years ago.

**It is a default, not a scope.** `is_hidden` is stated in the two halves of `conditions` separately (§8.2): unasked, the exclusion sits with the scope clauses and intersects, because it is where every listing starts; asked for, it is an ordinary chip and honours `match`. So Hidden is one more tick in the filter panel's triage set (§18.3.1) and behaves like the ones beside it - ticked with Picks under `match=any` it is a grid holding the put-away *and* the picks, not the hidden picks. The chip has only the one form: hiding is the default the other ticks are read against, so there is nothing to ask for by unticking it.

**Which is why a tile says so.** One grid can hold both, so `PhotoSummary.is_hidden` rides every row and the tile wears the struck-through eye when it is set - ungated, unlike the cull's two marks (§18.3.1), a reader having no other way to tell which half of a mixed grid they are looking at. The flag is the absolute answer, own-flag-or-shoot and no exemption, so on a hidden shoot's own page every tile wears it, which is the shoot saying what it is.

**Hiding a shoot hides the body of work under it, without writing the flag onto a single photograph.** A shoot carries `is_hidden` too, and a photograph counts as hidden when its own flag is set *or* the shoot it sits in has one (`hiddenIs`). Derived rather than cascaded onto the members for the reason a stack's membership is not copied onto its frames: unhiding the shoot then gives back exactly what hiding it took, and a photograph somebody hid by hand inside it stays hidden. The clause is a non-correlated `NOT IN (SELECT id FROM shoots WHERE is_hidden = 1)`, so SQLite evaluates it once per statement against a partial index that is empty on a library which hides nothing - and it needs its own `shoot_id IS NULL` arm, since `NULL NOT IN (a non-empty set)` is NULL and without it every photograph in no shoot would vanish the moment any shoot was hidden.

**The subtree goes with it, and by derivation rather than by a flag written down it.** `shoots.is_hidden` says only that *this* shoot was put away; being inside a hidden one is read off the paths, over the same prefix range a relocation walks (§9.4.1). The cascading write is the obvious alternative and it loses information the moment there is any: the bit cannot tell a shoot hidden by its parent from one hidden on its own, so unhiding the parent silently discards the child's own hiding with nothing left to restore it from. Nothing keeps a cascade true afterwards either - a followed folder rename and a shoot created under a hidden parent would each have to remember to re-cascade, and neither would - where derivation gets all three for free, and two peers renaming and hiding at the same time cannot disagree about a flag neither of them writes.

So a shoot answers two questions. `is_hidden` is whether it is out of sight, which is what a client greys and what a listing filters on; `hidden_directly` is whether it is the one that was put away. Only the second can be undone, so it is what decides whether a row may offer to bring a shoot back: unhiding a descendant would clear a flag that is already clear and change nothing on screen. A descendant is offered Hide instead, which is a real write and what makes it stay hidden if its ancestor is ever brought back.

**A hidden shoot is not served unless it is asked for**, and that is where the filtering belongs: `ShootsService.list` excludes by default, so no consumer has to remember a filter that nothing would fail without - a sidebar, a "move to shoot" menu and a tree all get the shoots a reader is working with. `ShootsRepository.listByLibrary` still answers with everything, because the catalogue's own questions need it: which shoot encloses a folder, and which shoots an adopted folder's photographs fall under, are facts about the tree rather than about what somebody is looking at. The folder listing takes the same flag and drops a hidden shoot's folders with it (`foldersOutside`), the tree being read off the disk where nothing records that a folder has been put away.

**Resolving one by id is a different question and never hides.** `GET /api/shoots/:id` answers for any shoot, because a reader can be standing on a hidden one - its own page names it, and so does a photograph reached through the Hidden chip - and a request that already names the shoot is not a request that could be surprised by it.

**The one listing a hidden shoot does not empty is its own.** `listByShoot` and every other shoot-scoped read exempt that shoot (`ownShoot`): the reader asked this shoot what it holds, and a folder full of pictures reporting itself empty is a dead end rather than a hiding. A photograph's own flag still applies there, as it does everywhere.

**The exemption names one shoot; it is not a switch.** `hiddenIs` takes the exempt shoot as SQL - a bound `?`, or an outer column where the query has one - rather than a boolean that drops the shoot arm. A boolean exempts every *other* hidden shoot at the same time, and a stack straddling a hidden shoot and a visible one then counts and shows the hidden half on the visible shoot's page. Same reason the band has to be told which shoot it was opened in: `StacksRepository.memberIds` takes a `shoot_id`, threaded from the client the way `album_id` already is (§19.5.3), because the band and the tile's `stack_size` are two queries over one question and hiding is a third way for them to disagree. Stack triage seeds its pool from that same read, so it carries the shoot too.

**The Bin ignores hiding entirely**, for the same reason and a sharper one: a photograph binned while hidden would otherwise be in no listing at all - out of the live ones by its flag, and out of the Bin by the same clause. A photograph with no listing that holds it is the one outcome §12 exists to prevent, so `is_deleted = 1` says nothing either way rather than intersecting with it.

**Hidden photographs are skipped by work, and passed over rather than un-queued.** `PENDING_PROCESSING` (§10.2) and the stacking candidate set (§19.4.2) both exclude them, so nothing renders or measures a frame nobody is looking at. Their `renditions` rows keep `needs_build = 1`, so unhiding brings the work back with no second pass to find what was skipped. **The scan is the exception, and on purpose:** a hidden photograph is a live row whose file is still on disk, so file moves, renames, deletions and the bin channel all reach it exactly as they reach anything else. A hidden row that stopped tracking its own file would be a row pointing at nothing the moment the photographer tidied a folder.

**A stack's flagged member is re-ranked when hiding takes it out of a listing**, as a binning and a verdict both do (§19.5.2). `is_representative` is a hint that keeps the common case an equality test, and a flag left on a row no listing will show sends every later query for that stack through the promotion subquery it exists to avoid - so `PhotoStateRepository.setHidden` collects the stacks and refreshes each once, and hiding a *shoot* refreshes every stack holding a photograph beneath it (`refreshStacksUnderShoot`), the photographs themselves not having been written to. `refreshRepresentative` deprioritises a hidden member too, so one is never chosen in the first place.

**Every number and every thumbnail on screen counts what its listing shows.** A shoot's and an album's `photo_count` and banner (§4.6) exclude the hidden, and a stack's band does too (`memberIds`), so the reader is never offered a count or a tile that opens onto fewer photographs than it promised - which is the same dead end the two exemptions above exist to avoid. Each reads hiding the way its own listing does: a shoot's pair exempts that shoot, so a hidden shoot still reports what it holds rather than zero, and it says so by naming `s.id` rather than binding a parameter, the outer query being the shoot itself. The shoots page's "not in any shoot" row asks the listing it opens onto for its count rather than deriving one from the library's, which is both shorter and exact. `libraries.photo_count` is the one that does not move: it is what the sidebar shows and what the remove-library warning names, and a warning about photographs that leaves some out is the wrong one to shorten.

Both flags replicate, each on a stamp of its own (docs/replication.md §3.1, §3.2): hiding is a decision, like a verdict, and a rating or a folder rename arriving from another peer must not undo it.
