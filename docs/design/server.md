# Bowerbird design: The server

A chapter of [`DESIGN.md`](../../DESIGN.md). The chapters are numbered as one document, so
`DESIGN §N` anywhere in the repo, and a `§N` cited here that is not below, both mean the
section the index in `DESIGN.md` maps §N to.

---

## 8. Services

**Deletion never touches folders on disk.** Deleting any entity (library, shoot, album) removes only DB records; it never deletes or moves files or directories. Photo files stay exactly where they are on disk. (The one *deletion* operation that *does* move a file is soft-deleting a *photo*, §12, which relocates the RAW into a Bin; shoot photo add/remove/rename also move files, §8.5, but those are not deletions.) This keeps deletes cheap and non-destructive, and means a re-sync after a mistaken delete re-imports the photos rather than losing them.

### 8.1 Libraries Service (`libraries_service.ts`)

**Constructor dependencies:** `LibrariesRepository`

**Methods:**

| Method | Description |
|---|---|
| `create(request)` | Validates the root path exists on disk and overlaps no existing library's data directory in either direction (§6), creates the data directory, inserts a library record, returns the library. |
| `get(libraryId)` | Returns a single library by ID. |
| `list()` | Returns all libraries. |
| `delete(libraryId)` | Deletes a library record. Does not delete files on disk. |

### 8.2 Photo services

`PhotoReadService` reads through the listing, navigation, path and composite repositories. `PhotoMutationService` writes through the state and path repositories. `PhotoRenditionService` reads paths and listing rows, writes metadata and rendition state, and invokes the processing service. `delete()` needs the library for its root and for whether it has a bin at all - `bin_name` no longer decides *where* the file goes so much as *whether* it moves (§12.1); the bin path then follows from the photo's own input path and asks no shoot anything (§12.3). A row with no file of its own bins as the flag alone: nothing moves, there being nothing to move.

**Methods:**

| Method | Description |
|---|---|
| `PhotoReadService.get(photoId)` | Returns full photo detail by ID. |
| `PhotoReadService.listByLibrary(libraryId, pagination, filters?)` | Returns paginated `PhotoSummary` list for a library. Excludes soft-deleted photos unless `include_deleted` is set (§13.2). Supports optional `is_missing` and `no_shoot` filters, the latter being the photographs no shoot has claimed (§18.3.4). Ordering is determined by the library's `ordering` setting, with NULL ordering dates sorted last. |
| `PhotoReadService.listByShoot(shootId, pagination, filters?)` | Returns paginated `PhotoSummary` list for a shoot. Accepts the same `include_deleted` filter (§13.2), excluding soft-deleted by default. |
| `PhotoReadService.listByAlbum(albumId, pagination, filters?)` | Returns paginated `PhotoSummary` list for an album. Accepts the same `include_deleted` filter, excluding soft-deleted by default. |
| `PhotoReadService.listMissing(libraryId, pagination)` | Calls `listByLibrary` with `is_missing: true`. |
| `PhotoMutationService.update(photoId, updates)` | Updates mutable fields: `rating`, `triage`, `notes`. |
| `PhotoMutationService.delete(photoIds)` | Soft-deletes photos: moves RAW files to Bin, sets `is_deleted = 1`. Renditions are kept so the Bin stays browsable. See §12. |
| `PhotoMutationService.restore(photoIds)` | Restores soft-deleted photos to their recorded source paths. |
| `PhotoRenditionService.buildRendition(photoId, rendition, force?)` | Builds one requested rendition or fetches its source through the processing service. |

### 8.3 Scan Service (`scan_service.ts`)

**Constructor dependencies:** `PhotoScanRepository`, `PhotoPathsRepository`, `PhotoMetadataRepository`, `PhotoProcessingRepository`, `LibrariesRepository`, `AlbumsRepository`, `ShootsRepository`, `ProcessingService` (`ShootsRepository` is needed to reconcile `shoot_id` from a file's path against known shoot `folder_path`s, §9.4).

This service handles the full scan algorithm. See §9 for the detailed algorithm.

**Methods:**

| Method | Description |
|---|---|
| `scanAll()` | Scans all libraries, computes each library's diff, runs move detection **per library** (a file that moved between libraries is a delete in one plus an add in the other, so per-library delete/add hooks fire correctly), applies changes, then triggers processing. |
| `scanLibrary(libraryId)` | Scans a single library. Move detection is per-library, identical to one library's pass in `scanAll`. |
| `getScanStatus(libraryId)` | Returns the current scan/processing status for a library. |

### 8.4 Processing Service (`processing_service.ts`)

**Constructor dependencies:** `PhotoProcessingRepository`, `PhotoPathsRepository`, `PhotoListingRepository`, `SettingsRepository`

**Methods:**

| Method | Description |
|---|---|
| `processUnprocessed(libraryId?)` | Queries for photos owing either stage (`needs_tile` or `needs_renditions`) with `is_missing = 0`, spawns Bun worker threads (up to configured concurrency) to generate them. Each stage clears its own flag and stamps its own `*_built_at` as it lands. |
| `processPhoto(photoId)` | Processes a single photo on the main thread: resolves the raw file and rendition output paths from the repositories, dispatches the job to a worker (§10.2, §10.3), and persists the result. |
| `getProcessingStatus(libraryId)` | Returns count of photos pending/completed processing. |

### 8.5 Shoots Service (`shoots_service.ts`)

**Constructor dependencies:** `ShootsRepository`, `PhotoPathsRepository`, `PhotoStateRepository`, `LibrariesRepository`

**Methods:**

| Method | Description |
|---|---|
| `create(request)` | Creates a shoot record. The folder is named after the shoot `name`, created inside `parent_path` (the library root when it is empty); `folder_path` is stored as the full root-relative path (§4.3). A `parent_path` that resolves outside the library root is refused: a shoot's photographs must be inside the library. In a **read-only** library a folder that does not exist yet is refused too (`READ_ONLY`, §4.1) - a shoot *is* a folder, so making one is a write; mirroring already makes a shoot per folder holding photographs, so most exist before anyone asks. `parent_id` is **derived**, not requested: it is the most-specific shoot whose folder contains the new one, which is the same rule that decides which shoot a photo belongs to (§9.4), so the tree can never disagree with the folders on disk. That also means a shoot can sit under a plain folder that is not a shoot itself. If the folder does not exist, it is created. If it **already exists**, it is kept as-is and its photos are **adopted**: every existing non-deleted photo record whose files all fall under this folder (§4.2.1) and for which this shoot is the most-specific matching shoot (i.e. not already claimed by a more-specific descendant shoot) has its `shoot_id` set to the new shoot. No files move on disk and no reprocessing occurs (renditions are keyed by photo id, unaffected by shoot membership). This mirrors the sync reconciliation rule (§9.4) and makes an orphaned folder from a prior shoot delete re-adoptable. RAW files physically present but not yet in the DB are picked up by the next sync, which will assign them to this shoot via the same reconciliation. The folder is `stat`ed either way and its identity recorded (§4.3), so a shoot can be followed through a rename from the moment it exists rather than from its first scan. Creating a shoot for a folder that carries a `plain` or `excluded` rule (§4.7) clears that rule: the user is answering the same question again, the other way. |
| `get(shootId)` | Returns a shoot by ID. |
| `list(libraryId)` | Returns all shoots in a library. |
| `addPhotos(shootId, photoIds)` | Moves photo files on disk into the shoot's folder. Updates each photo's recipe path and `shoot_id` in the DB; a row with no file of its own joins by membership alone, a shoot being a folder and such a row being in none. A photo can only belong to one shoot; if it already belongs to another, it is moved out of the old shoot folder. If a file with the same name already exists in the destination folder, append a numeric suffix (e.g. `IMG_0001_1.ARW`, `IMG_0001_2.ARW`) so no existing file is overwritten and no two records name the same path (§12.1). Refused with `READ_ONLY` in a read-only library: membership is decided by the folder a file sits in, so this *is* a file move, and a database-only override would be reverted by the next mirroring sync. Albums are the grouping that needs no write. |
| `removePhotos(shootId, photoIds)` | Moves photo files back to the library root. Updates each photo's recipe path and clears its `shoot_id`. If a file with the same name already exists in the library root, append a numeric suffix (e.g. `IMG_0001_1.ARW`, `IMG_0001_2.ARW`) so no existing file is overwritten and no two records name the same path (§12.1). Refused with `READ_ONLY` in a read-only library, for the same reason as `addPhotos`. |
| `delete(shootId, photos)` | Deletes the shoot record. **No files or folders on disk are touched** (see principle above), whichever disposition is chosen. Shoots *beneath* it survive: they are re-parented onto its own parent first, because `parent_id` cascades and mirroring would otherwise rebuild those folders as fresh shoots with default names, losing every label, description, banner and ordering they had. `photos: 'keep'` leaves every photo in the library and clears its `shoot_id` via `ON DELETE SET NULL`, writing a `plain` rule (§4.7) so mirroring does not recreate the shoot on the next sync. `photos: 'remove'` writes an `excluded` rule instead and **hard-deletes** the photo rows under the folder, along with their renditions (via `deletions.ts`, §10.6.1, rather than waiting for the sweep). The originals stay exactly where they are on disk; what goes is the catalogue's record of them, and with it their ratings, verdicts and notes. Clearing the rule later re-imports them as new photos, with new ids and rebuilt renditions. |
| `update(shootId, updates)` | Updates mutable fields: `name`, `description`, `ordering`. A **name change is metadata only**: the name is a label, so nothing moves on disk and no `folder_path` or recipe path is rewritten, and it cannot conflict, since a shoot is identified by its folder rather than its name (§4.3). Setting `banner_photo_id` upserts the `shoot_banners` row; clearing it (null) deletes that row; it is not a column on `shoots` (§4.6). |

### 8.6 Albums Service (`albums_service.ts`)

**Constructor dependencies:** `AlbumsRepository`

**Methods:**

| Method | Description |
|---|---|
| `create(request)` | Creates an album record. |
| `get(albumId)` | Returns an album by ID. |
| `list()` | Returns all albums. |
| `addPhotos(albumId, photoIds)` | Adds photo-album associations. No file moves. |
| `removePhotos(albumId, photoIds)` | Removes photo-album associations. |
| `delete(albumId)` | Deletes the album and all its photo associations. |
| `update(albumId, updates)` | Updates mutable fields: `name`, `ordering`. Setting `banner_photo_id` upserts the `album_banners` row; clearing it (null) deletes that row; it is not a column on `albums` (§4.6). |

---

## 13. API Endpoints

All endpoints return JSON. Error responses use a standard envelope:

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Photo not found"
  }
}
```

### 13.1 Libraries

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/libraries` | Create a library. A folder the root already holds at `bin_name` is adopted as the bin, and what it holds imports as already-binned (§12.3); 403 `READ_ONLY` for `read_only: false` over a root that is not writable. `read_only` forces `bin_name` to null |
| `GET` | `/api/libraries` | List all libraries |
| `GET` | `/api/libraries/:id` | Get a library |
| `PATCH` | `/api/libraries/:id` | Update a library (name, default ordering, rendition settings, `include_subfolders`, `read_only`, `bin_name`). A `bin_name` **renames the folder** (§4.1): 409 if that name is taken, 403 for a read-only library - that check first, so a read-only library never sees the 409. Clearing `read_only` on a library with no bin needs a `bin_name` in the same request |
| `DELETE` | `/api/libraries/:id` | Delete a library |
| `POST` | `/api/libraries/:id/sync` | Trigger sync for a library |
| `DELETE` | `/api/libraries/:id/sync` | Stop the library's current sync (§9.10) |
| `GET` | `/api/libraries/:id/sync/status` | Get scan/processing status |
| `GET` | `/api/libraries/:id/folders` | Every folder inside this library, root-relative, for the Shoots page's tree (§18.3.4). Only what the scan looks at: no Bin, no dotfolder, nothing excluded. A hidden shoot's folders go with the shoot unless `?include_hidden=true` (§12.4). |
| `GET` | `/api/libraries/:id/folder-rules` | The library's `excluded` / `plain` folders (§4.7) |
| `PUT` | `/api/libraries/:id/folder-rules` | Set one folder's rule (body: `{ folder_path, rule }`) |
| `DELETE` | `/api/libraries/:id/folder-rules` | Clear one folder's rule (`?folder_path=`), returning it to what the library's settings say |

### 13.2 Photos

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/libraries/:libraryId/photos` | List photos in a library (paginated, filterable) |
| `GET` | `/api/libraries/:libraryId/photos/missing` | List missing photos in a library |
| `GET` | `/api/photos/:id` | Get full photo detail |
| `PATCH` | `/api/photos/:id` | Update photo metadata (rating, triage, notes) |
| `POST` | `/api/photos/ids` | What a selection stands for, spelled out; only the export asks, having work to do per photograph on the client (§10.5.1) |
| `POST` | `/api/photos/delete` | Soft-delete photos; answers `{ deleted }`, the undo naming the batch the client stamped rather than every id |
| `POST` | `/api/photos/restore` | Restore soft-deleted photos to where they were deleted from (§12.2) |
| `POST` | `/api/photos/hide` | Put a selection away, or bring it back (body: `{ target, hidden }`); answers `{ updated }` (§12.4). The open photograph's detail is re-read alongside the collection, the viewer offering the same action as one row that points whichever way the photograph is not |
| `POST` | `/api/photos/rebuild-tiles` | Rebuild the grid tiles of a selection, and nothing else (§10.3) |
| `POST` | `/api/photos/:id/renditions/:rendition` | Build one rendition on demand: `full` or `max`; `?force=true` drops the cached copy first (§10.1) |
| `POST` | `/api/photos/refresh-metadata` | Re-read the RAW headers for a selection |
| `POST` | `/api/photos/models` | Every body/lens pairing a collection holds, for the filter panel's two lists (§18.3.1) |
| `POST` | `/api/photos/days` | Every day a collection holds photographs on, and how many, for the calendar's density dots (§18.3.1) |

**Every bulk route takes the same two body shapes** (`PhotoTargetSchema`): `{ photo_ids: string[] }`, capped at a thousand, or `{ selection }`; a collection, the filters it was viewed under, and runs of positions in it (§18.3.3). The second exists because a client holds only a window of a large collection and can never have the ids for the rest: the server reads them off the same filtered, collection-ordered listing the grid was built from, so acting on a hundred thousand photos is one small request. A selection states no ordering; the collection owns that (§18.3.1), and a client naming one could describe an order the selection was never made in.

**The whole selection resolves in one pass**, numbering the rows once (`ROW_NUMBER() OVER (ORDER BY …)`, bounded by the last run's end) and reading every run out of that numbering. The obvious shape - one `LIMIT/OFFSET` query per run - is quadratic in disguise: a run costs the same whatever its length, but each query re-sorts the collection, so five hundred scattered picks meant five hundred sorts. Measured at a million photos: **433 seconds for five hundred single-photo runs, against 0.28 seconds** for the same request resolved in one pass. `ranges` is capped at ten thousand entries, which bounds the body; it is this that bounds the work.

Query parameters for listing (`PhotoListQuerySchema`, §5.3):
- `offset` (int, default 0)
- `limit` (int, default 100, max 500)
- `is_missing` (boolean, optional filter)
- `is_hidden` (boolean, optional: includes the photographs put away, which are otherwise left out; honours `match`, §12.4)
- `no_shoot` (boolean, optional filter: only the photographs no shoot has claimed, §18.3.4)
- `include_deleted` (boolean, default false)
- `is_deleted` (boolean, optional filter)
- `rated` (boolean, optional: `true` = at least one star, `false` = unrated)
- `triage` (optional, comma-separated verdicts to include, e.g. `triage=untriaged,picked` for the default gallery view that hides rejects)
- `ordering` (optional, overrides the collection's stored ordering for this request only, so a client sort control does not edit the library)
- `q` (optional, case-insensitive substring of any input path a photograph names)
- `taken_from` / `taken_to` (optional `YYYY-MM-DD`, inclusive bounds)
- `camera_models` / `lens_models` (optional, comma-separated, spelled as the RAW header spelled them)
- `match` (optional, `all` (default) or `any`)
- `expand_stacks` (boolean, default false: list every photograph of a stack as a row of its own rather than the stack as one, §19.5.4)

The same schema serves the library, shoot and album listings, so a filter behaves identically wherever the user is.

`rated` is a "has any rating" test rather than an equality one, because the question during a cull is "what have I not judged yet".

`match` selects how `rated`, `triage`, `is_missing` and `is_hidden` combine. `all` intersects them; `any` unions them, which is what a "show me anything still needing attention" filter means; as an intersection, "picks and unrated and missing" is almost always empty. It applies only to those four: scope (soft-delete, `no_shoot`, `q`, the date range, the two model lists) always intersects, so narrowing by filename, date or body still narrows a union.

The model lists union within themselves and intersect across: two bodies is either of them, a body and a lens is that lens on that body. They filter on the `camera_model` / `lens_model` columns the import read off the RAW header (§11.1), so a photograph the camera told nothing about is in neither list and matches neither filter.

The date range filters on `COALESCE(date_taken, date_added)`; the same date the listing sorts and labels by; so a file the camera never dated stays reachable. `taken_to` is inclusive of the whole closing day (the column is a timestamp, the bound is a date).

Library, shoot and album responses each carry a `photo_count` (excluding binned photos), and libraries carry `last_synced_at`, so a client can show how large and how stale a collection is without a second request per row.

`include_deleted` and `is_deleted` do different jobs: the former lifts the default "hide soft-deleted rows" clause, the latter selects on the flag. The Bin view is `include_deleted=true&is_deleted=true`; without the pair a client could ask for "live and deleted together" but never for "deleted alone".

`is_hidden` needs no such pair: it is the widening half on its own. Omitted, the exclusion is where every listing starts and intersects like the scope filters above; sent, it is an ordinary chip, so `is_hidden=true&triage=picked&match=any` is one listing holding the put-away and the picks (§12.4). There is no "only the hidden ones" spelling beyond sending it alone, and no "not hidden" one at all.

All boolean query params are parsed with `z.stringbool()`, so `?is_missing=false` correctly parses as `false` (a `z.coerce.boolean()` would turn the string `"false"` into `true`).

**Soft-delete visibility:** every list endpoint in this API (photos, shoots' photos, album photos, and any other collection) excludes soft-deleted rows by default and accepts `include_deleted=true` (the shared `SoftDeleteFilterSchema`, §5.1) to include them. This is uniform, not photos-specific.

### 13.3 Shoots

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/shoots` | Create a shoot |
| `GET` | `/api/libraries/:libraryId/shoots` | List shoots in a library. The hidden are left out unless `?include_hidden=true` (§12.4), so a consumer that has not thought about hiding cannot be handed one; `GET /api/shoots/:id` answers for any shoot either way. |
| `GET` | `/api/shoots/:id` | Get a shoot |
| `PATCH` | `/api/shoots/:id` | Update a shoot |
| `GET` | `/api/shoots/:id/removal` | How many photo records `?photos=remove` would take, counted with the query the delete runs (§18.3.4) |
| `DELETE` | `/api/shoots/:id` | Delete a shoot; `?photos=keep` (default) or `?photos=remove` decides whether its photographs stay in the library (§8.5) |
| `POST` | `/api/shoots/:id/photos` | Add photos to a shoot (`PhotoTargetSchema`, §5.3) |
| `DELETE` | `/api/shoots/:id/photos` | Remove photos from a shoot (`PhotoTargetSchema`) |
| `GET` | `/api/shoots/:id/photos` | List photos in a shoot (paginated) |

### 13.4 Albums

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/albums` | Create an album |
| `GET` | `/api/albums` | List all albums |
| `GET` | `/api/albums/:id` | Get an album |
| `PATCH` | `/api/albums/:id` | Update an album |
| `DELETE` | `/api/albums/:id` | Delete an album |
| `POST` | `/api/albums/:id/photos` | Add photos to an album (`PhotoTargetSchema`, §5.3) |
| `DELETE` | `/api/albums/:id/photos` | Remove photos from an album (`PhotoTargetSchema`) |
| `GET` | `/api/albums/:id/photos` | List photos in an album (paginated) |

### 13.5 Image Streaming

| Method | Path | Description |
|---|---|---|
| `GET` | `/image/:photoId/renditions/:rendition` | Stream one rendition: `grid`, `full`, `max` or `embedded` (§10.1). The recipe decides how the row answers - bytes lifted out of its own file, or a copy it built |
| `GET` | `/image/:photoId/download/:form` | As an attachment: `original` (the RAW), `embedded`, `full` or `max` |
| `GET` | `/image/:photoId/share/:rendition` | One rendition as a JPEG for the platform's share sheet: `embedded`, `full` or `max` (§10.5) |

**Dynamic range is not in the URL.** The library decides it, so a client naming `full-hdr` would be guessing at a file that may never have been built; the route resolves it from `rendition_hdr` instead, and `PhotoDetail.renditions` tells the client what it is looking at.

**One download route rather than four**, because the menu offering them is one list and only the bytes differ: the RAW streams from disk, the camera's JPEG is lifted out of it, and `full` / `max` come from the stored AVIF. Nothing here is stored - extraction is a header read plus a copy, a download is occasional, and a JPEG per rendition on disk would cost more than either does.

**The rendered forms are transcoded to JPEG only where the library is SDR.** JPEG cannot carry PQ, so transcoding an HDR rendition would hand back an SDR tone-map of the picture that was on screen and name it the same render - the one thing a download of what you are looking at must not do. An HDR library's `full` / `max` therefore stream the AVIF itself, which is the format the viewer displayed and the only one here that carries HDR (§10.1). `full` and `max` must already be built: building one is the viewer's own request (`POST /api/photos/:id/renditions/:r`), and a download that silently took minutes would look like a hung browser, so the client builds first and then navigates.

**A share is the one place an HDR rendition is transcoded anyway, and a gain map is why it can be.** A share sheet hands the file to an application nobody here chose, so what goes over is a JPEG: eight-bit and ordinary for everything, with the range in a gain map beside it for the readers of either spelling (§10.5.1). The base is not a second render of the photograph - it is the rendition itself read back as a finished picture and rolled into diffuse white through the same BT.2390 roll-off an SDR rendition takes (`ProcessingService.renderSdrRoll`), which is a dispatch over pixels already decoded rather than the decode, the fit and the demosaic a render pays. Which rendition is in the URL because only the client knows which one is on screen, and nothing is stored: the roll goes to a scratch directory and the JPEG is made again for the next share, so the response is `Cache-Control: no-store`.

The RAW download goes through the same file path as the renditions rather than being buffered, so a client can seek inside a 25MB original (`Accept-Ranges`, 206 partial content).

**Caching.** Renditions are rebuilt in place under a stable URL, so every image response carries an `ETag` (file size + mtime) and `Cache-Control: no-cache`. Without a validator the browser caches heuristically with nothing to revalidate against, and keeps showing the pre-rebuild picture; `no-cache` still caches, it just always asks first, which is a 304 in the common case. `If-None-Match` is answered directly.

The camera's JPEG has no file of its own to stat, being lifted out of the RAW per request, so its validator comes off the RAW - the file those bytes are part of, which is stated exactly when they change. Answered ahead of the extraction, so a 304 costs neither the transfer nor the read. **This is the route where the validator does the most work**, because it is the one a reader steps back and forth across: an element that unmounts drops the decoded copy, and until this carried an ETag every remount whose copy had fallen out of the browser's in-memory cache pulled several megabytes again for bytes that had not changed.

That covers everything that *asks*, which is every fresh page load. But an `<img>` whose `src` attribute has not changed never asks at all, so a rebuild is invisible to the copy already decoded in a live page; and a fresh element with the same `src` is handed that copy without revalidating, so remounting does not ask either. Every *built* image URL therefore carries a version (§18.6): the stamp of whatever produces its bytes - `tile_built_at` for the grid, `renditions_built_at` for the viewer's two. Stamped by whatever wrote the file and delivered on the row, so it is right from the first render, identical in every client, stable across reloads, and moves only when its own file did. Two URLs, two cache entries; the ETag then keeps each of them honest.

**The camera's JPEG is not versioned**, which is what makes it the exception: nothing builds it, so nothing can rewrite it under a URL a live page is already holding, and the case a version exists for cannot arise. A RAW replaced on disk is caught by the ETag the next time something mounts the URL, rather than at once - an `<img>` already holding the old bytes goes on holding them until it is remounted or the page reloaded, which is what the RAW download route has always accepted too.

**A stamped URL stays `no-cache` rather than becoming `immutable`**, though the stamp reads like exactly the promise `immutable` describes. It is not one: the stamp moves when a rendition is *rebuilt*, and says nothing about it being *deleted*. Generated files are outside every library root and disposable by design (§3) - the pruner takes them, and so does a user clearing `data/` - and what heals that is the viewer asking for the frame, getting a 404 and building it back (§10.2). Cached for a year on the strength of a stamp, the client shows the copy it already has, never asks, and the file stays gone. A conditional request per remount is what that self-healing costs.

These endpoints:
- Resolve the file path from the photo record and library configuration.
- Stream the file directly from disk using Bun's file streaming (no buffering into memory).
- Set appropriate `Content-Type` headers (`image/avif` or `image/x-sony-arw`).
- Set `Content-Length` from file stats.
- Return 404 if the file does not exist on disk. Soft-deleted photos **are** served: the row and both files still exist, and the Bin view depends on being able to render them (§12.1).
- Support `Range` requests for partial content (HTTP 206), enabling seeking for large files. `Bun.serve` answers these against a `BunFile` body (including `Content-Range` and a 416 for an unsatisfiable range) but does not advertise the capability, so the handler sets `Accept-Ranges: bytes` itself.

RAW decoding applies the camera's EXIF orientation to rendition pixels. User quarter-turns stay in AVIF `irot` metadata; the viewer applies that transform when displaying the file. Photo response dimensions describe the displayed orientation. Clients must not apply the camera's `orientation` field a second time.

Implementation approach:
```typescript
app.get('/image/:photoId/renditions/:rendition', async (c) => {
  const photo = await photosService.get(c.req.param('photoId'));
  if (!photo) return c.notFound();
  
  const library = await librariesService.get(photo.library_id);
  const filePath = getRenditionPath(library, photo.id, rendition, library.rendition_hdr);
  
  const file = Bun.file(filePath);
  if (!await file.exists()) return c.notFound();
  
  return new Response(file);  // Bun streams this from disk
});
```

`Bun.file()` returns a lazy reference that streams from disk when consumed as a `Response` body, no full read into memory.

### 13.6 Config, settings and events

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/settings` | Everything the user can change that is not a property of one library |
| `PATCH` | `/api/settings` | Update them |
| `GET` | `/api/events` | Server-sent events; `rendition` carries the id of a photo whose renditions were just written (§18.6) |
| `GET` | `/api/updates` | What version this install is and which releases are newer, cached ten minutes (§23.5) |
| `POST` | `/api/updates/check` | The same answer, without the cache |
| `POST` | `/api/updates/apply` | Download the payload for this platform, check it, unpack it, and exit for the supervisor to restart into it (§23.3). Answers `202` first: the reply is the last thing this server does on the old version |
| `GET` | `/api/browse` | Directories inside `?path=`, or the home directory when it is omitted, for the folder picker that adds a library. Absolute paths, and unfenced: a library root can be on any mount, and `POST /api/libraries` already accepts any absolute path. The per-library form (§13.1) is fenced, because there a folder outside the root is wrong rather than merely unhelpful. Carries a `writable` boolean for the folder being listed - one per listing, not per child - so the dialog can tick and lock "don't change anything in this folder" for a root the server cannot write in (§4.1). |

Two scopes, not three: the `libraries` row holds what belongs to one catalogue (the rendition source and HDR, §10.2), and `settings` holds everything app-wide - the viewer's `viewer_rendition_mode` and the rendition `remember` remembers, alongside the server's own tuning (§15). A key/value table rather than a column per setting because they are read one at a time and never queried across, and adding one should not need a migration; values are stored as text, and the default's type says what to read one back as. A value the build no longer understands reads as its default rather than failing the request: a bad row must not stop the viewer opening or the server booting.

### 13.7 Export

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/export` | Render one photograph at the reader's settings and answer with the file; a selection is this in a loop, one run id across it (§10.5.1) |
| `POST` | `/api/exports/queued` | What a queued run is about, as the rows the history will hold: the photograph's path, library, shoot, and the edits the file will carry |
| `POST` | `/api/exports/landed` | Where a file went, which the render could not know; until it is said the row is not listed (§10.5.2) |
| `GET` | `/api/exports` | The history, newest run first |
| `DELETE` | `/api/exports/runs/:runId` | Forget a whole run, which is what a selection's export is one row of |
| `DELETE` | `/api/exports/:id` | Forget one file's row. Neither delete touches a file, the files being the reader's |
| `GET` | `/image/exports/:id` | The tile beside a history row, written with the export and served immutable (§13.5) |

---

## 14. Error Handling

### 14.1 Error Codes

| Code | HTTP Status | Description |
|---|---|---|
| `NOT_FOUND` | 404 | Entity not found |
| `VALIDATION_ERROR` | 400 | Request validation failed |
| `CONFLICT` | 409 | Conflicting operation (e.g. library root already registered) |
| `IO_ERROR` | 500 | Filesystem operation failed |
| `READ_ONLY` | 403 | The library forbids the write this needed (§4.1). Distinct from `VALIDATION_ERROR` because the request is well-formed and would have succeeded against another library |
| `SYNC_IN_PROGRESS` | 409 | A sync is already running for this library (per-library lease, §9.7) |
| `INTERNAL_ERROR` | 500 | Unexpected error |

### 14.2 API Layer Error Handling

Each API handler wraps service calls in try/catch. Zod validation errors are caught and returned as `VALIDATION_ERROR` with the Zod error details. Service-thrown errors use a custom `AppError` class with a `code` property that maps to the table above.

```typescript
class AppError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}
```

### 14.3 Logging

Every line goes through `src/logger.ts`, and oxlint's `no-console` keeps it that way (the logger itself and the tests are the exceptions). A `Logger` is constructed per module with the scope it logs under - `sync`, `processing`, `watcher`, `libraries`, `photos`, `prune`, `daily-sync`, `http`, `server` - and writes one line per event:

```
2026-07-29T04:52:43.294Z INFO  [sync] scan done library=963e5039 files=42 rows=42 opened=0 unreadable=0 ms=3
```

Structured tail rather than a sentence: the counts are what an import is judged by, and `grep library=<id>` then follows one library through a log several are writing to. An `Error` passed as a field renders as its message, plus its stack on the following line at `error` level, so a failure is still traceable to the call that raised it. `warn` and `error` go to stderr, everything else to stdout.

The `log_level` setting picks the floor, applied at startup and again on edit; `LOG_LEVEL` overrides it (§15):

| Level | What it adds |
|---|---|
| `debug` | A line per HTTP request (including the flood of rendition GETs), per finished processing stage, and per batch of filesystem events the watcher acts on |
| `info` | The default. Imports (start, scan totals, diff counts, queued work), processing batches, library lifecycle, on-demand renditions, the scheduled jobs |
| `warn` | Only what an operator should look at: an unreadable file, a photo that failed to process, a rescued original |
| `error` | Only what failed outright |

A scan reports progress every 500 files, because a 300k-frame import is hours of work and a log that says nothing until it finishes cannot be told from one that has hung.

---

## 15. Configuration

Four environment variables, and only four: what has to be known before the
catalogue can be opened.

| Variable | Default | Description |
|---|---|---|
| `HOST` | `0.0.0.0` | HTTP server bind address |
| `PORT` | random | HTTP server port, printed on startup; `-p <port>` overrides it |
| `DB_PATH` | `./bowerbird.db` | SQLite database file path |
| `DATA_DIR` | `./data` | Where every generated file lives, one subdirectory per library (§6). Resolved absolute at load, created and tested for writability at startup |

Four more are **not configuration and not for anybody to set**: they are how whatever
started this server tells it where it is (§23.3, §10.4). Every one of them is written by
the supervisor or the desktop shell, and a deployment that sets them by hand is telling
the server something untrue about itself.

| Variable | Set by | Description |
|---|---|---|
| `BOWERBIRD_SUPERVISED` | the supervisor | `1` when there is something in front of this process that can restart it, which is what decides whether an in-place update is offered at all |
| `BOWERBIRD_HOME` | the supervisor | Where the versions live, and so where an update unpacks |
| `BOWERBIRD_PLATFORM` | the Dockerfile | Which release platform this install is, where it cannot be worked out from the kernel - the image runs the same Linux a desktop build does and installs an entirely different file |
| `BOWERBIRD_NATIVE_LIB` | the shell, the container entrypoint | The pixel library to open, named rather than searched for: a packaged app has no source tree beside it, and the container's is whichever instruction-set variant won the startup probe (§10.4) |

Two more are genuinely optional, and say where update checks are made (§23.5):

| Variable | Default | Description |
|---|---|---|
| `BOWERBIRD_UPDATE_REPO` | `bitnimble/bowerbird` | The GitHub repository to check. What a fork sets |
| `BOWERBIRD_UPDATE_URL` | built from the above | The releases endpoint outright, for somewhere that is not github.com. Wins over the repository, and must report an `assets` list per release - there is no github.com URL guessed behind it (§23.5) |

Either one set empty turns checking off, for a deployment that must make no outbound
request at all - rather than leaving it to fail once an hour. "No endpoint" and "no
repository to ask" are the same statement, so neither needs a flag of its own.

Everything else is a **setting**, stored in the `settings` table (§13.6) and
edited from the app's Settings page. Deployment config that can only be changed
by editing a compose file and restarting is config the person looking at the
photos cannot change, and every one of these is a knob you turn *because of what
you just saw on screen* - a library that came out dark, an import that is too
slow, a rendition that lost its shadows.

Nothing here needs a restart. `src/schemas/settings.ts` holds the defaults and
the bounds; the reasoning behind each number lives beside it there.

| Setting | Default | Description |
|---|---|---|
| `log_level` | `info` | `debug`, `info`, `warn` or `error`; what the server logs (§14.3) |
| `cors_origins` | `""` | Comma-separated origins allowed to call the API, or `*`. Empty means "any port on whatever host the request arrived at", so the client works on loopback and over the LAN without hardcoding an address, while an unrelated site on the internet is still refused. |
| `processing_concurrency` | `4` | Number of worker threads for rendition generation |
| `match_embedded_jpeg` | `true` | Give SDR renders the camera's own colour and lens correction, fitted per photo against the embedded JPEG; ~+2.4s on a 61MP frame (§10.8) |
| `raw_defringe` | `1` | Ceiling on the measured focus difference between channels, which is what a colour fringe at a hard edge is. The amount is fitted per frame, so a frame with the channels in focus is left untouched at any setting (§10.8) |
| `grid_rendition_size` | `800` | Longest edge in pixels for the grid rendition |
| `grid_rendition_quality` | `80` | Perceived quality for the grid rendition, 0-100; higher is better (§10.1) |
| `full_rendition_size` | `3840` | Longest edge in pixels for the full rendition |
| `full_rendition_quality` | `80` | Perceived quality for the full rendition, 0-100; higher is better (§10.1) |
| `max_rendition_quality` | `88` | Perceived quality for the native-resolution rendition (§10.5) |
| `sdr_full_chroma` | `false` | 4:4:4 rather than 4:2:0 for the SDR renditions. Roughly twice the encode time and three times the size, for chroma detail on saturated edges (§10.1) |
| `hdr_peak_nits` | `1000` | Display peak the BT.2390 roll-off targets, and the declared mastering peak (§10.7.1) |
| `hdr_reference_white_nits` | `203` | ITU-R BT.2408 HDR Reference White; what diffuse white is graded to (§10.7.1) |
| `hdr_white_quantile` | `0.90` | Quantile of the frame taken as diffuse white (§10.7.1) |
| `hdr_preset` | `8` | Encoder speed, libavif's 0-10, clamped (§10.7) |
| `hdr_still_full_chroma` | `false` | 4:4:4 rather than 4:2:0 for the HDR still. Holds chroma detail, roughly double the encoder's memory (§10.7). The video has no say |
| `watch_enabled` | `true` | Auto-sync a library when its files change on disk (§9.8) |
| `watch_debounce_ms` | `15000` | Debounce window for coalescing filesystem events (§9.8) |
| `watch_poll_interval_ms` | `20000` | How often a library on a network filesystem is walked for folders whose mtime moved, since it delivers no events (§9.8) |
| `full_sync_at` | `03:00` | Local `HH:MM` for the daily full reconcile; `""` disables (§9.8) |
| `prune_every_days` | `7` | Interval for the orphaned-file sweep; `0` disables (§10.6) |
| `backup_every_days` | `1` | Interval for the rolling catalogue backup; `0` disables (§4.9) |
| `backup_keep` | `7` | How many backups to keep. A count of files rather than of days, so lengthening the interval does not silently shorten the window (§4.9) |
| `export_history_limit` | `1000` | How many exported files the history keeps. Whole runs are culled oldest-first past it, so it is a floor (§10.5.2) |

Two shapes of consumer, and they take a setting differently:

- **Read per use.** Processing asks `SettingsRepository` for the size, quality
  and grade of every job it builds, so an edit lands on the next photo without
  anything being told about it.
- **Configured, then re-configured.** The watcher, the daily reconcile, the
  orphan sweep, the catalogue backup and the log level are established once at startup and re-applied
  from `settingsRepo.onChange`. A `configure()` on each restarts only what
  actually moved, so a knob on the Settings page never means "after the next
  restart".

`LOG_LEVEL` remains as an environment override, and wins where it is set:
logging starts before the database is open, a server that will not boot cannot
be turned up from its own settings page, and the test scripts use it to stay
quiet.

---

## 16. Testing Strategy

Two tiers, both run by `bun test`, split by whether a module needs the container's native dependencies (`bun:ffi` into `librawshim.so`, an on-disk photo tree) or can run anywhere against mocks.

### 16.1 Unit Tests

Services and API handlers whose dependencies can be mocked are unit-tested with dependencies supplied via constructor injection.

**Repository mocks:** Each repository interface is mocked to return predetermined data, allowing service logic to be tested in isolation without touching SQLite.

**Service mocks:** API handler tests mock the service layer to test request validation, response formatting, and HTTP status codes.

**Exceptions covered by integration tests instead (§16.3):** `ScanService`, the image-streaming API, and repository DB behaviour are *not* unit-tested; `ScanService` and the repositories exercise real SQL (mocking a repository well enough to test the scan algorithm would test the mock, not the SQL), and image streaming depends on `Bun.file`. These run against a real in-memory catalogue and the `rawshim` FFI in the container integration suite, which is the authoritative coverage for scan/diff/apply, the move/rename/delete races, the scan generation token, inode dedup, and image responses.

### 16.2 Key Test Cases

The sync-service, photo-deletion, and image-streaming cases below run in the integration suite (§16.3); the rest are unit tests.

**Sync service:**
- Basic add/remove/modify detection
- Move detection (same hash in removed + added)
- Duplicate handling: 3 copies → 2 removed + 1 added = 1 move + 1 removal
- Album membership bias: prefer removing photos not in albums
- Modified + added with original hash (special case from §9.3)
- Files in a hidden directory are excluded, which covers a legacy `.bowerbird/` (§6)
- Files in the library's bin are excluded, and a folder of the user's own further down sharing its name is not (§12.3)
- Non-ARW files are ignored
- Reappearance: a previously-missing file back at its original path clears `is_missing` (§9.4 step 4)
- Move into a known shoot folder sets `shoot_id`; move out to root clears it (§9.4 step 1)
- mtime change (e.g. in-place edit) marks a file MODIFIED and re-processes it (§9.2)
- Sync lease: a second concurrent sync of the *same* library throws `SYNC_IN_PROGRESS`; two *different* libraries sync concurrently; a lease stale by more than 30s is reclaimed and a fresher one is not (§9.7)
- Concurrency vs. a user mutation mid-scan: an in-flight move's hardlink pair (link+unlink) is collapsed by inode so no duplicate row is inserted; a library deleted mid-scan aborts `NOT_FOUND` (no FK crash); a stale sync generation's detached processing tail doesn't stomp a newer sync's status
- Stopping (§9.10): a stopped rescan applies nothing and marks nothing missing, opens no further files and returns an idle status; a stopped *first* scan keeps the photos it reached (nothing to be absent from) and adds no missing rows; mid-processing the run ends rather than waiting itself out, leaving the unreached photos pending; a batch a later sync coalesced into is still what a stop reaches

**The bin channel (§9.1.1):**
- A photograph binned in place is not re-imported as a duplicate, however many syncs run
- A binned file deleted by hand is marked `is_missing`, and counts as modified rather than removed
- A file moved into the bin by hand becomes that row rather than a second one, even when its mtime (and so its hash) differs
- A file taken back out of the bin by hand goes live again, and owes its renditions
- A hand-renamed bin folder is followed: `bin_name` and the binned prefixes move, `deleted_from_path` does not, no binned file is opened and nothing counts as moved
- A folder carrying the bin's identity but claiming no binned file is **not** followed
- A deleted bin folder skips the channel and leaves every binned row alone
- An unclaimed file under the bin is imported already-binned, with no rendition work queued
- A hand-renamed shoot folder keeps its in-place binned rows reachable: one row afterwards, not a live duplicate plus an orphan
- A scoped sync touches no binned row
- A binned album member does not outrank a live removal for the same hash

**Photo deletion:**
- Renditions are kept, so the Bin can be browsed
- RAW file is moved into the library's one bin, under the folder it came from (`A/B/c.arw` → `<bin>/A/B/c.arw`, root → `<bin>/c.arw`)
- DB record is marked `is_deleted = 1`, not removed
- Filename collision in Bin (numeric suffix), which the mirror leaves for two files of one name in one folder rather than one name anywhere in the library
- A read-only library moves nothing, and restoring from one renames nothing - asserted by listing the directory, since the regression is a silent `a_1.arw` rename a row assertion would miss
- An undo batch holding one row inside a read-only library's bin is refused before any row is restored

**Read-only libraries**, over a fixture tree with the directory permissions actually dropped, so a stray write fails the test rather than passing unnoticed: sync, bin, restore, rate and album all work, and the tree is byte-identical afterwards. A shoot has to be a folder that already exists, and `addPhotos` is refused.

**The bin folder's lifecycle:** a create whose insert fails leaves no bin behind; a read-only create makes none whatever `bin_name` was sent; a rename moves the folder, keeps its inode, re-prefixes the binned rows and leaves `deleted_from_path`; a rename onto a taken name is a 409 and a read-only library's is a 403 first.

**Catalogue backups (§4.9), in the integration suite:**
- A snapshot holds writes still sitting in the WAL, and is one file with no sidecars beside it
- A backup that fails **rejects** rather than reporting a success, and leaves neither a promoted snapshot nor a working file. The failure path is worth stating separately because every other case here takes a backup that works, and a backup reported as taken but never written is the whole failure this feature exists to prevent
- A working file abandoned by a killed run is swept by the next one
- Rotation keeps the newest N and reports how many it dropped; a retention below 1 deletes nothing; a catalogue emptied on purpose rotates normally
- A catalogue that has gone missing with backups beside it is refused at startup, naming the command that fixes it; so is an empty database left where one was, whether zero bytes or a valid empty one; a first run with no backups still creates one
- A `-wal` that cannot belong to the catalogue beside it (rollback-mode header, non-empty WAL) is refused, naming the files to delete; a catalogue and its own WAL are left alone
- A restore takes its lock even when there is no catalogue at the path, which is the disaster-recovery case, and the empty file it locks is never reported as the catalogue that was displaced
- A catalogue whose own filename carries a date does not date every snapshot to it
- A working file from a run that is still going is left alone; one old enough to be abandoned is swept
- Two catalogues in one backup directory leave each other alone, both when one filename is a prefix of the other (`photos.db` / `photos-archive.db`) and when they differ only by extension (`photos.db` / `photos.sqlite`)
- Starting with nothing backed up takes one immediately; starting again within the interval does not; a disabled schedule takes none; `configure` starts a scheduler that was constructed with the settings it is then given, and stops one that is turned off
- A snapshot dated in the future neither halts the schedule nor makes it spin, and is not what `latest` resolves to
- A backup is found by the name the listing prints, and a bare name is *never* resolved against the shell's working directory even when standing in the backup directory; another catalogue's snapshot is neither listed nor reachable by name, including as `latest`
- An unreadable backup directory is raised rather than reported as having no backups
- A WAL inflated past `journal_size_limit` by a pinned reader is handed back once writing resumes (`wal_size.integration.test.ts`, which fails at 24MB without the pragma)
- Restoring puts the catalogue back and the result is what a restart would find, with the displaced one complete and openable **and its `-wal` beside it** - reading the parked copy back is what proves the sidecar travelled, since the row in question lives in that `-wal` and not in the parked main file. No `-wal`, `-shm` or `-journal` is left at the restored path for the next start to replay
- The same **when the catalogue itself was deleted first**, which is the likeliest way anyone reaches a restore: the orphaned `-wal` is taken out of the way rather than left to be replayed over the restore. The WAL in both is left by a *killed process*, since closing a connection checkpoints it away and holding one open is now refused outright
- Restoring a source whose work is all in its own `-wal` keeps that work, which a file copy silently discards
- A restore is refused while anything still holds the catalogue open, **and the lock that establishes it is still held when the check returns**, rather than sampled and dropped before the swap it protects; a catalogue too corrupt for SQLite to open is still restorable over; a symlinked `DB_PATH` keeps the catalogue on the volume it was placed on, including when the link is dangling and across a chain of links
- A staging file left by a killed restore is swept by the next one, while one a running restore is still writing is left alone; rotation does not delete the snapshot it just took even when the clock steps backwards mid-run
- An unreadable backup directory does not stop an explicit path from *resolving* (the restore itself is not exercised through one)
- A worker that exits without reporting, and one that wedges, both fail the backup rather than latching the schedule; the space a snapshot needs is the larger of the catalogue and its WAL, not either alone
- A bogus date is rotated out rather than made immortal; `latest` survives a backup directory copied without its timestamps; a chain of symlinks resolves to the catalogue at its end
- Restoring an *older* backup is allowed; one whose newest applied migration is ahead of this build is refused, as is one that is not a readable database and one whose path is the catalogue itself; all before anything on disk moves
- `deleteBackupFile` refuses a path outside the backup directory, one in a subdirectory of it, and an original

**Shoot operations:**
- Creating a shoot whose folder already exists adopts the photos already in it (sets `shoot_id`, no file moves)
- Adding photo to shoot moves file on disk
- Adding photo already in another shoot moves it out of old shoot
- Removing photo from shoot moves file back to library root

**Image streaming:**
- Returns correct Content-Type
- Returns 404 for missing/deleted photos
- Streams file without buffering

### 16.3 Running Tests

Unit tests (mocked dependencies, run anywhere):

```bash
bun run test
```

That runs `bun test src`, covering `src/**/tests/*.test.ts`. Test helpers (`describe`, `expect`, `jest.fn`, …) are imported from `bun:test`.

Integration tests (need a real catalogue + `librawshim.so`, so they run in the container):

```bash
docker compose -f docker-compose.dev.yml up -d
docker exec -w /app bowerbird-dev bun test test/integration
```

These live in `test/integration/*.integration.test.ts` and cover the sync engine, image streaming, and repository DB behaviour end-to-end against a real Sony ARW fixture.

### 16.4 Known limits, stated rather than discovered

- **A crossing pairs on `file_hash`, which is a digest of the stat and the header** - extension, dimensions, mtime, colour space, size, orientation (§9.2) - **not of the pixels.** Two byte-identical copies collide by construction. Not new: live move detection has always had it. What the bin channel adds is that the collision can now cross the bin, and §9.1.1's path test only covers the common false *negative* (a copy whose mtime moved); the false positive stands.
- **Two instances sharing `/config` must share `/data`**, and only one of them may bin or move photographs. `needs_tile`, `needs_renditions` and `renditions_built_at` are columns in the shared database while the files are per-`DATA_DIR`, so with separate data directories whichever container builds a rendition clears the flags for both and the other serves 404s for ever with nothing able to queue the work. `libraryMutex` is process-global (§9.9) and cannot see the other container; mutations taking the lease and waiting is the fix, and is not implemented.
- **Two hosts are unsupported**, and were before: SQLite over a network filesystem has no working WAL shared memory.
- **A read-only library has no bin folder to open in Finder.** A binned photograph is visible in the app and untouched on disk, and nowhere else. Its bin also cannot be renamed from the app, there being none; renaming one by hand in a *flipped* library works and is followed (§9.1.1).
- **Photographs cannot be moved into or out of shoot folders** in a read-only library; albums cover the grouping (§8.6).
- **There is no migration onto this schema.** The `libraries` columns this added - `read_only`, the bin identity - and the `data_path` it removed are declared in `db/schema/libraries.ts` and generated into the one migration, on the stated basis that there are no installs to carry forward. A catalogue predating it is neither migrated nor recreated: it has to be rebuilt, and nothing detects that for you.

---

## 17. Implementation Order

The following order respects dependency chains — each step depends on the steps above it.

1. **Project scaffolding**: `package.json`, `tsconfig.json`, directory structure.
2. **Database**: `connection.ts` (opens the catalogue and sets `PRAGMA foreign_keys = ON`), `db/schema/` (declares every table, including `shoot_banners`/`album_banners`, and its indexes), `migrate.ts` (applies what `drizzle-kit` generated from them).
3. **Schemas**: All Zod schemas in `src/schemas/`.
4. **Utils**: `hash.ts`, `files.ts`, `paths.ts`.
5. **Repositories**: All repository classes (pure SQLite data access).
6. **Libraries service + API**: CRUD operations for libraries.
7. **RAW decoder / FFI**: `raw_decoder.ts` over the `rawshim` bindings. Needed before metadata, since metadata is read by the same reader's header parse.
8. **Metadata extraction**: `metadata.ts` (the header parse, no pixel decode).
9. **Photos service + API**: CRUD, listing, filtering.
10. **Processing service**: Worker-based rendition generation (reuses the RAW decoder).
11. **Sync service**: Full scan algorithm with move detection, reappearance handling, shoot-membership reconciliation, and the per-library sync lease (§9.7). Depends on the processing service (§8.4), which it calls to trigger rendition generation (§9.5).
12. **Shoots service + API**: CRUD, photo assignment with file moves.
13. **Albums service + API**: CRUD, photo assignment.
14. **Image streaming API**: Static-path file streaming endpoints.
15. **Deletion flow**: Soft-delete with Bin and rendition cleanup.
16. **Integration wiring**: `index.ts` — dependency injection, Hono app setup, server start.
