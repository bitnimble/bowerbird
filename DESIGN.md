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
| RAW decoding | Per-format dispatch (header sniff → fastest reader); Sony ARW via LibRaw `bun:ffi` |
| Metadata extraction | LibRaw header parse (no pixel decode), per-format dispatch |
| Testing | Jest (run via `bun run test`) |
| Logging | `console.log` / `console.info` / `console.error` |
| Package manager | `bun install` (no npm/pnpm/yarn) |

### System Dependencies

- **LibRaw** — must be installed on the host system. The Bun process loads `libraw.so` / `libraw.dylib` via FFI. On Debian/Ubuntu: `apt install libraw-dev`. On macOS: `brew install libraw`.

### NPM Dependencies

| Package | Purpose |
|---|---|
| `hono` | Web server and routing |
| `zod` | Schema validation (v4) |
| `sharp` | Image resizing and WebP encoding (operates on decoded RGB buffers, never on RAW files directly) |
| `jest` | Unit testing |
| `@types/jest` | Jest type definitions |
| `ts-jest` | Jest TypeScript transformer |

Entity IDs (UUID v4) are generated with the runtime built-in `crypto.randomUUID()`, no third-party UUID package.

RAW decoding and RAW metadata extraction are **dispatched per format**: a cheap header sniff (magic bytes / EXIF `Make`) selects the fastest maintained reader for that format, so each format can use its optimal library rather than a single lowest-common-denominator one. Stage 1 supports Sony ARW only, decoded via LibRaw (fast, actively maintained). Additional formats are added by registering another reader behind the same dispatch interface; Sony RAW is the priority when a reader supports only a subset of formats.

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
│   │       ├── metadata.ts            # Per-format metadata extraction (LibRaw header parse for ARW)
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

All services take their repository (and any other service dependencies) as constructor parameters. All API classes take their primary service (and any other service dependencies) as constructor parameters. Most API classes need more than one service (only `photos_api` needs a single one): `image_api` takes both `photosService` and `librariesService` (§13.5), the API owning the sync endpoints takes `SyncService` alongside `LibrariesService` (§13.1), and `shoots_api` and `albums_api` each take `PhotosService` alongside their own service to serve their photo-listing endpoints (§13.3, §13.4) via `PhotosService.listByShoot`/`listByAlbum` (§8.2). This enables unit testing with mocked dependencies.

```typescript
// Example wiring in index.ts
const db = createDatabase();
const photosRepo = new PhotosRepository(db);
const albumsRepo = new AlbumsRepository(db);
const shootsRepo = new ShootsRepository(db);
const librariesRepo = new LibrariesRepository(db);
const photosService = new PhotosService(photosRepo, albumsRepo, shootsRepo, librariesRepo);  // four repos per §8.2
const photosApi = new PhotosApi(photosService);
```

---

## 4. Database Schema

All `datetime` columns are stored as TEXT in normalized UTC ISO 8601 format with a `Z` suffix (e.g. `2024-06-15T04:30:00.000Z`). Normalizing to UTC means lexicographic (byte) comparison equals chronological order, so the `date_added`/`date_taken` ordering indexes (§4.2) sort correctly regardless of the originating offset (camera timezone for `date_taken`, server offset shifting across DST for `date_added`).

All UUIDs are v4, stored as TEXT.

Foreign keys are enforced. `bun:sqlite` does not enable this by default, so `migrations.ts`/`connection.ts` must run `PRAGMA foreign_keys = ON` on every connection. The schema is acyclic (no table pair references each other) so migrations can be created in dependency order.

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
  library_id        TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  shoot_id          TEXT REFERENCES shoots(id) ON DELETE SET NULL,
  file_hash         TEXT,
  file_path         TEXT NOT NULL,  -- relative to library root
  file_size         INTEGER,        -- bytes at last scan; with date_updated, the sync stat quick-check (§9.1)
  width             INTEGER NOT NULL,  -- display (upright) pixel width, post-orientation
  height            INTEGER NOT NULL,  -- display (upright) pixel height, post-orientation
  orientation       INTEGER NOT NULL DEFAULT 0,  -- LibRaw flip orientation code; informational + hash input only, NOT to be applied to thumbnails (§11)
  is_missing        INTEGER NOT NULL DEFAULT 0,
  is_deleted        INTEGER NOT NULL DEFAULT 0,
  date_taken        TEXT,
  date_added        TEXT NOT NULL,
  date_updated      TEXT,  -- last modified on disk
  date_reprocessed  TEXT,
  needs_processing  INTEGER NOT NULL DEFAULT 1,
  processing_error  TEXT,  -- last thumbnail-generation error; NULL if none/succeeded (§10.2)
  latitude          REAL,
  longitude         REAL,
  rating            INTEGER NOT NULL DEFAULT 0 CHECK (rating >= 0 AND rating <= 5),
  selected          INTEGER NOT NULL DEFAULT 0,
  notes             TEXT
);

CREATE INDEX idx_photos_library ON photos(library_id);
CREATE INDEX idx_photos_shoot ON photos(shoot_id);
CREATE INDEX idx_photos_library_added ON photos(library_id, date_added);
CREATE INDEX idx_photos_library_taken ON photos(library_id, date_taken);
CREATE INDEX idx_photos_shoot_added ON photos(shoot_id, date_added);
CREATE INDEX idx_photos_shoot_taken ON photos(shoot_id, date_taken);
CREATE INDEX idx_photos_file_hash ON photos(library_id, file_hash);
CREATE INDEX idx_photos_file_path ON photos(library_id, file_path);
CREATE INDEX idx_photos_needs_processing ON photos(needs_processing) WHERE needs_processing = 1;
CREATE INDEX idx_photos_is_missing ON photos(library_id, is_missing) WHERE is_missing = 1;
CREATE INDEX idx_photos_is_deleted ON photos(library_id, is_deleted) WHERE is_deleted = 1;
```

- The `_added`/`_taken` composite indexes serve the paginated library and shoot list orderings (§5.1, §8.2 `listByLibrary`/`listByShoot`): each leads with the equality-filtered column (`library_id`/`shoot_id`) followed by the sort column, so `added_*` orderings are served without a filesort. For `taken_*`, the leading `date_taken IS NULL` sort expression cannot be indexed directly, so the B-tree serves the `date_taken` tiebreak but the NULL-last grouping still requires evaluating the expression; NULL `date_taken` rows are rare, so the residual cost is small. Album listings (`listByAlbum`, §8.2) are not covered: albums have no `library_id` (§4.4) so they span arbitrary photos, and `album_photos` is keyed only on `(album_id, photo_id)` (§4.5), so neither the date composites nor the album PK anchor an album-scoped ordering; these listings therefore incur a filesort, accepted as albums are typically small.

- `file_path` — relative to the library `root_path`. Uses forward slashes as separator regardless of OS.
- `is_missing` — set to 1 when the file is not found on disk during sync.
- `is_deleted` — set to 1 when the user requests deletion (file moved to Bin).
- `selected` — "selected for triage" flag.

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
  UNIQUE (library_id, name)
);

CREATE INDEX idx_shoots_library ON shoots(library_id);
CREATE INDEX idx_shoots_parent ON shoots(parent_id);
```

- `folder_path` is the **full** path from the library root to this shoot's folder (forward slashes), e.g. `Weddings/2024/Smith`. It is *not* parent-relative: storing the full path lets sync reconciliation (§9.4) and create-adoption (§8.5) test membership with a `file_path` prefix check, and lets the most-specific (longest matching) shoot win for nested folders. On create it is computed as `parent ? parent.folder_path + '/' + name : name`. A parent rename (§8.5 `update`) therefore cascade-updates every descendant's `folder_path` within the same transaction.
- **Membership test (used everywhere "a file falls under a shoot" is checked):** a file belongs to a shoot iff `file_path` starts with `folder_path + '/'`; the trailing separator is required so shoot `NYC` (`folder_path` `NYC`) does not capture files in sibling shoot `NYC2`. "Directly under" a shoot means the remainder after that prefix contains no further `/` (deeper files belong to a descendant shoot). Among all matching shoots, the one with the longest `folder_path` wins.
- When a photo is added to a shoot, its file is physically moved on disk into the shoot's folder.
- Shoot names are **unique library-wide** (`UNIQUE (library_id, name)`), a deliberate simplification rather than the minimum needed. On-disk folder collisions are only possible between shoots sharing a parent (a shoot's folder is named after its `name`, created under the parent's folder), so a `(library_id, parent_id, name)` constraint would be the tight fit, but SQLite treats `NULL`s as distinct in UNIQUE constraints, so it would fail to catch collisions between root-level shoots (`parent_id IS NULL`). Library-wide uniqueness is a strict superset that closes that hole and keeps names unambiguous. Tradeoff: it disallows the same name under different parents (e.g. "Day1" under both "NYC" and "LA"). A create/rename to a name already used by any shoot in the library returns `CONFLICT`.
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

export const UuidSchema = z.uuid();  // Zod v4 top-level format API

// Every list endpoint accepts this filter. Default excludes soft-deleted rows.
// NB: use z.stringbool(), NOT z.coerce.boolean(), the latter runs Boolean("false")
// which is true, so ?include_deleted=false would wrongly parse as true.
export const SoftDeleteFilterSchema = z.object({
  include_deleted: z.stringbool().default(false),
});
export type SoftDeleteFilter = z.infer<typeof SoftDeleteFilterSchema>;

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
  width: z.number().int().positive(),   // display/upright dims, match the served thumbnail
  height: z.number().int().positive(),
  ordering_date: z.string().nullable(),  // ISO datetime, resolved based on library/shoot/album ordering; NULL for a taken_* ordering when date_taken is NULL (sorts last, §5.1)
  selected: z.boolean(),
  rating: z.number().int().min(0).max(5),
  is_missing: z.boolean(),
  is_deleted: z.boolean(),
});

export const PhotoDetailSchema = PhotoSummarySchema.extend({
  file_path: z.string(),
  file_hash: z.string().nullable(),
  orientation: z.number().int(),  // LibRaw flip orientation code; informational only, thumbnails are already upright (§11), do NOT rotate them by this
  date_taken: z.string().nullable(),
  date_added: z.string(),
  date_updated: z.string().nullable(),
  date_reprocessed: z.string().nullable(),
  needs_processing: z.boolean(),
  processing_error: z.string().nullable(),
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

// Query params for photo listing. All booleans use z.stringbool() (not
// z.coerce.boolean()) so ?is_missing=false parses as false, not true.
export const PhotoListQuerySchema = PaginationSchema
  .extend(SoftDeleteFilterSchema.shape)  // include_deleted
  .extend({
    is_missing: z.stringbool().optional(),
    needs_processing: z.stringbool().optional(),
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

export const UpdateShootRequestSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  ordering: OrderingSchema.optional(),
  banner_photo_id: UuidSchema.nullable().optional(),  // null clears the banner (§4.6)
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

export const UpdateAlbumRequestSchema = z.object({
  name: z.string().min(1).optional(),
  ordering: OrderingSchema.optional(),
  banner_photo_id: UuidSchema.nullable().optional(),  // null clears the banner (§4.6)
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

The sync scanner matches files by extension (case-insensitive). All other files are silently ignored. The extension set is the *scan filter*; the actual decoder/metadata reader is chosen later by header sniff (§10, §11), so a future format is added by registering a reader plus extending this set.

```typescript
const SUPPORTED_EXTENSIONS = new Set(['.arw']);

function isSupportedFile(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return SUPPORTED_EXTENSIONS.has(ext);
}
```

---

## 8. Services

**Deletion never touches folders on disk.** Deleting any entity (library, shoot, album) removes only DB records; it never deletes or moves files or directories. Photo files stay exactly where they are on disk. (The one *deletion* operation that *does* move a file is soft-deleting a *photo*, §12, which relocates the RAW into a Bin; shoot photo add/remove/rename also move files, §8.5, but those are not deletions.) This keeps deletes cheap and non-destructive, and means a re-sync after a mistaken delete re-imports the photos rather than losing them.

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

**Constructor dependencies:** `PhotosRepository`, `AlbumsRepository`, `ShootsRepository`, `LibrariesRepository` (the latter two are needed by `delete()` to resolve the Bin path: library `data_path`, and the shoot folder when the photo is in a shoot, §12).

**Methods:**

| Method | Description |
|---|---|
| `get(photoId)` | Returns full photo detail by ID. |
| `listByLibrary(libraryId, pagination, filters?)` | Returns paginated `PhotoSummary` list for a library. Excludes soft-deleted photos unless `include_deleted` is set (§13.2). Supports optional `is_missing` and `needs_processing` filters. Ordering is determined by the library's `ordering` setting, with NULL ordering dates sorted last. |
| `listByShoot(shootId, pagination, filters?)` | Returns paginated `PhotoSummary` list for a shoot. Accepts the same `include_deleted` filter (§13.2), excluding soft-deleted by default. |
| `listByAlbum(albumId, pagination, filters?)` | Returns paginated `PhotoSummary` list for an album. Accepts the same `include_deleted` filter, excluding soft-deleted by default. |
| `listMissing(libraryId, pagination)` | Convenience method: calls `listByLibrary` with `is_missing: true` filter. |
| `update(photoId, updates)` | Updates mutable fields: `rating`, `selected`, `notes`. |
| `delete(photoIds)` | Soft-deletes photos: moves RAW files to Bin, deletes thumbnails, sets `is_deleted = 1`. See §12. |
| `getAlbumMemberships(photoId)` | Returns list of album IDs the photo belongs to. |

### 8.3 Sync Service (`sync_service.ts`)

**Constructor dependencies:** `PhotosRepository`, `LibrariesRepository`, `AlbumsRepository`, `ShootsRepository`, `ProcessingService` (`ShootsRepository` is needed to reconcile `shoot_id` from a file's path against known shoot `folder_path`s, §9.4).

This service handles the full sync algorithm. See §9 for the detailed algorithm.

**Methods:**

| Method | Description |
|---|---|
| `syncAll()` | Scans all libraries, computes each library's diff, runs move detection **per library** (a file that moved between libraries is a delete in one plus an add in the other, so per-library delete/add hooks fire correctly), applies changes, then triggers processing. |
| `syncLibrary(libraryId)` | Scans a single library. Move detection is per-library, identical to one library's pass in `syncAll`. |
| `getSyncStatus(libraryId)` | Returns the current sync/processing status for a library. |

### 8.4 Processing Service (`processing_service.ts`)

**Constructor dependencies:** `PhotosRepository`, `LibrariesRepository`

**Methods:**

| Method | Description |
|---|---|
| `processUnprocessed(libraryId?)` | Queries for photos with `needs_processing = 1` and `is_missing = 0`, spawns Bun worker threads (up to configured concurrency) to generate thumbnails. Updates `needs_processing`, `date_reprocessed` on completion. |
| `processPhoto(photoId)` | Processes a single photo on the main thread: resolves the raw file and thumbnail output paths from the repositories, dispatches the job to a worker (§10.2, §10.3), and persists the result. |
| `getProcessingStatus(libraryId)` | Returns count of photos pending/completed processing. |

### 8.5 Shoots Service (`shoots_service.ts`)

**Constructor dependencies:** `ShootsRepository`, `PhotosRepository`, `LibrariesRepository`

**Methods:**

| Method | Description |
|---|---|
| `create(request)` | Creates a shoot record. The folder is named after the shoot `name`, created under the parent shoot's folder (or the library root if no parent); `folder_path` is stored as the full root-relative path (§4.3). If the folder does not exist, it is created. If it **already exists**, it is kept as-is and its photos are **adopted**: every existing non-deleted photo record whose `file_path` falls under this folder and for which this shoot is the most-specific matching shoot (i.e. not already claimed by a more-specific descendant shoot) has its `shoot_id` set to the new shoot. No files move on disk and no reprocessing occurs (thumbnails are keyed by photo UUID, unaffected by shoot membership). This mirrors the sync reconciliation rule (§9.4) and makes an orphaned folder from a prior shoot delete re-adoptable. ARW files physically present but not yet in the DB are picked up by the next sync, which will assign them to this shoot via the same reconciliation. |
| `get(shootId)` | Returns a shoot by ID. |
| `list(libraryId)` | Returns all shoots in a library. |
| `addPhotos(shootId, photoIds)` | Moves photo files on disk into the shoot's folder. Updates each photo's `file_path` and `shoot_id` in the DB. A photo can only belong to one shoot; if it already belongs to another, it is moved out of the old shoot folder. If a file with the same name already exists in the destination folder, append a numeric suffix (e.g. `IMG_0001_1.ARW`, `IMG_0001_2.ARW`) so no existing file is overwritten and no two records share a `file_path` (§12.1). |
| `removePhotos(shootId, photoIds)` | Moves photo files back to the library root. Updates each photo's `file_path` and clears its `shoot_id`. If a file with the same name already exists in the library root, append a numeric suffix (e.g. `IMG_0001_1.ARW`, `IMG_0001_2.ARW`) so no existing file is overwritten and no two records share a `file_path` (§12.1). |
| `delete(shootId)` | Deletes the shoot record only. **No files or folders on disk are touched** (see principle above): photos keep their `file_path` and remain physically in the (now-orphaned) folder, which the next sync treats as an ordinary subfolder. Their `shoot_id` is cleared via `ON DELETE SET NULL`, and child shoots cascade-delete as records (their photos' folders likewise untouched). |
| `update(shootId, updates)` | Updates mutable fields: `name`, `description`, `ordering`. A **name change** renames the folder on disk and, in the same DB transaction, rewrites this shoot's `folder_path`, every descendant shoot's `folder_path`, and the `file_path` of every photo under the folder (all are root-relative and contain the renamed segment). A rename to a name already used by any shoot in the same library returns `CONFLICT` (names are unique library-wide, §4.3). Setting `banner_photo_id` upserts the `shoot_banners` row; clearing it (null) deletes that row; it is not a column on `shoots` (§4.6). |

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

## 9. Sync Algorithm

The sync algorithm is the most complex component. It is a stateless comparison between the database (prior state) and the filesystem (current state).

### 9.1 Phase 1: Scan

For each library:

1. Resolve the library's `root_path` and `data_path`.
2. Recursively list all files under `root_path`, skipping:
   - The data directory (`.bowerbird/` or custom `data_path` if it's under `root_path`).
   - Any hidden directories (starting with `.`).
   - Any directory named `Bin` (the deletion bins that live inside shoot folders, §12.2), so soft-deleted files are never re-imported.
3. Filter to supported extensions only (`.arw`). This yields the set of **present** file paths.
4. Query the database for all non-deleted photo records in this library (each carries its stored `date_updated` = last-seen mtime and `file_size`).
5. **Stat quick-check (avoid opening unchanged files).** For each present file, `stat` it (cheap; no open). If a DB record exists at that path **and** its stored `date_updated` and `file_size` both match the current mtime and size, the file is **unchanged**: reuse its stored hash and do **not** open it. Only files that are new, or whose mtime/size differ, are opened to extract metadata (§11) and compute the **file hash** (§9.2). Call this opened subset **changed**. A no-op sync therefore performs zero LibRaw opens. (Like rsync's default quick-check, this misses a content change that preserves *both* mtime and size, which is rare in practice; a forced full re-hash is the escape hatch if ever needed.)
6. Build the diff from the present set and the changed set:

```
present  : Set<file_path>                       (every supported file on disk)
changed  : Map<file_path, { hash, metadata }>   (only new / mtime-or-size-changed files, i.e. opened)
db_map   : Map<file_path, PhotoRecord>          (non-deleted records)

For each entry in db_map:
  if file_path NOT in present → mark as REMOVED
  else if file_path in changed AND changed.hash differs from record.hash → mark as MODIFIED
  else if record.is_missing → mark as REAPPEARED   (present, unchanged, was missing)

For each entry in changed:
  if file_path NOT in db_map → mark as ADDED
```

Unchanged files (present but not in `changed`) produce no diff entry, so they are never opened and never re-hashed.

The REAPPEARED case matters: a file that went missing and returns **at its original path with the same content** is neither modified nor moved, so without this it would stay flagged `is_missing = 1` forever. (Reappearance at a *different* path is handled by move detection.)

Result per library:
```typescript
interface LibraryDiff {
  libraryId: string;
  removed: Array<{ filePath: string; photoId: string; fileHash: string }>;
  added: Array<{ filePath: string; fileHash: string; metadata: FileMetadata }>;
  modified: Array<{ filePath: string; photoId: string; oldHash: string; newHash: string; metadata: FileMetadata }>;
  reappeared: Array<{ photoId: string }>;  // present at original path, currently is_missing
}
```

### 9.2 File Hash

The file hash is a SHA-1 digest of the following metadata properties, concatenated in a deterministic order:

1. File extension (lowercase, e.g. `.arw`)
2. Image width (pixels)
3. Image height (pixels)
4. Date modified (filesystem mtime, ISO string)
5. Color space (string identifier; Stage 1 uses the constant sRGB output space, see §11.1)
6. File size in bytes
7. Orientation/rotation (LibRaw `flip` orientation code, or `0` if not present)

**mtime is included** so an in-place pixel edit that preserves dimensions/size/orientation is still detected as MODIFIED and re-processed (without it, such an edit is invisible). Note the tradeoff: an import/restore that resets mtime without changing content will spuriously mark untouched photos MODIFIED and re-process them. A pure backup *read* (this server as rsync source) does not change mtime, so ordinary cloud backups do not trigger this.

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

1. **Moves:** Update `file_path` for each moved photo. Clear `is_missing` if it was set. **Reconcile shoot membership from the destination path:** if `newFilePath` falls under a known shoot's `folder_path`, set the photo's `shoot_id` to the **most-specific (longest-matching) `folder_path`** shoot (so a file under `NYC/Day1` maps to `Day1`, not the ancestor `NYC`); if it moved out to the library root (or a non-shoot folder), clear `shoot_id`. This keeps DB shoot membership consistent with files the user relocated on disk directly (rather than via the shoots API).
2. **Modifications:** Update `file_hash`, `width`, `height`, `orientation`, `date_updated`, `needs_processing = 1` for each modified photo, plus any other changed metadata columns (GPS, `date_taken`). Clear `is_missing` if it was set.
3. **Additions:** Insert new photo records:
   - `id` = new UUID v4 (`crypto.randomUUID()`)
   - `library_id` = the library being synced
   - `file_path` = relative path from disk scan
   - `file_hash` = computed hash
   - `width`, `height`, `orientation` = from metadata
   - `shoot_id` = the most-specific (longest-matching `folder_path`) shoot containing this file, else NULL
   - `date_added` = current server datetime, normalized to UTC (§4)
   - `date_taken` = UTC-normalized EXIF capture time (§11.1) if available, else NULL
   - `date_updated` = filesystem mtime
   - `latitude`, `longitude` = from EXIF GPS data if available
   - `needs_processing = 1`
   - `is_missing = 0`
   - `is_deleted = 0`
   - `rating = 0`
   - `selected = 0`
4. **Reappearances:** Clear `is_missing = 0` for each reappeared photo. No other change (content and path are unchanged).
5. **Removals:** Set `is_missing = 1` for each removed photo. Do not delete files or records. Count only photos that transition `is_missing` from `0` to `1` toward `photos_removed`; a record already at `is_missing = 1` reappears in the removed list every scan (so delayed move-matching in §9.3 can still pair it), but it is not a new removal and must not be re-counted. This keeps `photos_removed` a per-sync delta consistent with `photos_added`/`photos_moved`/`photos_modified`.

### 9.5 Phase 4: Trigger Processing

After all changes are applied, call `ProcessingService.processUnprocessed()` to begin background thumbnail generation for all photos with `needs_processing = 1` and `is_missing = 0`.

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

### 9.7 Sync Lock

Sync is locked **per library**, so two different libraries can sync concurrently while the same library cannot be synced twice at once. The lock is a **file at the library root**, `<root_path>/.bowerbird-sync.lock`, created with exclusive semantics (`open` with `O_CREAT | O_EXCL`, i.e. Bun/Node `wx` flag) and holding the owning PID and an ISO start timestamp. (It is a hidden non-`.arw` file, so the scanner ignores it regardless.)

- `syncLibrary(id)` acquires that library's lock; if already held it throws `SYNC_IN_PROGRESS` (409).
- `syncAll()` acquires each library's lock independently as it processes it; a library whose lock is already held is skipped (and logged), and the remaining libraries proceed.
- **Stale-lock recovery:** if the lock exists but its PID is no longer alive (crash during a prior sync), it is reclaimed rather than blocking forever.
- The lock is released (file removed) in a `finally` so it is cleared on both success and error.

The in-memory `SyncStatus` (§9.6) is process-local and lost on restart; the per-library lock file is the cross-process source of truth for "is this library syncing".

---

## 10. Processing Pipeline

### 10.1 Overview

Processing converts RAW files into WebP thumbnails at two sizes:

| Size | Constraint | Output path |
|---|---|---|
| small | Longest edge = `SMALL_THUMBNAIL_SIZE` (default 800px), preserve aspect ratio | `<data_path>/thumbnails/small/<photo_uuid>.webp` |
| full | Longest edge = `FULL_THUMBNAIL_SIZE` (default 3840px), preserve aspect ratio | `<data_path>/thumbnails/full/<photo_uuid>.webp` |

Thumbnail sizes and WebP quality come from configuration (§15): `SMALL_THUMBNAIL_SIZE`/`SMALL_THUMBNAIL_QUALITY` and `FULL_THUMBNAIL_SIZE`/`FULL_THUMBNAIL_QUALITY`. Nothing in the pipeline hardcodes these values.

### 10.2 Concurrency Model

Processing uses **Bun worker threads** for parallelism. The concurrency level is configurable (default: 4 workers).

The orchestrator (`processing_service.ts`):
1. Queries for all photos with `needs_processing = 1` and `is_missing = 0` (a photo whose file went missing while processing was still pending must not be run against the absent file; excluding it keeps `needs_processing = 1` so it is generated on the sync that clears `is_missing`, §9.4 step 4).
2. Maintains a work queue.
3. Spawns up to N Bun `Worker` instances, each running `processing_worker.ts`.
4. Sends photo processing jobs to workers via `postMessage`.
5. Workers send completion/error messages back.
6. On a success message, the orchestrator updates the photo record: `needs_processing = 0`, `date_reprocessed = now()`, `processing_error = NULL`. On a failure message, it sets `needs_processing = 0` (so the photo is not silently reprocessed on every subsequent sync), records the worker's `error` string in `processing_error`, leaves `date_reprocessed` unchanged, and logs via `console.error`. Such a photo has no thumbnail on disk (the worker deletes any partial or stale output on failure, §10.3), so the image endpoints 404 (§13.5), but `processing_error` distinguishes a failed photo from an unprocessed one.

### 10.3 Worker Implementation (`processing_worker.ts`)

Each worker:
1. Receives a message with `{ photoId, rawFilePath, smallOutputPath, fullOutputPath, smallSize, fullSize, smallQuality, fullQuality }` (sizes/qualities passed in from config).
2. Sniffs the file header and dispatches to the format's decoder (Stage 1: LibRaw for ARW) → produces an in-memory RGB bitmap buffer, **already rotated to display orientation** (see §10.4, the decoder applies the EXIF flip; the raw buffer carries no EXIF for sharp to auto-rotate from).
3. Passes the bitmap buffer to sharp.
4. Generates small thumbnail: `sharp(buffer, { raw: { width, height, channels: 3 } }).resize({ width: smallSize, height: smallSize, fit: 'inside' }).webp({ quality: smallQuality }).toFile(smallOutputPath)`.
5. Generates full thumbnail: `sharp(buffer, { raw: { width, height, channels: 3 } }).resize({ width: fullSize, height: fullSize, fit: 'inside' }).webp({ quality: fullQuality }).toFile(fullOutputPath)`.
6. On any failure in steps 2-5 (e.g. the full resize/encode throws after the small write already succeeded), delete `smallOutputPath` and `fullOutputPath` if present (best-effort unlink) before reporting, so a failed job leaves no partial thumbnail and a failed reprocess does not leave the prior run's stale thumbnails on disk (both share the UUID-keyed path). This upholds the §10.2 no-thumbnail invariant.
7. Sends back `{ photoId, success: true }` or `{ photoId, success: false, error: string }`.

### 10.4 LibRaw FFI Bindings (`raw_decoder.ts`)

Minimal FFI bindings for LibRaw:

```typescript
// Pseudocode for the FFI interface
const libraw = dlopen('libraw.so', {
  libraw_init: { args: ['i32'], returns: 'ptr' },
  libraw_open_file: { args: ['ptr', 'ptr'], returns: 'i32' },
  libraw_adjust_sizes_info_only: { args: ['ptr'], returns: 'i32' },  // applies flip swap to sizes.iwidth/iheight without decoding (§11.1)
  libraw_unpack: { args: ['ptr'], returns: 'i32' },
  libraw_dcraw_process: { args: ['ptr'], returns: 'i32' },
  libraw_dcraw_make_mem_image: { args: ['ptr', 'ptr'], returns: 'ptr' },
  libraw_dcraw_clear_mem: { args: ['ptr'], returns: 'void' },  // frees the mem-image buffer
  libraw_close: { args: ['ptr'], returns: 'void' },
  libraw_recycle: { args: ['ptr'], returns: 'void' },
});
```

The decoder function:
1. Calls `libraw_init(0)` to create a processor. LibRaw's default `user_flip = -1` already applies the camera's EXIF orientation during `dcraw_process`, so the output RGB buffer is upright (sharp receives no EXIF and cannot rotate on its own). **Do not override `user_flip` to `0`**; that would emit unrotated pixels and misorient landscape/portrait thumbnails. Relying on the default also avoids poking a struct field by offset through FFI, which is version-fragile.
2. Opens the file with `libraw_open_file`.
3. Calls `libraw_unpack` and `libraw_dcraw_process`.
4. Calls `libraw_dcraw_make_mem_image` to get the processed image in memory.
5. Reads the image dimensions and pixel data from the returned struct.
6. Copies the pixels into a JS `Buffer`. The mem-image is heap-allocated by LibRaw and must be freed with `libraw_dcraw_clear_mem` on every path (see step 8), including if the copy in this step throws.
7. Returns `{ width, height, data: Buffer }` (raw RGB pixels).
8. Cleans up in a `finally` so every path (including a decode or copy error) releases resources: `libraw_dcraw_clear_mem` on the mem-image pointer if it was allocated (null-guarded, since an error before step 4 leaves it unset), then `libraw_recycle` and `libraw_close` on the processor.

**Memory-leak audit:** every LibRaw allocation must be paired with its free on all paths, including errors. The three owners are the mem-image (`libraw_dcraw_clear_mem`), the unpacked data (`libraw_recycle`), and the processor (`libraw_close`). The implementing agent should audit the full FFI lifecycle, not just these calls.

This buffer is then passed to sharp as `sharp(data, { raw: { width, height, channels: 3 } })`.

---

## 11. Metadata Extraction (`metadata.ts`)

Used during sync to populate photo records and compute file hashes.

### 11.1 Implementation

Metadata is read via the same per-format dispatch as decoding (§10): sniff the header, route to the format's reader. `sharp`/libvips is **not** used for RAW metadata, as its prebuilt builds have no RAW loader and, when coaxed to open an ARW as a generic TIFF, report the embedded preview's dimensions rather than the full-res sensor values.

For Sony ARW, metadata comes from **LibRaw's header parse**: `libraw_init` then `libraw_open_file` populates `imgdata.sizes` (dimensions and `flip` orientation), `imgdata.other` (capture `timestamp`, parsed GPS), and `imgdata.color` (color space), followed by `libraw_adjust_sizes_info_only` to flip-adjust `sizes.iwidth`/`iheight` (see below), all **without** calling `libraw_unpack`/`libraw_dcraw_process`, so no pixel data is decoded. This is the fast path used per file during scan. `colorSpace` in Stage 1 is the constant `sRGB` output space: LibRaw exposes no stable accessor for the camera's source color-space EXIF tag, and the decode pipeline always outputs sRGB, so this field is fixed (informational + a stable, non-varying hash input) rather than read per file. (`imgdata.color` holds calibration/profile data, not a simple source-space identifier.) The EXIF capture time is naive (the tag carries no zone), so it is normalized to UTC using the EXIF `OffsetTimeOriginal` tag when present, otherwise interpreted as the server's local timezone, and stored as a `Z` UTC ISO string (§4). The reader also `stat`s the file to fill `mtime`/`fileSize`, so the scan-time result carries them all the way to Phase 3 apply (§9.4) without a second `stat` inside the transaction.

`width`/`height` are the **display (upright) dimensions**, i.e. after the orientation flip is applied. At `open_file` time LibRaw's `sizes.iwidth`/`iheight` are still in **sensor orientation** (the 90°/270° swap is applied only by `dcraw_process` or by an explicit `libraw_adjust_sizes_info_only()` call), so the reader must call `libraw_adjust_sizes_info_only()` after `open_file` and then read the now flip-adjusted `iwidth`/`iheight`. This is deliberate: the generated thumbnails are baked upright (§10.4), so storing upright dimensions means `width`/`height` always match the served thumbnail's aspect. `orientation` is retained separately (as the LibRaw flip orientation code) only as informational metadata and as a file-hash input (§9.2); **clients must not apply it to the served thumbnails, which are already upright** (doing so would double-rotate).

```typescript
interface FileMetadata {
  width: number;   // display/upright width (post-flip)
  height: number;  // display/upright height (post-flip)
  colorSpace: string;
  orientation: number;   // LibRaw flip orientation code; informational only (see note above)
  dateTaken: string | null;  // ISO datetime
  latitude: number | null;
  longitude: number | null;
  mtime: string;   // filesystem mtime, ISO datetime; hash input (§9.2) and date_updated source (§9.4)
  fileSize: number;  // bytes; hash input (§9.2)
}

// Dispatches on header; Stage 1 has a single ARW reader.
async function extractMetadata(filePath: string): Promise<FileMetadata> {
  return extractArwMetadata(filePath);  // LibRaw header parse, no unpack
}
```

The processor is opened header-only and closed (`libraw_close`/`libraw_recycle`) immediately after reading the fields; the memory-leak audit note in §10.4 applies here too.

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

Query parameters for listing (`PhotoListQuerySchema`, §5.3):
- `offset` (int, default 0)
- `limit` (int, default 100, max 500)
- `is_missing` (boolean, optional filter)
- `needs_processing` (boolean, optional filter)
- `include_deleted` (boolean, default false)

All boolean query params are parsed with `z.stringbool()`, so `?is_missing=false` correctly parses as `false` (a `z.coerce.boolean()` would turn the string `"false"` into `true`).

**Soft-delete visibility:** every list endpoint in this API (photos, shoots' photos, album photos, and any other collection) excludes soft-deleted rows by default and accepts `include_deleted=true` (the shared `SoftDeleteFilterSchema`, §5.1) to include them. This is uniform, not photos-specific.

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

The served thumbnails are already rotated to display orientation (baked in during processing, §10.4), and the `width`/`height` in photo responses are the matching upright dimensions. Clients render them as-is and must **not** apply the photo's `orientation` value to them.

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
| `SYNC_IN_PROGRESS` | 409 | A sync is already running for this library (per-library lock, §9.7) |
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
- Reappearance: a previously-missing file back at its original path clears `is_missing` (§9.4 step 4)
- Move into a known shoot folder sets `shoot_id`; move out to root clears it (§9.4 step 1)
- mtime change (e.g. in-place edit) marks a file MODIFIED and re-processes it (§9.2)
- Sync lock: a second concurrent sync of the *same* library throws `SYNC_IN_PROGRESS`; two *different* libraries sync concurrently; a stale lock (dead PID) is reclaimed (§9.7)

**Photo deletion:**
- Thumbnails are removed
- RAW file is moved to correct Bin location (shoot vs library)
- DB record is marked `is_deleted = 1`, not removed
- Filename collision in Bin (numeric suffix)

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

```bash
bun run test
```

`bun run test` runs the `test` npm script, which invokes `jest`. Jest is configured with `ts-jest` for TypeScript transformation. (Note: this is Jest, not Bun's built-in `bun test` runner; do not confuse the two.) Test files follow the `*.test.ts` naming convention.

---

## 17. Implementation Order

The following order respects dependency chains — each step depends on the steps above it.

1. **Project scaffolding**: `package.json`, `tsconfig.json`, `jest.config.ts`, directory structure.
2. **Database**: `connection.ts` (opens the DB and sets `PRAGMA foreign_keys = ON`), `migrations.ts` (create all tables including `shoot_banners`/`album_banners`, plus indexes).
3. **Schemas**: All Zod schemas in `src/schemas/`.
4. **Utils**: `hash.ts`, `files.ts`, `paths.ts`.
5. **Repositories**: All repository classes (pure SQLite data access).
6. **Libraries service + API**: CRUD operations for libraries.
7. **RAW decoder / FFI**: `raw_decoder.ts` LibRaw FFI bindings and the per-format dispatch (header sniff). Needed before metadata since ARW metadata is read via LibRaw's header parse.
8. **Metadata extraction**: `metadata.ts` (per-format header parse; LibRaw for ARW).
9. **Photos service + API**: CRUD, listing, filtering.
10. **Processing service**: Worker-based thumbnail generation (reuses the RAW decoder).
11. **Sync service**: Full sync algorithm with move detection, reappearance handling, shoot-membership reconciliation, and the per-library sync lock (§9.7). Depends on the processing service (§8.4), which it calls to trigger thumbnail generation (§9.5).
12. **Shoots service + API**: CRUD, photo assignment with file moves.
13. **Albums service + API**: CRUD, photo assignment.
14. **Image streaming API**: Static-path file streaming endpoints.
15. **Deletion flow**: Soft-delete with Bin and thumbnail cleanup.
16. **Integration wiring**: `index.ts` — dependency injection, Hono app setup, server start.
