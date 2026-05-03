# Bowerbird — Design Document

## 1. Overview

Bowerbird is a high-performance RAW photo management and cataloguing backend designed to run on a server or NAS where photos are stored on local spinning disks. It exposes a REST API that a thin client (desktop, mobile, or web) can consume over the network.

**Stage 1 scope:**

- Library management (create, sync)
- Photo listing, filtering, and metadata
- Shoots and albums
- Thumbnail generation (small + full-size WebP)
- Streaming access to thumbnails and original RAW files
- Deletion with soft-delete and Bin folder
- Missing file detection

---

## 2. Technology Stack

| Concern | Choice |
|---|---|
| Language | TypeScript |
| Runtime | Bun |
| Web framework | Hono |
| Validation | Zod v4 |
| Database | SQLite via `bun:sqlite` |
| Image processing | sharp (WebP encoding/resizing) |
| RAW decoding | LibRaw via `bun:ffi` |
| Metadata extraction | sharp metadata + `exif-reader` |
| Testing | Jest |
| Logging | `console.log` / `console.info` / `console.error` |
| Package manager | `bun install` (no npm/pnpm/yarn) |

### System Dependencies

- **LibRaw** — must be installed on the host system. The Bun process loads `libraw.so` / `libraw.dylib` via FFI. On Debian/Ubuntu: `apt install libraw-dev`. On macOS: `brew install libraw`.

### NPM Dependencies

| Package | Purpose |
|---|---|
| `hono` | Web server and routing |
| `zod` | Schema validation (v4) |
| `sharp` | Image resizing and WebP encoding |
| `exif-reader` | EXIF metadata parsing from sharp's raw EXIF buffer |
| `uuid` | UUID v4 generation for entity IDs |
| `jest` | Unit testing |
| `@types/jest` | Jest type definitions |
| `ts-jest` | Jest TypeScript transformer |

No other third-party dependencies should be added without explicit approval.

---

## 3. Project Structure

```
bowerbird/
├── src/
│   ├── index.ts                    # Entry point: creates Hono app, wires dependencies, starts server
│   ├── db/
│   │   ├── connection.ts           # Creates and exports the bun:sqlite Database instance
│   │   └── migrations.ts           # Schema creation / migration logic (runs on startup)
│   ├── api/
│   │   ├── libraries/
│   │   │   ├── libraries_api.ts
│   │   │   └── tests/
│   │   │       └── libraries_api.test.ts
│   │   ├── photos/
│   │   │   ├── photos_api.ts
│   │   │   └── tests/
│   │   │       └── photos_api.test.ts
│   │   ├── shoots/
│   │   │   ├── shoots_api.ts
│   │   │   └── tests/
│   │   │       └── shoots_api.test.ts
│   │   ├── albums/
│   │   │   ├── albums_api.ts
│   │   │   └── tests/
│   │   │       └── albums_api.test.ts
│   │   └── image/
│   │       ├── image_api.ts        # Static-path image streaming endpoints
│   │       └── tests/
│   │           └── image_api.test.ts
│   ├── schemas/
│   │   ├── libraries.ts
│   │   ├── photos.ts
│   │   ├── shoots.ts
│   │   ├── albums.ts
│   │   └── common.ts              # Shared types: ordering enum, pagination, etc.
│   ├── services/
│   │   ├── libraries/
│   │   │   ├── libraries_service.ts
│   │   │   ├── libraries_repository.ts
│   │   │   └── tests/
│   │   │       └── libraries_service.test.ts
│   │   ├── photos/
│   │   │   ├── photos_service.ts
│   │   │   ├── photos_repository.ts
│   │   │   └── tests/
│   │   │       └── photos_service.test.ts
│   │   ├── shoots/
│   │   │   ├── shoots_service.ts
│   │   │   ├── shoots_repository.ts
│   │   │   └── tests/
│   │   │       └── shoots_service.test.ts
│   │   ├── albums/
│   │   │   ├── albums_service.ts
│   │   │   ├── albums_repository.ts
│   │   │   └── tests/
│   │   │       └── albums_service.test.ts
│   │   ├── sync/
│   │   │   ├── sync_service.ts     # Library sync algorithm
│   │   │   └── tests/
│   │   │       └── sync_service.test.ts
│   │   └── processing/
│   │       ├── processing_service.ts  # Thumbnail generation orchestrator
│   │       ├── processing_worker.ts   # Bun worker thread for image processing
│   │       ├── raw_decoder.ts         # LibRaw FFI bindings
│   │       ├── metadata.ts            # EXIF/metadata extraction via sharp + exif-reader
│   │       └── tests/
│   │           ├── processing_service.test.ts
│   │           └── metadata.test.ts
│   └── utils/
│       ├── hash.ts                 # File hash computation
│       ├── files.ts                # File system helpers (recursive listing, etc.)
│       └── paths.ts                # Path computation helpers (thumbnail paths, bin paths)
├── DESIGN.md
├── package.json
├── tsconfig.json
├── jest.config.ts
└── bunfig.toml
```

### Dependency Injection Pattern

All services take their repository (and any other service dependencies) as constructor parameters. All API classes take their service as a constructor parameter. This enables unit testing with mocked dependencies.

```typescript
// Example wiring in index.ts
const db = createDatabase();
const photosRepo = new PhotosRepository(db);
const photosService = new PhotosService(photosRepo);
const photosApi = new PhotosApi(photosService);
```

---

## 4. Database Schema

All `datetime` columns are stored as TEXT in ISO 8601 format with timezone (e.g. `2024-06-15T14:30:00.000+10:00`).

All UUIDs are v4, stored as TEXT.

### 4.1 `libraries` table

```sql
CREATE TABLE libraries (
  id          TEXT PRIMARY KEY,
  root_path   TEXT NOT NULL UNIQUE,
  data_path   TEXT,  -- path to .bowerbird/ data folder; NULL means default (<root_path>/.bowerbird/)
  ordering    TEXT NOT NULL DEFAULT 'taken_desc'
    CHECK (ordering IN ('taken_asc', 'taken_desc', 'added_asc', 'added_desc'))
);
```

- `root_path` — absolute path to the library root folder on disk.
- `data_path` — absolute path to the data directory for thumbnails and bin. If NULL, defaults to `<root_path>/.bowerbird/`.
- `ordering` — default ordering for photo listings in this library.

### 4.2 `photos` table

```sql
CREATE TABLE photos (
  id                TEXT PRIMARY KEY,
  library_id        TEXT NOT NULL REFERENCES libraries(id),
  shoot_id          TEXT REFERENCES shoots(id),
  file_hash         TEXT,
  file_path         TEXT NOT NULL,  -- relative to library root
  is_missing        INTEGER NOT NULL DEFAULT 0,
  is_deleted        INTEGER NOT NULL DEFAULT 0,
  date_taken        TEXT,
  date_added        TEXT NOT NULL,
  date_updated      TEXT,  -- last modified on disk
  date_reprocessed  TEXT,
  needs_processing  INTEGER NOT NULL DEFAULT 1,
  latitude          REAL,
  longitude         REAL,
  rating            INTEGER NOT NULL DEFAULT 0 CHECK (rating >= 0 AND rating <= 5),
  selected          INTEGER NOT NULL DEFAULT 0,
  notes             TEXT
);

CREATE INDEX idx_photos_library ON photos(library_id);
CREATE INDEX idx_photos_shoot ON photos(shoot_id);
CREATE INDEX idx_photos_file_hash ON photos(library_id, file_hash);
CREATE INDEX idx_photos_file_path ON photos(library_id, file_path);
CREATE INDEX idx_photos_needs_processing ON photos(needs_processing) WHERE needs_processing = 1;
CREATE INDEX idx_photos_is_missing ON photos(library_id, is_missing) WHERE is_missing = 1;
CREATE INDEX idx_photos_is_deleted ON photos(library_id, is_deleted) WHERE is_deleted = 1;
```

- `file_path` — relative to the library `root_path`. Uses forward slashes as separator regardless of OS.
- `is_missing` — set to 1 when the file is not found on disk during sync.
- `is_deleted` — set to 1 when the user requests deletion (file moved to Bin).
- `selected` — "selected for triage" flag.

### 4.3 `shoots` table

```sql
CREATE TABLE shoots (
  id            TEXT PRIMARY KEY,
  parent_id     TEXT REFERENCES shoots(id),
  library_id    TEXT NOT NULL REFERENCES libraries(id),
  folder_path   TEXT NOT NULL,  -- relative to library root
  name          TEXT NOT NULL,
  description   TEXT,
  banner_photo_id TEXT REFERENCES photos(id),
  ordering      TEXT NOT NULL DEFAULT 'taken_desc'
    CHECK (ordering IN ('taken_asc', 'taken_desc', 'added_asc', 'added_desc'))
);

CREATE INDEX idx_shoots_library ON shoots(library_id);
CREATE INDEX idx_shoots_parent ON shoots(parent_id);
```

- `folder_path` — the shoot's folder name, relative to the library root. For nested shoots (with a `parent_id`), this is relative to the parent shoot's folder.
- When a photo is added to a shoot, its file is physically moved on disk into the shoot's folder.

### 4.4 `albums` table

```sql
CREATE TABLE albums (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  ordering        TEXT NOT NULL DEFAULT 'taken_desc'
    CHECK (ordering IN ('taken_asc', 'taken_desc', 'added_asc', 'added_desc')),
  banner_photo_id TEXT REFERENCES photos(id)
);
```

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

---

## 5. Schemas (Zod)

All Zod schemas live under `src/schemas/`. They define the shape of request bodies, response bodies, and the domain entities themselves. They are imported by both API handlers (for request validation) and services (for return type safety).

### 5.1 `common.ts`

```typescript
import { z } from 'zod';

export const OrderingSchema = z.enum(['taken_asc', 'taken_desc', 'added_asc', 'added_desc']);
export type Ordering = z.infer<typeof OrderingSchema>;

export const PaginationSchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type Pagination = z.infer<typeof PaginationSchema>;

export const UuidSchema = z.string().uuid();

export const PhotoIdListSchema = z.object({
  photo_ids: z.array(UuidSchema).min(1),
});
```

### 5.2 `libraries.ts`

```typescript
export const CreateLibraryRequestSchema = z.object({
  root_path: z.string().min(1),
  data_path: z.string().optional(),
  ordering: OrderingSchema.default('taken_desc'),
});

export const LibrarySchema = z.object({
  id: UuidSchema,
  root_path: z.string(),
  data_path: z.string().nullable(),
  ordering: OrderingSchema,
});

export const LibrarySyncStatusSchema = z.object({
  library_id: UuidSchema,
  status: z.enum(['idle', 'scanning', 'processing']),
  photos_scanned: z.number().int(),
  photos_added: z.number().int(),
  photos_removed: z.number().int(),
  photos_moved: z.number().int(),
  photos_modified: z.number().int(),
  photos_processing: z.number().int(),
  photos_processed: z.number().int(),
});
```

### 5.3 `photos.ts`

```typescript
export const PhotoSummarySchema = z.object({
  id: UuidSchema,
  library_id: UuidSchema,
  shoot_id: UuidSchema.nullable(),
  width: z.number().int().positive().optional(),  // derived from metadata, not stored
  height: z.number().int().positive().optional(),
  ordering_date: z.string(),  // ISO datetime — resolved based on library/shoot/album ordering
  selected: z.boolean(),
  rating: z.number().int().min(0).max(5),
  is_missing: z.boolean(),
  is_deleted: z.boolean(),
});

export const PhotoDetailSchema = PhotoSummarySchema.extend({
  file_path: z.string(),
  file_hash: z.string().nullable(),
  date_taken: z.string().nullable(),
  date_added: z.string(),
  date_updated: z.string().nullable(),
  date_reprocessed: z.string().nullable(),
  needs_processing: z.boolean(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  notes: z.string().nullable(),
});

export const PhotoListResponseSchema = z.object({
  photos: z.array(PhotoSummarySchema),
  total: z.number().int(),
  offset: z.number().int(),
  limit: z.number().int(),
});

export const UpdatePhotoRequestSchema = z.object({
  rating: z.number().int().min(0).max(5).optional(),
  selected: z.boolean().optional(),
  notes: z.string().optional(),
});
```

### 5.4 `shoots.ts`

```typescript
export const CreateShootRequestSchema = z.object({
  library_id: UuidSchema,
  parent_id: UuidSchema.optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  ordering: OrderingSchema.default('taken_desc'),
});

export const ShootSchema = z.object({
  id: UuidSchema,
  parent_id: UuidSchema.nullable(),
  library_id: UuidSchema,
  folder_path: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  banner_photo_id: UuidSchema.nullable(),
  ordering: OrderingSchema,
});
```

### 5.5 `albums.ts`

```typescript
export const CreateAlbumRequestSchema = z.object({
  name: z.string().min(1),
  ordering: OrderingSchema.default('taken_desc'),
});

export const AlbumSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  ordering: OrderingSchema,
  banner_photo_id: UuidSchema.nullable(),
});
```

---

## 6. Library Data Directory

Each library has a **data directory** for generated files. By default, this is `<library_root>/.bowerbird/`. It can be overridden per-library via the `data_path` column.

### Structure

```
<data_path>/
├── thumbnails/
│   ├── small/          # 800px longest-edge WebP thumbnails
│   │   ├── <photo_uuid>.webp
│   │   └── ...
│   └── full/           # 3840px longest-edge WebP thumbnails
│       ├── <photo_uuid>.webp
│       └── ...
└── bin/                # Deleted original RAW files
    └── ...
```

### Path Resolution

```typescript
function getDataPath(library: Library): string {
  return library.data_path ?? path.join(library.root_path, '.bowerbird');
}

function getSmallThumbnailPath(library: Library, photoId: string): string {
  return path.join(getDataPath(library), 'thumbnails', 'small', `${photoId}.webp`);
}

function getFullThumbnailPath(library: Library, photoId: string): string {
  return path.join(getDataPath(library), 'thumbnails', 'full', `${photoId}.webp`);
}

function getBinPath(library: Library): string {
  return path.join(getDataPath(library), 'bin');
}
```

### Sync Exclusion

The scanner must skip the data directory (`.bowerbird/` or whatever `data_path` points to if it is a subdirectory of the library root) when recursively listing files. It should also skip any directory named `.bowerbird` to avoid picking up nested data directories.

---

## 7. Supported File Formats

**Stage 1:** Sony ARW (`.arw`, `.ARW`) only.

The sync scanner matches files by extension (case-insensitive). All other files are silently ignored.

```typescript
const SUPPORTED_EXTENSIONS = new Set(['.arw']);

function isSupportedFile(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return SUPPORTED_EXTENSIONS.has(ext);
}
```

---

## 8. Services

### 8.1 Libraries Service (`libraries_service.ts`)

**Constructor dependencies:** `LibrariesRepository`

**Methods:**

| Method | Description |
|---|---|
| `create(request)` | Validates the root path exists on disk, creates the data directory structure, inserts a library record, returns the library. |
| `get(libraryId)` | Returns a single library by ID. |
| `list()` | Returns all libraries. |
| `delete(libraryId)` | Deletes a library record. Does not delete files on disk. |

### 8.2 Photos Service (`photos_service.ts`)

**Constructor dependencies:** `PhotosRepository`, `AlbumsRepository`

**Methods:**

| Method | Description |
|---|---|
| `get(photoId)` | Returns full photo detail by ID. |
| `listByLibrary(libraryId, pagination, filters?)` | Returns paginated `PhotoSummary` list for a library. Supports filtering by `is_missing`, `is_deleted`, `needs_processing`. Ordering is determined by the library's `ordering` setting. |
| `listByShoot(shootId, pagination)` | Returns paginated `PhotoSummary` list for a shoot. |
| `listByAlbum(albumId, pagination)` | Returns paginated `PhotoSummary` list for an album. |
| `listMissing(libraryId, pagination)` | Convenience method: calls `listByLibrary` with `is_missing: true` filter. |
| `update(photoId, updates)` | Updates mutable fields: `rating`, `selected`, `notes`. |
| `delete(photoIds)` | Soft-deletes photos: moves RAW files to Bin, deletes thumbnails, sets `is_deleted = 1`. See §12. |
| `getAlbumMemberships(photoId)` | Returns list of album IDs the photo belongs to. Used internally by sync for move-detection bias. |

### 8.3 Sync Service (`sync_service.ts`)

**Constructor dependencies:** `PhotosRepository`, `LibrariesRepository`, `AlbumsRepository`, `ProcessingService`

This service handles the full sync algorithm. See §9 for the detailed algorithm.

**Methods:**

| Method | Description |
|---|---|
| `syncAll()` | Scans all libraries, computes diffs, reconciles moves across the full diff set, applies changes, then triggers processing. |
| `syncLibrary(libraryId)` | Scans a single library (but move detection still operates per-library only). |
| `getSyncStatus(libraryId)` | Returns the current sync/processing status for a library. |

### 8.4 Processing Service (`processing_service.ts`)

**Constructor dependencies:** `PhotosRepository`, `LibrariesRepository`

**Methods:**

| Method | Description |
|---|---|
| `processUnprocessed(libraryId?)` | Queries for photos with `needs_processing = 1`, spawns Bun worker threads (up to configured concurrency) to generate thumbnails. Updates `needs_processing`, `date_reprocessed` on completion. |
| `processPhoto(photoId)` | Processes a single photo (used by workers). |
| `getProcessingStatus(libraryId)` | Returns count of photos pending/completed processing. |

### 8.5 Shoots Service (`shoots_service.ts`)

**Constructor dependencies:** `ShootsRepository`, `PhotosRepository`, `LibrariesRepository`

**Methods:**

| Method | Description |
|---|---|
| `create(request)` | Creates a shoot record, creates the folder on disk. Folder name = shoot name. |
| `get(shootId)` | Returns a shoot by ID. |
| `list(libraryId)` | Returns all shoots in a library. |
| `addPhotos(shootId, photoIds)` | Moves photo files on disk into the shoot's folder. Updates each photo's `file_path` and `shoot_id` in the DB. A photo can only belong to one shoot — if it already belongs to another, it is moved out of the old shoot folder. |
| `removePhotos(shootId, photoIds)` | Moves photo files back to the library root. Clears the photo's `shoot_id`. |
| `delete(shootId)` | Deletes the shoot record. Photos in the shoot are moved back to the library root first. |
| `update(shootId, updates)` | Updates mutable fields: `name`, `description`, `banner_photo_id`, `ordering`. Name change also renames the folder on disk. |

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
| `update(albumId, updates)` | Updates mutable fields: `name`, `banner_photo_id`, `ordering`. |

---

## 9. Sync Algorithm

The sync algorithm is the most complex component. It is a stateless comparison between the database (prior state) and the filesystem (current state).

### 9.1 Phase 1: Scan

For each library:

1. Resolve the library's `root_path` and `data_path`.
2. Recursively list all files under `root_path`, skipping:
   - The data directory (`.bowerbird/` or custom `data_path` if it's under `root_path`).
   - Any hidden directories (starting with `.`).
3. Filter to supported extensions only (`.arw`).
4. For each file, compute the **file hash** (see §9.2).
5. Query the database for all non-deleted photo records in this library.
6. Build the diff:

```
DB records keyed by file_path  →  db_map: Map<file_path, PhotoRecord>
Disk files keyed by file_path  →  disk_map: Map<file_path, { hash: string, metadata: FileMetadata }>

For each entry in db_map:
  if file_path NOT in disk_map → mark as REMOVED
  if file_path in disk_map AND hash differs → mark as MODIFIED

For each entry in disk_map:
  if file_path NOT in db_map → mark as ADDED
```

Result per library:
```typescript
interface LibraryDiff {
  libraryId: string;
  removed: Array<{ filePath: string; photoId: string; fileHash: string }>;
  added: Array<{ filePath: string; fileHash: string; metadata: FileMetadata }>;
  modified: Array<{ filePath: string; photoId: string; oldHash: string; newHash: string; metadata: FileMetadata }>;
}
```

### 9.2 File Hash

The file hash is a SHA-1 digest of the following metadata properties, concatenated in a deterministic order:

1. File extension (lowercase, e.g. `.arw`)
2. Image width (pixels)
3. Image height (pixels)
4. Date modified (filesystem mtime, ISO string)
5. Color space (string identifier from EXIF, e.g. `sRGB`, or empty string if not available)
6. File size in bytes
7. Orientation/rotation (EXIF `Orientation` tag value, or `0` if not present)

**Critical rule:** Under no circumstances should the hash computation read past the file header/metadata. For ARW files, EXIF data is in the file header (TIFF-based structure), so reading resolution and orientation is safe. The implementation must not decode pixel data.

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

To implement this: before processing moves, iterate over modified entries and check if their old hash appears in the added map. If so, remove that entry from the added map (it will become a new photo), and leave the modified entry as-is (the existing record gets updated with the new hash).

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

1. **Moves:** Update `file_path` for each moved photo. Clear `is_missing` if it was set.
2. **Modifications:** Update `file_hash`, `date_updated`, `needs_processing = 1` for each modified photo. If the file metadata changed (resolution, GPS, etc.), update those columns too.
3. **Additions:** Insert new photo records:
   - `id` = new UUID v4
   - `library_id` = the library being synced
   - `file_path` = relative path from disk scan
   - `file_hash` = computed hash
   - `date_added` = current server datetime with timezone
   - `date_taken` = from EXIF `DateTimeOriginal` if available
   - `date_updated` = filesystem mtime
   - `latitude`, `longitude` = from EXIF GPS data if available
   - `needs_processing = 1`
   - `is_missing = 0`
   - `is_deleted = 0`
   - `rating = 0`
   - `selected = 0`
4. **Removals:** Set `is_missing = 1` for each removed photo. Do not delete files or records.

### 9.5 Phase 4: Trigger Processing

After all changes are applied, call `ProcessingService.processUnprocessed()` to begin background thumbnail generation for all photos with `needs_processing = 1`.

### 9.6 Sync Status Tracking

The sync service maintains an in-memory status object per library:

```typescript
interface SyncStatus {
  libraryId: string;
  status: 'idle' | 'scanning' | 'processing';
  photosScanned: number;
  photosAdded: number;
  photosRemoved: number;
  photosMoved: number;
  photosModified: number;
  photosProcessing: number;
  photosProcessed: number;
}
```

This is updated as the sync progresses and is exposed via the API for client polling.

---

## 10. Processing Pipeline

### 10.1 Overview

Processing converts RAW files into WebP thumbnails at two sizes:

| Size | Constraint | Output path |
|---|---|---|
| small | Longest edge = 800px, preserve aspect ratio | `<data_path>/thumbnails/small/<photo_uuid>.webp` |
| full | Longest edge = 3840px, preserve aspect ratio | `<data_path>/thumbnails/full/<photo_uuid>.webp` |

WebP encoding uses sharp's default quality settings (80) for the small thumbnail and quality 90 for the full thumbnail.

### 10.2 Concurrency Model

Processing uses **Bun worker threads** for parallelism. The concurrency level is configurable (default: 4 workers).

The orchestrator (`processing_service.ts`):
1. Queries for all photos with `needs_processing = 1`.
2. Maintains a work queue.
3. Spawns up to N Bun `Worker` instances, each running `processing_worker.ts`.
4. Sends photo processing jobs to workers via `postMessage`.
5. Workers send completion/error messages back.
6. On completion, the orchestrator updates the photo record: `needs_processing = 0`, `date_reprocessed = now()`.

### 10.3 Worker Implementation (`processing_worker.ts`)

Each worker:
1. Receives a message with `{ photoId, rawFilePath, smallOutputPath, fullOutputPath }`.
2. Decodes the RAW file using LibRaw via FFI → produces an in-memory RGB bitmap buffer.
3. Passes the bitmap buffer to sharp.
4. Generates small thumbnail: `sharp(buffer).resize({ width: 800, height: 800, fit: 'inside' }).webp({ quality: 80 }).toFile(smallOutputPath)`.
5. Generates full thumbnail: `sharp(buffer).resize({ width: 3840, height: 3840, fit: 'inside' }).webp({ quality: 90 }).toFile(fullOutputPath)`.
6. Sends back `{ photoId, success: true }` or `{ photoId, success: false, error: string }`.

### 10.4 LibRaw FFI Bindings (`raw_decoder.ts`)

Minimal FFI bindings for LibRaw:

```typescript
// Pseudocode for the FFI interface
const libraw = dlopen('libraw.so', {
  libraw_init: { args: ['i32'], returns: 'ptr' },
  libraw_open_file: { args: ['ptr', 'ptr'], returns: 'i32' },
  libraw_unpack: { args: ['ptr'], returns: 'i32' },
  libraw_dcraw_process: { args: ['ptr'], returns: 'i32' },
  libraw_dcraw_make_mem_image: { args: ['ptr', 'ptr'], returns: 'ptr' },
  libraw_close: { args: ['ptr'], returns: 'void' },
  libraw_recycle: { args: ['ptr'], returns: 'void' },
});
```

The decoder function:
1. Calls `libraw_init(0)` to create a processor.
2. Opens the file with `libraw_open_file`.
3. Calls `libraw_unpack` and `libraw_dcraw_process`.
4. Calls `libraw_dcraw_make_mem_image` to get the processed image in memory.
5. Reads the image dimensions and pixel data from the returned struct.
6. Returns `{ width, height, data: Buffer }` (raw RGB pixels).
7. Cleans up with `libraw_recycle` and `libraw_close`.

This buffer is then passed to sharp as `sharp(data, { raw: { width, height, channels: 3 } })`.

---

## 11. Metadata Extraction (`metadata.ts`)

Used during sync to populate photo records and compute file hashes.

### 11.1 Implementation

```typescript
import sharp from 'sharp';
import exifReader from 'exif-reader';

interface FileMetadata {
  width: number;
  height: number;
  colorSpace: string;
  orientation: number;
  dateTaken: string | null;  // ISO datetime
  latitude: number | null;
  longitude: number | null;
}

async function extractMetadata(filePath: string): Promise<FileMetadata> {
  const metadata = await sharp(filePath).metadata();
  
  let exif: any = {};
  if (metadata.exif) {
    exif = exifReader(metadata.exif);
  }

  return {
    width: metadata.width ?? 0,
    height: metadata.height ?? 0,
    colorSpace: metadata.space ?? '',
    orientation: metadata.orientation ?? 0,
    dateTaken: exif?.Photo?.DateTimeOriginal?.toISOString() ?? null,
    latitude: parseGpsCoordinate(exif?.GPSInfo?.GPSLatitude, exif?.GPSInfo?.GPSLatitudeRef),
    longitude: parseGpsCoordinate(exif?.GPSInfo?.GPSLongitude, exif?.GPSInfo?.GPSLongitudeRef),
  };
}
```

Note: `sharp` can read TIFF-based file headers (which ARW uses) without decoding the full image. This is safe and fast for metadata extraction — it does not read pixel data.

### 11.2 Hash Computation (`hash.ts`)

```typescript
import { createHash } from 'crypto';
import { stat } from 'fs/promises';

async function computeFileHash(filePath: string, metadata: FileMetadata): Promise<string> {
  const stats = await stat(filePath);
  const ext = path.extname(filePath).toLowerCase();
  
  const input = [
    ext,
    metadata.width,
    metadata.height,
    stats.mtime.toISOString(),
    metadata.colorSpace,
    stats.size,
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

1. **Delete thumbnails on disk:**
   - Remove `<data_path>/thumbnails/small/<photo_uuid>.webp` if it exists.
   - Remove `<data_path>/thumbnails/full/<photo_uuid>.webp` if it exists.

2. **Move RAW file to Bin:**
   - Determine the bin path:
     - If the photo is in a shoot: `<shoot_folder>/Bin/<original_filename>`
     - Otherwise: `<data_path>/bin/<original_filename>`
   - If a file with the same name already exists in the Bin, append a numeric suffix (e.g. `IMG_0001_1.ARW`, `IMG_0001_2.ARW`).
   - Move (rename) the file. Do **not** copy-and-delete.

3. **Update DB record:**
   - Set `is_deleted = 1`.
   - Set `needs_processing = 0`.
   - Do **not** delete the record.

### 12.2 Bin Folder

The Bin folder for shoots lives at `<shoot_folder>/Bin/` (inside the shoot folder itself). The Bin folder for non-shoot photos lives at `<data_path>/bin/`.

The sync scanner must skip `Bin/` directories inside shoot folders to avoid re-importing deleted files.

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
| `POST` | `/api/libraries` | Create a library |
| `GET` | `/api/libraries` | List all libraries |
| `GET` | `/api/libraries/:id` | Get a library |
| `DELETE` | `/api/libraries/:id` | Delete a library |
| `POST` | `/api/libraries/:id/sync` | Trigger sync for a library |
| `GET` | `/api/libraries/:id/sync/status` | Get sync/processing status |

### 13.2 Photos

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/libraries/:libraryId/photos` | List photos in a library (paginated, filterable) |
| `GET` | `/api/libraries/:libraryId/photos/missing` | List missing photos in a library |
| `GET` | `/api/photos/:id` | Get full photo detail |
| `PATCH` | `/api/photos/:id` | Update photo metadata (rating, selected, notes) |
| `POST` | `/api/photos/delete` | Soft-delete photos (body: `{ photo_ids: string[] }`) |

Query parameters for listing:
- `offset` (int, default 0)
- `limit` (int, default 100, max 500)
- `is_missing` (boolean, optional filter)
- `is_deleted` (boolean, optional filter)

### 13.3 Shoots

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/shoots` | Create a shoot |
| `GET` | `/api/libraries/:libraryId/shoots` | List shoots in a library |
| `GET` | `/api/shoots/:id` | Get a shoot |
| `PATCH` | `/api/shoots/:id` | Update a shoot |
| `DELETE` | `/api/shoots/:id` | Delete a shoot |
| `POST` | `/api/shoots/:id/photos` | Add photos to a shoot (body: `{ photo_ids }`) |
| `DELETE` | `/api/shoots/:id/photos` | Remove photos from a shoot (body: `{ photo_ids }`) |
| `GET` | `/api/shoots/:id/photos` | List photos in a shoot (paginated) |

### 13.4 Albums

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/albums` | Create an album |
| `GET` | `/api/albums` | List all albums |
| `GET` | `/api/albums/:id` | Get an album |
| `PATCH` | `/api/albums/:id` | Update an album |
| `DELETE` | `/api/albums/:id` | Delete an album |
| `POST` | `/api/albums/:id/photos` | Add photos to an album (body: `{ photo_ids }`) |
| `DELETE` | `/api/albums/:id/photos` | Remove photos from an album (body: `{ photo_ids }`) |
| `GET` | `/api/albums/:id/photos` | List photos in an album (paginated) |

### 13.5 Image Streaming

| Method | Path | Description |
|---|---|---|
| `GET` | `/image/:photoId/small.webp` | Stream small thumbnail |
| `GET` | `/image/:photoId/full.webp` | Stream full thumbnail |
| `GET` | `/image/:photoId/original.arw` | Stream original RAW file |

These endpoints:
- Resolve the file path from the photo record and library configuration.
- Stream the file directly from disk using Bun's file streaming (no buffering into memory).
- Set appropriate `Content-Type` headers (`image/webp` or `image/x-sony-arw`).
- Set `Content-Length` from file stats.
- Return 404 if the file does not exist on disk or the photo is deleted.
- Support `Range` requests for partial content (HTTP 206), enabling seeking for large files.

Implementation approach:
```typescript
app.get('/image/:photoId/small.webp', async (c) => {
  const photo = await photosService.get(c.req.param('photoId'));
  if (!photo || photo.is_deleted) return c.notFound();
  
  const library = await librariesService.get(photo.library_id);
  const filePath = getSmallThumbnailPath(library, photo.id);
  
  const file = Bun.file(filePath);
  if (!await file.exists()) return c.notFound();
  
  return new Response(file);  // Bun streams this from disk
});
```

`Bun.file()` returns a lazy reference that streams from disk when consumed as a `Response` body — no full read into memory.

---

## 14. Error Handling

### 14.1 Error Codes

| Code | HTTP Status | Description |
|---|---|---|
| `NOT_FOUND` | 404 | Entity not found |
| `VALIDATION_ERROR` | 400 | Request validation failed |
| `CONFLICT` | 409 | Conflicting operation (e.g. library root already registered) |
| `IO_ERROR` | 500 | Filesystem operation failed |
| `SYNC_IN_PROGRESS` | 409 | Sync already running for this library |
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

---

## 15. Configuration

The server is configured via environment variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `HOST` | `0.0.0.0` | HTTP server bind address |
| `DB_PATH` | `./bowerbird.db` | SQLite database file path |
| `PROCESSING_CONCURRENCY` | `4` | Number of worker threads for thumbnail generation |
| `SMALL_THUMBNAIL_QUALITY` | `80` | WebP quality for small thumbnails (1-100) |
| `FULL_THUMBNAIL_QUALITY` | `90` | WebP quality for full thumbnails (1-100) |
| `SMALL_THUMBNAIL_SIZE` | `800` | Longest edge in pixels for small thumbnails |
| `FULL_THUMBNAIL_SIZE` | `3840` | Longest edge in pixels for full thumbnails |

---

## 16. Testing Strategy

### 16.1 Unit Tests

All services and API handlers have unit tests. Dependencies are mocked via constructor injection.

**Repository mocks:** Each repository interface is mocked to return predetermined data, allowing service logic to be tested in isolation without touching SQLite.

**Service mocks:** API handler tests mock the service layer to test request validation, response formatting, and HTTP status codes.

### 16.2 Key Test Cases

**Sync service:**
- Basic add/remove/modify detection
- Move detection (same hash in removed + added)
- Duplicate handling: 3 copies → 2 removed + 1 added = 1 move + 1 removal
- Album membership bias: prefer removing photos not in albums
- Modified + added with original hash (special case from §9.3)
- Files in `.bowerbird/` directory are excluded
- Files in shoot `Bin/` directories are excluded
- Non-ARW files are ignored

**Photo deletion:**
- Thumbnails are removed
- RAW file is moved to correct Bin location (shoot vs library)
- DB record is marked `is_deleted = 1`, not removed
- Filename collision in Bin (numeric suffix)

**Shoot operations:**
- Adding photo to shoot moves file on disk
- Adding photo already in another shoot moves it out of old shoot
- Removing photo from shoot moves file back to library root

**Image streaming:**
- Returns correct Content-Type
- Returns 404 for missing/deleted photos
- Streams file without buffering

### 16.3 Running Tests

```bash
bun test
```

Jest is configured with `ts-jest` for TypeScript transformation. Test files follow the `*.test.ts` naming convention.

---

## 17. Implementation Order

The following order respects dependency chains — each step depends on the steps above it.

1. **Project scaffolding**: `package.json`, `tsconfig.json`, `jest.config.ts`, directory structure.
2. **Database**: `connection.ts`, `migrations.ts` (create all tables and indexes).
3. **Schemas**: All Zod schemas in `src/schemas/`.
4. **Utils**: `hash.ts`, `files.ts`, `paths.ts`.
5. **Repositories**: All repository classes (pure SQLite data access).
6. **Libraries service + API**: CRUD operations for libraries.
7. **Metadata extraction**: `metadata.ts` (sharp + exif-reader).
8. **Photos service + API**: CRUD, listing, filtering.
9. **Sync service**: Full sync algorithm with move detection.
10. **RAW decoder**: LibRaw FFI bindings.
11. **Processing service**: Worker-based thumbnail generation.
12. **Shoots service + API**: CRUD, photo assignment with file moves.
13. **Albums service + API**: CRUD, photo assignment.
14. **Image streaming API**: Static-path file streaming endpoints.
15. **Deletion flow**: Soft-delete with Bin and thumbnail cleanup.
16. **Integration wiring**: `index.ts` — dependency injection, Hono app setup, server start.
