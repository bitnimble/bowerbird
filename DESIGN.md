| `MATCH_EMBEDDED_JPEG` | `true` | Give renders the camera's own colour and lens correction, fitted per photo against the embedded JPEG; ~+2.4s on a 61MP frame for SDR (§10.8), and again for HDR (§10.8.1) || `POST` | `/api/photos/:id/renditions/:rendition` | Build one rendition on demand: `full` or `max`; `?force=true` drops the cached copy first (§10.1) |# Bowerbird — Design Document

## 1. Overview

Bowerbird is a high-performance RAW photo management and cataloguing backend designed to run on a server or NAS where photos are stored on local spinning disks. It exposes a REST API that a thin client (desktop, mobile, or web) can consume over the network. The web client that ships in this repo is one such consumer; it is a separate app with its own build and dev server, and is described in §18.

**Stage 1 scope:**

- Library management (create, sync)
- Photo listing, filtering, and metadata
- Shoots and albums
- Thumbnail generation (small + full-size AVIF)
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
| Image processing | `native/rawshim`, a Rust library over libvips + LibRaw, called via `bun:ffi` (§10.4) |
| RAW decoding | Per-format dispatch (header sniff → fastest reader); Sony ARW via LibRaw `bun:ffi` |
| Metadata extraction | LibRaw header parse (no pixel decode), per-format dispatch |
| Testing | Bun's built-in test runner (`bun test`, run via `bun run test`) |
| Logging | `console.log` / `console.info` / `console.error` |
| Package manager | `bun install` (no npm/pnpm/yarn) |

### System Dependencies

- **LibRaw**, must be installed on the host system. The Bun process loads `libraw.so` / `libraw.dylib` via FFI. On Debian/Ubuntu: `apt install libraw-dev`. On macOS: `brew install libraw`.
- **libvips**, resize, blur and the AVIF/JPEG encoders. Linked by `native/rawshim` rather than dlopen'd, so it is needed to build as well as to run: `apt install libvips-dev` / `brew install vips`. This is the library sharp used to bundle; see §10.4 for why it moved out of node_modules.
- **libheif's aomenc plugin**, `apt install libheif-plugin-aomenc`. Easy to miss and not optional: Debian ships libheif's codecs as separate plugin packages and libvips pulls in only the *decoders*, so an image without this reads AVIF perfectly and cannot write a single one - which is every rendition this app produces. `bun native/smoke_avif.ts` proves an install has an encoder rather than only a decoder.
- **ffmpeg**, applies the PQ transfer and encodes the HDR video (§10.7). Needs libzimg for the `zscale` filter and **libsvtav1** for the video; a build missing either cannot produce them. SVT-AV1 implementing AV1 Profile 0 only is the point rather than a limitation: 4:4:4 is Profile 1, which no hardware decoder takes, and the video exists to reach a hardware HDR path.
- **libavif-bin**, `avifenc` encodes the HDR still. ffmpeg's own avif muxer writes no `colr` box, so it cannot tag one as HDR at all.

### NPM Dependencies

| Package | Purpose |
|---|---|
| `hono` | Web server and routing |
| `zod` | Schema validation (v4) |

There is no image-processing package. Everything that touches pixels is in `native/rawshim` (§10.4), which links libvips directly.

Testing uses Bun's built-in `bun test` runner, so there is no test-framework dependency.

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
│   │       └── image_api.ts        # Static-path image streaming endpoints (integration-tested; needs Bun.file)
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
│   │   │   ├── sync_service.ts     # Library sync algorithm (integration-tested; needs bun:sqlite + LibRaw)
│   │   │   └── tests/
│   │   │       ├── sync_algorithm.test.ts  # pure diff / move-detection
│   │   │       └── sync_lock.test.ts       # lock-file module
│   │   └── processing/
│   │       ├── processing_service.ts  # Thumbnail generation orchestrator
│   │       ├── processing_worker.ts   # Bun worker thread for image processing
│   │       ├── raw_decoder.ts         # LibRaw FFI bindings
│   │       ├── metadata.ts            # Per-format metadata extraction (LibRaw header parse for ARW)
│   │       └── tests/
│   │           └── processing_service.test.ts   # (raw_decoder/metadata: integration-tested via LibRaw)
│   └── utils/
│       ├── hash.ts                 # File hash computation
│       ├── files.ts                # File system helpers (recursive listing, etc.)
│       └── paths.ts                # Path computation helpers (thumbnail paths, bin paths)
├── test/
│   ├── integration/               # bun:test suites needing real bun:sqlite + LibRaw (run in-container)
│   └── fixtures/                  # a real Sony ARW for decode/metadata tests
├── web/                          # the web client: separate app, own build (§18)
│   ├── e2e/                      # Playwright specs + throwaway library fixture
│   └── src/
│       ├── api/                  # typed client over the REST API
│       ├── app/                  # shell, routing, per-store contexts, styles
│       └── features/             # one folder per domain: store + presenter + components
├── DESIGN.md
├── package.json
├── tsconfig.json
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

All `datetime` columns are stored as TEXT in ISO 8601 format with a `Z` suffix (e.g. `2024-06-15T04:30:00.000Z`), so lexicographic (byte) comparison equals chronological order and the `date_added`/`date_taken` ordering indexes (§4.2) sort correctly. `date_added` is a true instant, normalized to UTC from the server's offset (which shifts across DST). `date_taken` is not an instant: EXIF records a naive wall clock, so §11.1 stores that wall clock re-encoded as UTC and the client formats it back in UTC (`captureDateTime`), leaving a capture time reading as the camera wrote it on any machine in any zone.

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
- `data_path`, absolute path to the data directory for generated files. If NULL, defaults to `<root_path>/.bowerbird/`.
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
CREATE INDEX idx_photos_file_path ON photos(library_id, file_path);
CREATE INDEX idx_photos_needs_processing ON photos(needs_processing) WHERE needs_processing = 1;
CREATE INDEX idx_photos_is_missing ON photos(library_id, is_missing) WHERE is_missing = 1;
CREATE INDEX idx_photos_is_deleted ON photos(library_id, is_deleted) WHERE is_deleted = 1;
```

- The `_added`/`_taken` composite indexes serve the paginated library and shoot list orderings (§5.1, §8.2 `listByLibrary`/`listByShoot`): each leads with the equality-filtered column (`library_id`/`shoot_id`) followed by the sort column, so `added_*` orderings are served without a filesort. For `taken_*`, the leading `date_taken IS NULL` sort expression cannot be indexed directly, so the B-tree serves the `date_taken` tiebreak but the NULL-last grouping still requires evaluating the expression; NULL `date_taken` rows are rare, so the residual cost is small. Album listings (`listByAlbum`, §8.2) are not covered: albums have no `library_id` (§4.4) so they span arbitrary photos, and `album_photos` is keyed only on `(album_id, photo_id)` (§4.5), so neither the date composites nor the album PK anchor an album-scoped ordering; these listings therefore incur a filesort, accepted as albums are typically small.

- `file_path` — relative to the library `root_path`. Uses forward slashes as separator regardless of OS.
- `is_missing` — set to 1 when the file is not found on disk during sync.
- `is_deleted` — set to 1 when the user requests deletion (file moved to Bin).
- `triage`, the cull verdict: `picked`, `rejected`, or NULL for untriaged. Three states rather than a boolean, because "not yet judged" is the set a photographer filters on most and a two-state flag cannot tell it apart from "judged and rejected". This replaced the old `selected` column: the migration turns every `selected = 1` row into `picked` and then drops the column, so the two can never disagree.

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

- `folder_path` is the **full** path from the library root to this shoot's folder (forward slashes), e.g. `Weddings/2024/Smith`. It is *not* parent-relative: storing the full path lets sync reconciliation (§9.4) and create-adoption (§8.5) test membership with a `file_path` prefix check, and lets the most-specific (longest matching) shoot win for nested folders. On create it is computed as `parent ? parent.folder_path + '/' + name : name`, and it is **immutable thereafter**: `name` seeds the folder once and is a label from then on, so renaming a shoot never moves a file (§8.5).
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
  photo_ids: z.array(UuidSchema).min(1).max(1000),  // max bounds per-request file moves and keeps IN(...) under SQLite's variable limit
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
  triage: TriageSchema,
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

**Everything under it is disposable, and nothing under it is an original.** Removing a library removes the whole tree (§10.6), and a user is free to delete `.bowerbird/` by hand to reclaim the space; both must cost only renders. That is why the Bin lives at the library root rather than in here (§12.3), why `POST /api/libraries` refuses a `root_path` inside an existing library's data directory (and a `data_path` that would contain an existing root), and why the removal itself refuses to run while any RAW is still inside.

### Structure

```
<data_path>/
├── renditions/         # Derived copies of a photo (§10.1)
│   ├── grid/           # 800px AVIF, the library grid; always SDR
│   ├── full/           # 3840px AVIF, the photo view
│   ├── full-hdr/       # the same, PQ
│   ├── full-hdr-video/ # one-frame AV1 twin, for Firefox (§10.7)
│   ├── max/            # native-resolution AVIF (§10.5)
│   ├── max-hdr/
│   └── max-hdr-video/
│       └── <photo_uuid>.avif   # every rendition is named by photo id
└── hdr/                # the HDR check page's renditions (§10.7)
```

### Path Resolution

```typescript
function getDataPath(library: Library): string {
  return library.data_path ?? path.join(library.root_path, '.bowerbird');
}

// Originals, so outside the data directory (§12.3).
function getBinPath(library: Library): string {
  return path.join(library.root_path, 'Bin');
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
| `create(request)` | Validates the root path exists on disk and overlaps no existing library's data directory in either direction (§6), creates the data directory, inserts a library record, returns the library. |
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
| `update(photoId, updates)` | Updates mutable fields: `rating`, `triage`, `notes`. |
| `delete(photoIds)` | Soft-deletes photos: moves RAW files to Bin, sets `is_deleted = 1`. Thumbnails are kept so the Bin stays browsable. See §12. |
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
| `update(shootId, updates)` | Updates mutable fields: `name`, `description`, `ordering`. A **name change is metadata only**: the name is a label, so nothing moves on disk and no `folder_path` or `file_path` is rewritten. A rename to a name already used by any shoot in the same library returns `CONFLICT` (names are unique library-wide, §4.3). Setting `banner_photo_id` upserts the `shoot_banners` row; clearing it (null) deletes that row; it is not a column on `shoots` (§4.6). |

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
  reappeared: string[];  // photo ids present at their original path, currently is_missing
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
   - `triage = NULL`
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

### 9.8 Sync Triggers: Manual, Scoped Watcher, Daily Backstop

`syncLibrary` runs in three ways:

1. **Manual**, `POST /api/libraries/:id/sync`. A full scan (whole tree).
2. **Scoped (watcher)**, the `LibraryWatcher` accumulates the changed relative paths in each debounce window and calls `syncLibrary(id, scopePaths)`. A scoped sync **does not walk the tree**: it `readdir`s only the changed paths' *parent directories* and reconciles their current files against the DB rows at the changed + discovered paths, plus every already-missing row (the move-source pool). This is cheap and its cost scales with the number of changed directories, not library size.
   - **Why directory-scoped, not file-scoped:** Bun's recursive `fs.watch` delivers only **one** event for a rename (the old name), so a file-scoped sync could never see the move target. Reading the changed path's directory surfaces the target as a sibling, so an intra-directory rename still resolves to a move (§9.3). A cross-directory move (whose target event was dropped) marks the old path missing, then reunites with the original row via the missing pool on a later scoped sync of the target directory, or on the periodic full sync.
   - A debounce window with more than 256 distinct changed paths (bulk import) falls back to a full sync.
3. **Daily full reconcile**, `DailySync` runs `syncAll()` once a day at `SYNC_FULL_AT` (local `HH:MM`, default `03:00`, `""` disables), overlap-guarded and re-scheduled each day so it holds its wall-clock time across DST. This is the correctness **backstop** for anything the scoped, event-driven watcher missed: `fs.watch` events Bun coalesced/dropped, cross-directory moves whose target event never arrived, and edits made while the server was down. It's overnight by default because a full scan holds the library mutex (§9.9) for its whole duration.

### 9.9 Library Mutex

Sync snapshots the DB, then scans **asynchronously**, then applies. A user mutation that moves files (shoot add/remove/rename, photo delete) landing mid-scan would make that snapshot stale. `libraryMutex` (one process-global instance) serializes those mutations against sync **per library**: whoever arrives second queues rather than failing, since these are interactive requests.

- `syncLibrary` takes the sync **lock file first, then the mutex**. Lock-first keeps sync-vs-sync fail-fast (`SYNC_IN_PROGRESS`, 409, §9.7); the mutex only makes *mutations* wait. Mutations never take the lock file, so there is no cycle to deadlock on.
- The mutex is acquired at exactly one level per operation (e.g. in `rename`, not its caller `update`), since it is not re-entrant.
- This closes the mutation-vs-scan race class at the source, rather than guarding each symptom. The per-write guards it supersedes are kept anyway (path-guarded `setMissing`, the `(dev, ino)` collapse, the re-checks before FK writes) because they also cover the cross-process case the in-memory mutex cannot.

**Why the full scan stats every file.** Skipping the stat for files in directories whose mtime is unchanged was tried and removed: the stat is the *only* cost it saves (the mtime+size quick-check already skips the expensive decode for unchanged files), and skipping it also skips the `(dev, ino)` collapse that `moveIntoDir`'s non-atomic `link()`-then-`unlink()` window depends on. A cross-directory move bumps only the destination directory's mtime, so the source stays "unchanged" and is pruned; the destination is then inserted as a new photo while the source row survives, leaving a duplicate. Making it safe means restoring the stat, which leaves no saving.

---

## 10. Processing Pipeline

### 10.1 Overview

Processing converts RAW files into **renditions**: derived copies of one photo, each existing for a stated reason.

| Rendition | Constraint | Why it exists | Output path |
|---|---|---|---|
| `grid` | Longest edge = `SMALL_THUMBNAIL_SIZE` (default 800px) | The library grid. Always SDR | `<data_path>/renditions/grid/<photo_uuid>.avif` |
| `full` | Longest edge = `FULL_THUMBNAIL_SIZE` (default 3840px) | The photo view | `<data_path>/renditions/full[-hdr]/<photo_uuid>.avif` |
| `max` | Native resolution, never fitted | Pixel-peeping (§10.5) | `<data_path>/renditions/max[-hdr]/<photo_uuid>.avif` |

Sizes and quality come from configuration (§15). Nothing in the pipeline hardcodes them.

These were three trees under three names - `thumbnails/`, `previews/` and `lossless/` - with the vocabulary to match, which read backwards in both directions: `thumbnails/full` was a 3840px image the viewer showed *by default*, and `previews/` was the one thing it did *not*. They are the same idea at different sizes and dynamic ranges, so building any of them is one job type over a list of targets rather than three that differed mostly in what they called their output path.

**The camera's embedded JPEG is deliberately not a rendition.** It is the original bytes, served straight out of the RAW like the RAW itself (`GET /image/:id/embedded.jpg`), never resized into HDR or transcoded into AVIF and cached as a copy of its own. The one exception is the grid tile, which cannot be a 9504px preview and so is re-encoded to 800px whatever its source.

**Dynamic range is in the directory, not the filename**, because the file is the cache: a copy built while the library was SDR would otherwise be handed back forever, so turning HDR on and asking for the full-size view returned the old sRGB AVIF and nothing ever rebuilt it. HDR is stored *beside* the SDR copy rather than replacing it, so turning the setting off does not throw away work that turning it back on would redo. The video twin gets its own `-hdr-video` directory: the orphan sweep keys on the one extension a directory is supposed to hold, and two in one directory would have it delete the video as a superseded format on every pass (§10.6).

**Everything is AVIF**, thumbnails, previews, the full-resolution export (§10.5) and the HDR renditions (§10.7). It decodes natively in every current browser with no polyfill, it is the only format here that carries HDR to Chrome and Safari alike, and at matched quality it is smaller than the WebP it replaced: the full-size rendition is 375 kB at q60 against 1019 kB for WebP q90. Nothing migrates existing files; the orphan sweep keys on the extension a directory is supposed to hold, so stranded WebP is collected on the next pass (§10.6).

Two encoder settings were measured rather than inherited, and both defaults were wrong:

- **`effort` buys essentially nothing, and costs everything.** libvips defaults to 4. Measured on a 3840px frame at Q88, with `Q` fixed the file size does not move - effort searches harder for the same quantiser, so what it can buy is quality, and it barely does:

  | effort | ms | bytes | PSNR |
  |---|---|---|---|
  | 0 | 509 | 5.666MB | 40.13 |
  | 1 | 545 | 5.685MB | 40.15 |
  | 2 | 951 | 5.615MB | 40.16 |
  | 4 | 5318 | 5.646MB | 40.59 |
  | 9 | 132601 | 5.713MB | - |

  Effort 4 is 10x the time for +0.46dB at the same size; effort 9 is 260x the time for a file 0.8% *larger*. On the 800px grid tile it is worse still, 15ms to 1626ms for +0.33dB and a bigger file. `THUMBNAIL_EFFORT` is 0.

  This previously claimed effort 4 was 13.6s against 0.6s "for a file only ~15% smaller". The time ratio was roughly right; the 15% was not - the file is not smaller at all. Worth correcting because it framed effort as a size/speed trade with a real size on one side, when at fixed `Q` there is nothing on that side.
- **AVIF quality is not WebP's scale.** Carrying the old 90 across would have produced 2551 kB thumbnails, 2.5x larger than what they replace. q80 is where shadow detail stops visibly degrading on real frames; q60 and q70 lose it. Quality is nearly free once effort is 0 (596ms at q60 against 898ms at q85), so this is chosen on appearance, not cost.

**The grid tile is always the camera's embedded JPEG**, whatever the library is set to. It is a small SDR thumbnail, so the only thing worth optimising is how fast it appears, and the embedded preview is the fastest source there is: ~125ms against ~1.5s to demosaic (§10.3). A body that embeds no JPEG falls back to a render inside the worker, so this is "the fastest source available" rather than "always the JPEG".

**`preview_source` governs the photo viewer, not the grid**: `embedded` serves the camera's JPEG in the viewer as itself and builds no rendition at all, `render` builds the full-size view by demosaicing. Alongside `preview_hdr` and `preview_hdr_video` it lives on the `libraries` row, not the server: one catalogue may be scanned JPEGs where the camera's rendering is the point and another RAWs worth demosaicing. `embedded` is the default. Changing any of them is deliberately **not retroactive**; it decides what gets built next, and rebuilding a catalogue is an explicit action.

**Only `full` and `max` are ever HDR.** The grid stays SDR whatever the library says: a wall of HDR tiles is punishing to look at, and it would put a LibRaw linear decode and two encoder passes on every photo in an import rather than one AVIF encode.

**An import builds `grid` always, and `full` only when the library renders.** A library serving the camera's JPEG has nothing to build for the photo view - it hands over the RAW's own bytes - so it pays one small encode per photo and no demosaic at all. `max` is never built at import: it is native resolution and tens of megabytes, so it happens on request and only once.

With `preview_hdr_video` also set, the worker writes the one-frame AV1 twin off the same decode. Firefox applies a PQ transfer to nothing but video and renders an HDR still dark, so that file is the only rendition reaching an HDR display there, and the client serves it in place of the AVIF on Firefox alone (§10.7). It is a separate opt-in rather than implied by HDR because it is a second encode per photo - roughly another second - for a file no other browser ever reads. `renditions[x].video` carries that file's path and weight rather than a boolean, so the panel describing what is on screen names the MP4 the viewer is actually watching instead of the AVIF beside it; its size has to come from the server because a media element leaves no resource-timing entry to read it off the way a still does.

**The viewer sees a three-step quality ladder**: the camera's JPEG, `full`, and `max`. They are the same picture at different costs, so it treats them as interchangeable and `preview_rendition_mode` (§13.6) decides which one a photo opens at: pinned to one of the three, or reopened at whatever was chosen last, either across the catalogue (`remember`) or for that photo (`remember_per_photo`, stored on `photos.preview_rendition` and carried on the summary so the viewer can act on it before it has fetched anything, §18.5). Server-side rather than in the browser because the same catalogue is opened from a phone, a laptop and whatever is plugged into the good monitor, and "where I left off" is worth nothing if it only holds on one of them. All three stay on offer whichever is showing, the step back down to the camera's JPEG included: comparing a render against it is a reason to switch.

Comparing two of them is the reason to have three, so `I` and `O` switch straight to the camera's JPEG and to the render, and the stage holds the frame it is already showing until the next one has decoded rather than dropping to the background between them - a flash on a swap between two files that are both already cached says "loading" where nothing was loaded. The same decode-then-swap covers a genuinely slow one; only a photo *change* clears the stage, because there the previous frame is the wrong picture.

The incoming frame is **mounted as a second, invisible element over the current one** and that element is then kept rather than replaced. Decoding into a detached `new Image()` first is not enough: the browser decodes for the size an element is drawn at, so the visible element decoded the file a second time when it took the src, and a 3840px AVIF flashed on the way in while the 1080px camera JPEG - the same swap in the other direction - did not. Firefox's video twin swaps the same way, promoted on `loadeddata` since a `<video>` has no `decode()`; it is a rendition comparison like any other and would otherwise be the one path that still flashes.

Against that, the file being the cache means a change to the pipeline is invisible on every photo already looked at. **"Disable cache when changing preview"** (`?force=true`) removes the stored copy and its video twin before building, so choosing the same rendition again renders it afresh. It is a checkbox in the Actions menu rather than a fourth entry in the ladder because it modifies the choice rather than being one, and it is off by default and per-session: it is for working on the renderer, not for looking at photographs. The camera's JPEG ignores it, having no build to force past.

`PhotoDetail.renditions` answers the client's questions from **disk rather than from a column** - what each one's path is, whether it is built, whether it is HDR, whether a video twin exists - because settings are not retroactive and a library switched to HDR after an import still has SDR files. `default_rendition` is what the viewer opens at when nothing has been chosen, so the client never has to re-derive it from what happened to be built.

**A missing grid tile is rebuilt when the photo is opened.** The queue only visits photos flagged for processing, so a tile deleted under a catalogued photo - a wiped cache, a sweep that went too far - is a hole in the grid that nothing ever fills; reprocessing the photo would fill it at the cost of every other rendition. Opening the photo is when someone is looking, so `GET /api/photos/:id` stats the tile and, if it is gone, renders that one rendition in the background from the source the import used (the photo's `rendition_source`, or the library's). A side effect on a read, deliberately: the file is the cache, and repairing a cache on the read that noticed it is empty is what a cache does. One repair per photo is in flight at a time.

**Reprocessing clears every rendition it does not itself rewrite.** A photo is only reprocessed because its pixels changed, so the copies beside it are of the old file and nothing else would ever notice - the max-resolution export in particular would be served forever. The ones the job is about to write are exempt, or the sweep would delete what it just made.

Every writer on this path fails on a missing directory rather than creating one, and ffmpeg fails the whole job rather than the one output, so the worker creates the directory for each of its job's outputs before it runs. At the call site instead, each new rendition is a directory somebody has to remember, and the one that was forgotten took the still down with it.

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
1. Receives a message naming the RAW, the targets it has to write, and the sizes and qualities for each (passed in from config).
2. Decodes the RAW once, through `native/rawshim` (§10.4) → an RGB bitmap **already rotated to display orientation** (the decoder applies the EXIF flip; the raw buffer carries no EXIF for a downstream library to auto-rotate from).
3. Fits the camera-match profile once, if the library asked for it (§10.8).
4. Builds one graded base at the largest SDR size any target needs, and writes each target's AVIF from it.
5. On any failure, deletes every output the job names, if present (best-effort unlink), before reporting - so a failed job leaves no partial rendition and a failed reprocess does not leave the prior run's stale ones on disk (both share the UUID-keyed path). This upholds the §10.2 no-thumbnail invariant.
6. Sends back `{ photoId, success: true, source }` or `{ photoId, success: false, error: string }`.

**The decode never enters the JS heap.** Steps 2-4 pass a handle - an opaque pointer to a bitmap Rust owns - so a 60MP frame is decoded, fitted, graded and encoded without its pixels crossing the FFI boundary. The worker holds every handle it opens in one list and frees them in a `finally`, because nothing on the JS side collects them: a 60MP decode and its graded copy are ~380MB between them. The two places that genuinely need samples in JS - the scene-linear decode ffmpeg encodes (§10.7) and the HDR fit that reads the same pixels - copy explicitly, through `pixels()`.

**One grade, not one per rendition.** A `render` import builds an 800px tile and a 3840px view, and transforming each separately did the ~9.8M-pixel warp and grade twice. The base is built at the largest SDR size the job asks for and every smaller rendition is a resize of it, which is legitimate because the order does not change the result: the distortion model is in radii normalised to the half-diagonal and the colour transform is a per-pixel lookup, so neither depends on resolution. Going 3840→800 is also a cheaper resize than 9504→800. The integration suite checks the reasoning rather than trusting it, comparing a grade-then-resize against a resize-then-grade.

**An import runs in two passes, tiles before renditions.** Both cover the same photos, so this is purely an ordering choice, and it is the reason the stages are split at all: measured over 23 real ARWs, a tile is 124ms where a rendition is 1518ms, and at concurrency 8 that is 30 img/s against 3. On a 2000-frame shoot the whole grid is browsable in about a minute rather than after the eleven minutes the renders take.

`needs_processing` is one boolean and stays one: it clears only when *every* stage of a photo has landed. Clearing it after the tile would leave nothing tracking that the renditions are outstanding, so a crash between the passes would lose them silently, and correcting that needs a second column. Paying for it instead: a crash mid-import redoes the tile as well, at 124ms. The flag's other two jobs - the pending queue and the retry guarantee - are unchanged by the split, and nothing user-facing reads it (`countPendingProcessing` is sync's own loop deciding whether work remains).

A failure sweeps *every* derivative of that photo, not just the stage that failed. A photo is only being reprocessed because its pixels changed, so a rendition the failed run never reached is of the old file and would otherwise be served forever with nothing to notice.

**Thumbnail source.** The job names where the pixels come from:

| Source | What it does | Trade-off |
|---|---|---|
| `render` | Demosaics the RAW (steps 2-3 above) | Full sensor resolution, slow |
| `embedded` | Lifts the camera's own JPEG out of the file (`libraw_unpack_thumb` + `libraw_dcraw_make_mem_thumb`) | Much faster, the maker's colour treatment, but only as large as the body embedded, which ranges from 640×480 to the full sensor |

The embedded JPEG carries its own EXIF orientation, so the decode applies it (`autorot`); a render is already baked upright by the decoder (§11.1) and must not be rotated again. A file with no JPEG preview (some bodies embed a bitmap, or nothing) is a property of the file rather than an error, so an `embedded` request falls back to a render. The result reports what was **actually** used and `photos.rendition_source` records it, so the client can state which pixels are on screen instead of leaving the user to guess.

### 10.4 The native layer (`native/rawshim`, `raw_decoder.ts`)

Everything that touches pixels is in one Rust library, called from TypeScript over `bun:ffi`. It links LibRaw for the decode and libvips - the library sharp wrapped - for resize, blur and the AVIF/JPEG encoders. TypeScript orchestrates: it passes a path and a job, and gets back a handle, a profile or a written file.

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
1. Calls `libraw_init(0)` to create a processor. LibRaw's default `user_flip = -1` already applies the camera's EXIF orientation during `dcraw_process`, so the output RGB buffer is upright (a raw bitmap carries no EXIF, so nothing downstream can rotate on its own). **Do not override `user_flip` to `0`**; that would emit unrotated pixels and misorient landscape/portrait thumbnails. Relying on the default also avoids poking a struct field by offset through FFI, which is version-fragile.
2. Opens the file with `libraw_open_file`.
3. Calls `libraw_unpack` and `libraw_dcraw_process`.
4. Calls `libraw_dcraw_make_mem_image` to get the processed image in memory.
5. Reads the image dimensions and pixel data from the returned struct.
6. Copies the pixels into a JS `Buffer`. The mem-image is heap-allocated by LibRaw and must be freed with `libraw_dcraw_clear_mem` on every path (see step 8), including if the copy in this step throws.
7. Returns `{ width, height, data: Buffer }` (raw RGB pixels).
8. Cleans up in a `finally` so every path (including a decode or copy error) releases resources: `libraw_dcraw_clear_mem` on the mem-image pointer if it was allocated (null-guarded, since an error before step 4 leaves it unset), then `libraw_recycle` and `libraw_close` on the processor.

**Memory-leak audit:** every LibRaw allocation must be paired with its free on all paths, including errors. The three owners are the mem-image (`libraw_dcraw_clear_mem`), the unpacked data (`libraw_recycle`), and the processor (`libraw_close`). The implementing agent should audit the full FFI lifecycle, not just these calls.

**One copy, not two.** The frame is copied straight out of LibRaw's buffer with the masked-border crop applied on the way. It used to be copied whole and then have the crop copied out of that, which on a 60MP frame is ~190MB moved twice, about 250ms per decode for nothing.

**PPG rather than LibRaw's default AHD** (`user_qual = 2`), overridable with `BOWERBIRD_DEMOSAIC`. Whole-decode wall time, and the mean difference each algorithm shows against AHD once resized to a 3840px rendition:

| `user_qual` | | 24MP | 61MP | vs AHD at 3840 |
|---|---|---|---|---|
| 2 | **PPG** | **511ms** | **2202ms** | 0.85% / ΔE 2.6 |
| 3 | AHD | 623ms | 2463ms | - |
| 0 | linear | 664ms | 2631ms | 1.00% / ΔE 3.1 |
| 11 | DHT | 904ms | 3221ms | 1.04% / ΔE 3.3 |
| 4 | DCB | 2327ms | 7148ms | 0.86% / ΔE 2.5 |
| 1 | VNG | 2377ms | 7067ms | 0.82% / ΔE 2.4 |
| 12 | AAHD | 4783ms | 13340ms | 0.87% / ΔE 2.6 |

PPG is both the cheapest and not the worst, so it stays. Two things the table is *not*: a quality ranking, since distance from AHD measures disagreement rather than correctness and there is no ground truth here without a synthetic mosaic; and a reason to care much, since a 61MP frame decodes at half size for any rendition under 4864px (below) and then skips demosaic altogether.

Note also that quality 0 (linear) is *slower* than AHD, and worse - strictly dominated, which is not what the name suggests.

**A correction worth keeping.** This previously claimed the PPG/AHD difference was 0.18%, one 8-bit level in four. Re-measured it is ~0.8% on both a 24MP and a 61MP frame - four times that - so the original figure was wrong rather than sensor-specific. The likely cause is instructive: measured through the app's normal path on a 61MP frame, `half_size` would have been active, and a half-size decode bypasses demosaic entirely, so the two algorithms were being compared while neither was running. A demosaic benchmark has to force a full decode.

**Half-size decoding, when the caller can afford it.** `decodeRaw` takes an `atLeastLongEdge`: the longest edge the caller is going to need. When halving the frame still clears that, LibRaw's `half_size` runs instead, collapsing each Bayer quad into one output pixel rather than interpolating. On a 61MP frame that is 1592ms of decode down to 956ms - the demosaic 594ms to 128ms and the copy 183ms to 46ms, while the unpack is raw decompression and does not move - and it makes every downstream resize a quarter of the work. End to end an import of that frame goes from 3414ms to 2580ms.

It is a genuine quality trade, not a free one: dark edges pick up a faint checkerboard, visible when pixel-peeping at 100%. Hence the gate. A 61MP sensor halves to 4864 and still clears the 3840 a full rendition wants; a 24MP one halves to about 3012 and does not, so it decodes whole. A native-resolution rendition passes 0, which means the whole frame rather than "no preference". The 4k rendition is a triage view and the artefacts do not survive being looked at normally; the max rendition exists to be pixel-peeped and never takes this path.

**`half_size` has no setter in the C API**, and that is why the decode lives in Rust (`native/rawshim`) rather than in TypeScript. The FFI could only reach the field by locating `libraw_output_params_t` at runtime and writing at an offset; that worked, and was cross-checked from two directions, but its neighbours are `four_color_rgb` and `use_auto_wb`, either of which silently changes the picture when written to by mistake while leaving the dimensions perfectly plausible. bindgen resolves the field from the same headers the runtime library was built from, so the offset is the compiler's problem and stops being ours.

The wrapper owns the whole decode, because it is one job: as-shot white balance, the PPG demosaic, the half-size decision and the masked-border crop. **The decode itself buys no speed** - measured against the TypeScript path it is 0.99x on a 61MP frame and 1.07x on a 24MP one, pixel-identical, because the time is inside LibRaw's unpack and demosaic either way. That was a correctness change. What it also did was put the boundary in the right place for everything else to follow.

#### Handles, not pixels

The FFI passes an opaque pointer to a bitmap Rust owns. Each operation - fit, grade, resize, encode - takes a handle and, where it makes an image, returns another.

Getting this wrong the first time is worth recording, because the wrong version looked reasonable. Each call took a pixel pointer and returned a buffer, so `bb_fit` copied the render out of JS into a `Vec`, having already copied it *into* JS at the end of the decode: three ~45MB moves of pixels no JavaScript ever read. The same mistake shaped the libvips calls, one function per operation, each materialising its result for the next to copy back in - which threw away the lazy pipeline that is the whole reason libvips is fast, and is why the first native version *lost* to sharp on a 61MP fit, 915ms against 423ms. Chaining the operations into one graph and borrowing rather than copying closed most of it; moving the boundary closed the rest.

The rule that falls out: **pixels cross only on their way into an HTTP response.** Nothing else. `GET .../embedded` hands the camera's preview to a `Response` unchanged, and `GET .../download` hands over a transcoded JPEG; both are bytes bound for a socket. Every other path - the decode, the fit, the grade, the warp, all four encoders - begins and ends on the Rust side.

Two doors exist in the other direction and neither has a production caller: `imageFromRgb` and `bb_fit_against`, for the test that injects a known distortion and needs a target it constructed. `decodeRaw` is the same, kept for tests that compare a decode against what was written.

Getting there took removing three round trips that each looked reasonable. The embedded preview was extracted into a `Buffer` - 5-14MB, since a 61MP body embeds a full-resolution one - and handed straight back to be decoded. The fit took that preview *and* the whole RAW, 60-120MB, so TypeScript could find one maker-note tag in the first few kilobytes. And a rendition being transcoded was read off disk into JavaScript only to be passed back down; `decodeFile` takes the path instead.

Handles are freed explicitly, in a `finally`. Nothing on the JS side collects them, and the numbers are not small: a 60MP decode plus its graded copy is ~380MB.

#### What it bought

An import job - decode, fit, grade, and write a 3840px view plus an 800px tile - against the sharp pipeline it replaced:

| Frame | sharp | native | |
|---|---|---|---|
| 24MP, no halving | 3478ms | 1560ms | 2.2x |
| 61MP, halved to 15MP | 2701ms | 2135ms | 1.3x |
| 61MP, halved to 15MP | 3425ms | 2620ms | 1.3x |

By stage on the 24MP frame, which is the clearest because nothing is halved: decode 499→490 (identical code), fit 844→466, grade 1542→307, 3840px AVIF 563→280, 800px tile 30→21.

The grade is where the boundary shows: it was a JS loop over 72MB with a sharp resize round-trip on either side, and is now one pass in Rust. The encoders are roughly 2x, which is not our work but the system libvips 8.15.1 build against sharp's bundled one. **The fit is not where it shows** - it was already in Rust before the handles, at 451ms, so removing its copy is inside the noise. Worth stating plainly, because "we removed three 45MB copies" invites the assumption that the copies were the cost; on the fit they were not.

The thumbnail and header paths (§11.1) still use LibRaw's C API through `bun:ffi` directly: they touch no struct that lacks an accessor, so they have nothing to gain from crossing into Rust.

`bun run build:native` builds it, at cargo's stock release profile; the Docker build does so in its own stage and copies only the `.so` forward, keeping rustc, cargo and libclang out of the shipped image.

**`opt-level` and LTO are not levers here.** Measured end to end on the rendition job, `opt-level = 2`, `opt-level = 3` and `opt-level = 3` with fat LTO and one codegen unit are indistinguishable - every stage inside noise across two frames. Structural rather than incidental: the expensive work is inside libvips and LibRaw, both precompiled shared libraries no profile of ours reaches and LTO cannot cross into, and this crate's own hot loops (`warp`, `pairs`, `score`, `apply`) already vectorise at `opt-level = 2` and are all in one crate, so there is nothing for LTO to inline across. A pinned `opt-level = 2` was removed for saying nothing; a full rebuild is 0.4s either way.

**Instruction set is a lever, unlike the above.** On a Zen 4 host, medians over three runs:

| `target-cpu` | fit (24MP) | grade (24MP) | job (24MP) | grade (15MP) | job (15MP) |
|---|---|---|---|---|---|
| `x86-64` (baseline) | 460ms | 310ms | 1562ms | 303ms | 2516ms |
| `x86-64-v2` | 451ms | 307ms | 1565ms | 298ms | 2502ms |
| `x86-64-v3` | 437ms | 296ms | 1530ms | 289ms | 2512ms |
| `x86-64-v4` | 398ms | 229ms | 1446ms | 217ms | 2418ms |
| `znver4` | 396ms | 235ms | 1494ms | 225ms | 2436ms |
| `native` | 402ms | 230ms | 1438ms | 221ms | 2457ms |

**`v4`, `znver4` and `native` are the same number.** The gain is AVX-512 and nothing else - no microarchitectural scheduling on top - so a portable build gets all of it and there is nothing for a host compiler to find. `v2` is noise and is not shipped; `v3` is ~5% and is, being free.

So the image ships one build per instruction set and picks between them at startup. Building on the host was tried first and is the wrong shape by four orders of magnitude: a `.so` is ~750KB, and the toolchain that produces one is 906MB of image (642MB rustup, 264MB build-essential) plus ~7s of every container start. Three variants cost 1.5MB and ~0.9s.

**Chosen by running them, not by reading CPU flags.** `native/entrypoint.sh` tries v4 then v3, each in a throwaway `bun native/verify_shim.ts` process, and symlinks the first that survives to `librawshim.selected.so`; the loader prefers that and ends at the plain `librawshim.so` baseline (§`rawshim.ts`). This is not the obvious design and is the cheaper one: a build using an absent instruction dies with `SIGILL`, which cannot be caught, so it has to die somewhere harmless anyway - and once a probe exists it *is* the feature detection, needing no flag table, no maintenance as levels are added, and no trust in a hypervisor that reports what it does not honour. `bb_selftest` runs the warp and the colour lookup rather than returning a constant, because a library that merely loads proves nothing about a CPU that faults once real pixel work starts. `BOWERBIRD_SHIM_VARIANT=baseline|v3|v4` pins one.

Every failure path ends at the baseline, which is what makes the whole arrangement safe to ship: the baseline is plain x86-64 and runs on the Goldmont Celerons in low-end NAS boxes, which have no AVX at all.

#### What an import costs, by stage

A shoot import is three different jobs with three different costs, measured over 23 real ARWs (a 24MP body and a 61MP one):

| | per file | at concurrency 8 |
|---|---|---|
| A, header read for the catalogue | 2ms | - |
| A, sha256 of the file | 107ms | I/O bound |
| B, grid tile from the embedded JPEG | **124ms** | **30.1 img/s** |
| C, full render and 3840px AVIF | 1501ms | 3.08 img/s |

**B is ten times the throughput of C**, which is what makes staging worth doing rather than interleaving: on a 2000-frame shoot, doing every tile first fills the whole grid in about a minute, where a combined job would take the full eleven that C needs before the last thumbnail appeared.

**Opening the RAW is not a time sink, so B and C need not share one.** The suspicion was that a fused pass would be needed to avoid opening each file twice, but extracting the embedded preview - `libraw_open_file` plus `unpack_thumb` - is **5ms of B's 124ms**. LibRaw reads headers lazily and the thumbnail is a few MB, so B never touches the sensor data C needs. They can be scheduled independently, which is the whole point.

**A 61MP body embeds a full-resolution preview**, 9504x6336 and 5-14MB of JPEG, not the small thumbnail the name suggests - only the 24MP body in the corpus embeds something small (1080x1616). Decoding that whole to make an 800px tile was most of stage B: 458ms per file, of which 230-540ms was the JPEG decode and, on portrait frames, half of *that* was `autorot` shuffling 60MP. Shrinking during the decode instead (`shrink=` on the loader, then a reduce for the rest) takes B to 105ms.

**The DCT is asked to go all the way to the target**, rather than stopping a factor of two short and leaving the reduce something to work with. It is a quality trade, because libjpeg's scaling and libvips' reduce are different filters: measured against decoding whole and reducing once, an 800px tile moves from deltaE 0.29 mean to 0.63, and its worst pixels from 7 to 24. The error is confined to fine detail where the two filters disagree - foliage, not sky - and at tile size it is invisible even under a 1:1 crop, which is the whole argument for taking it. Worth 105ms per file against 125ms.

The saving is smaller than the pixel count suggests - a quarter the output pixels for a fifth less time - because the entropy decode is proportional to the *file*, not the output. Huffman-decoding every coefficient block happens either way; only the inverse DCT, the chroma upsample and the colour convert get cheaper.

#### Where the time actually goes

Single-image latency is the wrong measure for an import, and the difference is large enough to change decisions. Throughput on a 24MP frame, 8 cores:

| concurrency | 1 | 2 | 4 | 8 | 12 |
|---|---|---|---|---|---|
| img/s | 0.53 | 1.04 | 1.69 | 2.40 | 2.35 |
| effective ms/img | 1897 | 964 | 590 | 417 | 425 |

It saturates at ~2.4 img/s: 4.5x the single-image rate, and flat past 8. An import is already throughput-bound with every core busy, so per-photo latency work only pays if it reduces total CPU. With the thread pools pinned to one, that budget is decode 495ms (26%), fit 675ms (36%), grade 364ms (19%), the two AVIF encodes 353ms (19%).

**Rayon buys ~3% of the fit** (505ms against 490ms with it disabled), which is worth knowing before optimising the scan further. The parallel candidate scan is genuinely parallel but small; what dominates is the sequential refine, a hill-climb whose every step depends on the last. That is also why a GPU is not the obvious answer it looks like - see below.

#### Why not a GPU

Asked twice, because the first answer was framed too narrowly. The work looks like it should suit a GPU - the grade is a per-pixel gather and lookup - and per-image latency is the wrong lens anyway: a batch import has thousands of independent frames, so a device with thousands of weak cores is the right shape in principle.

**Fixed-function AV1 cannot do 4:4:4.** NVIDIA's support matrix gives AV1 as "YUV 420 8-bit and 10-bit" on Ada and Blackwell only; 4:4:4 exists for H.264 and HEVC but not AV1, and neither AMD's VCN 4.0 nor Intel's Arc QSV documents it. Vulkan's `VK_KHR_video_encode_av1` maps to the same silicon, so it inherits the same limit. This is §10.7's wall from the encoder side: 4:4:4 is not AV1's Main profile, and no hardware *decoder* takes it either. Since 4:4:4 is deliberate here (§10.1 - 4:2:0 smears the saturated edges a photograph is judged on), that rules the fixed-function path out rather than making it a trade.

**A compute-shader AV1 encoder would sidestep that, and does not exist.** Running the encoder on shader cores rather than the video engine means implementing whatever profile you like, so it is the right question to ask. The state of the art is FFmpeg's Vulkan compute codecs, and the list is FFV1 and ProRes - chosen precisely because they use table-based coding. The barrier is AV1's multi-symbol arithmetic coder: the next symbol depends on the previous one, so a bitstream is a serial dependency chain, and speculation does not go deep.

Batching across images is the right counter-argument and still loses, for a reason that is about the hardware rather than the algorithm. N images give N independent coders, but GPU lanes execute a warp in lockstep, and entropy coding is maximally branch-divergent, so lanes serialise against each other and most of the width is lost. The per-image RDO working set also bounds how many can be resident. The architecture that does work is a hybrid - GPU for transforms, prediction and RDO scoring, CPU for entropy coding - which is what the research does, and which no open-source AV1 encoder implements.

**Demosaic on GPU is real but buys the wrong thing.** NPP's `nppiCFAToRGB` is bilinear with chroma correlation, which is LibRaw's `linear` - measured above as both slower than PPG *and* further from AHD, so the vendor-supported kernel is the algorithm this deliberately does not use. Good GPU implementations exist (darktable's OpenCL kernels, GPL3; Fastvideo's commercial CUDA) but neither is a drop-in. And the stage is smaller than it looks: any rendition under 4864px decodes a 61MP frame at half size, which skips demosaic altogether.

**The RAW unpack is the part that cannot move at all.** ARW and CR2 carry Bayer data in lossless JPEG, whose Huffman decoding is bit-serial - the same objection as the AV1 coder. nvJPEG does not apply, being a baseline DCT decoder. Only Fastvideo claims GPU lossless-JPEG for these formats, proprietary. From the half-size measurements, unpack is roughly half the decode.

So the reachable target is the grade (19% of the CPU budget), plus a demosaic that would be worse, against CUDA as a hard NVIDIA-only dependency and a second implementation of the pixel maths kept in agreement with the CPU one - which has to stay, since the baseline exists for machines with no AVX at all.

**The cheaper lever is the fit**, 36% of the budget and dominated by a sequential refine, so parallelising its axis probes or cutting evaluation count attacks the largest share with no new dependency. The AVIF encoder is *not* a lever: the alternatives were measured and neither beats libaom (below).

**libaom, named explicitly, after measuring the alternatives.** libheif can be built with any of libaom, rav1e, SVT-AV1 or x265, and libvips' `heifsave` takes an `encoder` property to choose. All three AV1 encoders were installed and compared on the 3840px rendition; `BOWERBIRD_AVIF_ENCODER` (aom, rav1e, svt, auto) reproduces it.

| Q | libaom | | | rav1e | | |
|---|---|---|---|---|---|---|
| | ms | bytes | PSNR | ms | bytes | PSNR |
| 60 | 272 | 1.06MB | 33.53 | 1634 | 1.99MB | 34.73 |
| 80 | 404 | 3.50MB | 37.19 | 2300 | 4.80MB | 38.74 |
| 88 | 511 | 5.67MB | 40.13 | 2731 | 6.82MB | 41.50 |
| 95 | 602 | 9.66MB | 44.66 | 3422 | 10.15MB | 45.45 |

rav1e scores better at every Q, which means nothing on its own, because it also spends more bits at every Q. Compared at matched *size* - interpolating rav1e onto libaom's 5.67MB - it lands at ~39.9 PSNR against libaom's 40.13, so the rate-distortion curves are the same within measurement error while libaom is **5-6x faster**. libaom stays.

**rav1e is not slow for want of configuration.** The obvious suspects were checked. The `effort` mapping is not inverted - effort 0 is the fastest for both encoders, so libvips' polarity survives the trip through libheif into rav1e's `speed`. And it is not a missing thread count: measured as CPU time over wall time, rav1e uses *more* cores than libaom (3.7-3.9 against 2.2-3.6) and is still 5x slower, so it is doing more work per output bit rather than doing it on fewer cores. There is also nothing left to set - libvips' `heifsave` exposes `Q`, `bitdepth`, `lossless`, `compression`, `effort`, `subsample-mode`, `encoder` and `keep`, and no threads, tiles or jobs parameter, so how a plugin parallelises is entirely libheif's business.

Neither encoder saturates the machine, which sounds like an opportunity and is not. An import runs a pool and already saturates the CPU at ~2.4 img/s (above), so per-encode threading would add contention rather than throughput. It would only help the one-photo-at-a-time paths, the on-demand `max` rendition and the lossless export, where 2.2 of 12 threads is genuine idle capacity.

**SVT-AV1 writes a 201-byte broken file and reports success.** §10.7 records that it implements AV1 Profile 0 only and converts 4:4:4 down silently; through libheif 1.17.6 it does not even manage that - `vips_heifsave` returns 0, and what lands on disk has no valid stream (`missing mandatory atoms, broken header`). It is unusable here, and unusable in a way that no error surfaces.

That is why the encoder is named rather than left at libheif's `auto`, which picks by plugin priority. Measured, `auto` still chooses libaom with the svtenc plugin installed, so this is hardening rather than a bug fix - but the ordering is libheif's to change, the input here is always 4:4:4, and the failure mode is a silently corrupt rendition.

**libvips 8.15.1 is the version to write against, not the crate's.** The `libvips` crate targets a later release and its `*_with_opts` helpers send every property their options struct knows about - `tune` for `heifsave`, a `keep` flag for `jpegsave` - neither of which exists in the version Debian and Ubuntu ship. `heifsave` failed outright with ``no property named `tune` ``; `jpegsave` only logged a GLib critical, which is worse, because it looked like it worked. Both savers go through the raw bindings and name their properties explicitly, keeping the version-coupled part of the dependency to one function. Two more of the crate's edges are load-bearing: `ResizeOptions::default()` has `vscale: 0`, which collapses an image to a single row unless it is always passed, and `VipsImage` derives `Clone` as a shallow refcount copy alongside a `Drop` that unrefs, so cloning one produces `g_object_unref: assertion 'G_IS_OBJECT (object)' failed` on the second drop - hundreds per fit, at one point. Nothing here clones a `VipsImage`; the pipeline consumes `self` at every step so that it cannot.

### 10.5 Lossless export

`POST /api/photos/:id/lossless` renders one photo at full resolution into an AVIF kept beside the thumbnails. It exists because a 3840px preview is not what you check focus or gradients on, and it is opt-in per photo because it takes real time to build. Unlike every other rendition it is never fitted to a maximum edge: this is the view that gets pixel-peeped. The file is the cache: a second request finds it already there, and `PhotoDetail.renditions.max.built` is a `stat` rather than a column, so it cannot disagree with the disk.

It follows the library's HDR setting, since it is the same render from the same RAW and it would be odd for "view original" to be the one rendition that disagrees with the rest. That includes the Firefox video twin (§10.7): every rendition is the same picture at a different quality level, and they are interchangeable, so each has a video beside it wherever HDR applies. Only this one cannot stay at native size, SVT-AV1 refuses a source taller than 8704, so the video alone is fitted to that ceiling while the still stays full resolution.

**Format.** This was JPEG XL, and the swap to AVIF cost bit depth to buy simplicity. JXL keeps 16 bits where AVIF tops out at 10 here, and at matched quality the files are comparable: 3.42 MB against 2.97 MB on a 24MP frame, 0.34s against 0.48s. What decided it was delivery. No browser decodes JXL without a 1.6 MB wasm module, and the transcode that module needs to hand an `<img>` something it accepts cost more than the entire encode:

| | build | decode | total |
|---|---|---|---|
| AVIF, native everywhere |, | 136 ms | **136 ms** |
| JXL, native (flag) |, | 619 ms | 619 ms |
| JXL, wasm polyfill | 5.2 s PNG transcode | 518 ms | **7.5 s** |

The polyfill's cost was almost entirely the PNG it had to produce: a 121 MB 16-bit intermediate, deflated with dynamic Huffman to save 18% on a buffer that never leaves the tab. A stored-deflate PNG would have cut that to 805 ms, but `jxl-oxide-wasm` exposes no raw framebuffer; only `encodeToPng()`; so there was nothing to hand a faster writer. Deleting the format deleted the problem, along with the wasm, the cICP splicing and the ICC sniffing.

`LOSSLESS_QUALITY` (libvips' 1-100) and `LOSSLESS_QUANTIZER` (avifenc's 0-63, for the HDR path) are set tight rather than "visually lossless", and kept inside a ~20MB budget on a 60MP frame.

**Encoding.** SDR goes through libvips' AVIF encoder. The decode is deliberately 8-bit, because that encoder's output is 8-bit whatever goes in, so a 16-bit decode would be twice the memory for samples it discards. HDR goes through the ffmpeg/avifenc path (§10.7), which is where 10-bit and the PQ transfer live.

An `<img>` rather than a canvas, because a canvas cannot be HDR: neither 2D nor WebGL2 accepts a `rec2100-*` colour space, only `srgb` and `display-p3`, and `configureHighDynamicRange` is absent. An `<img>` keeps the browser's own colour management, HDR compositing, zoom and pan.

On the wasm path HDR signalling rides on a PNG **cICP** chunk (9/16/0/1 = BT.2020 + PQ), inserted after IHDR without touching IDAT; on the native path the tagging already inside the JXL does the same job. Chrome honours both identically: a flat 50% grey reads 128 untagged and 131 tagged, the same shift through the cICP PNG and through a PQ-tagged JXL. A neutral patch is what isolates this, since a primaries change is identity on the achromatic axis and an earlier test against a coloured gradient could not tell colour management from encoder noise. The PNG tag is applied only when the decoded ICC profile actually declares PQ or HLG, since tagging an SDR image would stretch it into HDR range.

**Firefox ignores HDR image tagging entirely**; that same grey reads 128 both tagged and untagged, through cICP PNG and through native JXL alike. Encoding the render as a single-keyframe HDR video to borrow the HDR video pipeline does not rescue it: Firefox 153 exposes no `VideoEncoder` at all, so there is nothing to encode with on the client, and `VideoFrame` rejects every 10-bit pixel format (`I420P10 is unsupported`), so HDR pixels could not be fed in even if there were. A server-side encode would clear that bar, but a PQ-tagged AV1 still shows the same flat-grey value as a BT.709-tagged one in Firefox, so the tag buys nothing today. Untested on an actual HDR display: this machine reports `(dynamic-range: high)` false, and a virtual display advertises no HDR EDID, so only signalling can be verified here, never output.

`libraw_set_output_color` currently pins sRGB, so nothing produced today is HDR: the delivery path is ready for it, the decode is not.

The default for newly indexed photos is the library's `preview_source` (§10.1). Changing it is deliberately not retroactive: rebuilding an existing catalogue is a job the user asks for explicitly, not something a preference does to thousands of files in the background. `POST /api/photos/reprocess` is that explicit request.

### 10.6 Orphaned files

Generated files are named `<photoId>.<ext>`, and photo ids are minted per insert, so a catalogue rebuilt over the same folder gives every file a new id and strands the old ones. Nothing in the normal write path notices: processing rewrites thumbnails in place, and the only unlink is a failed job cleaning up its own partial output.

Two things close that off:

- **Removing a library removes its data directory.** Re-adding the same folder can never reuse the renditions (new ids), so keeping them is dead weight. The RAW files are not ours and are left alone: the Bin is outside the data directory (§12.3), and `data_path` is user-supplied, so a library configured to keep its data alongside or above the photographs is skipped with a warning rather than having that directory removed. Anything that still looks like an original under there - a `<data_path>/bin` from the layout that predates the Bin's move - is carried out into the library's Bin first, and the removal refuses outright if any is left behind. Losing renditions is recoverable; losing originals is not.
- **A scheduled sweep** (`PRUNE_EVERY_DAYS`, default 7, 0 disables) walks each generated directory and deletes any file whose id has no row. The directories and the extension each is supposed to hold both come from the path helpers that write the files, so changing an output format cannot leave the sweep looking in the wrong place. A file whose extension no longer matches goes too, even when its photo is alive: a format change writes the new render beside the old one rather than over it, which the PNG-to-JXL switch made real at ~100 MB per photo ever opened. Only `renditions/` and `hdr/` are swept, so the sync lock is untouched (and the Bin is not in the data directory at all). Ids are checked against the whole `photos` table, not one library's, because the id space is global and two libraries may share a data directory. Soft-deleted rows count as live, since their renditions are what make the Bin browsable (§12.1).

### 10.6.1 One place that deletes

Every removal from disk goes through `src/utils/deletions.ts`, and a `no-restricted-imports` lint rule (`.oxlintrc.json`) bans `rm`/`unlink`/`rmdir` and their sync forms from `node:fs` everywhere else, tests aside. Renditions are cheap to lose and RAWs are not, and the two sit under directory paths that a refactor can make agree by accident, so the check that tells them apart is worth having in exactly one place rather than repeated at each call site.

Each entry point states what it will not do:

| | Guard |
|---|---|
| `deleteGeneratedFile(dataPath, target)` | Target must resolve under `<dataPath>/renditions` or `<dataPath>/hdr`, and must not carry a supported RAW extension. `dataPath` comes from the caller's own library, so a path from elsewhere cannot satisfy it. |
| `deleteDataDirectory(dataPath)` | Refuses while any supported file exists anywhere beneath, symlinks excluded. |
| `deleteSyncLockSync(lockPath)` | Basename must be `.bowerbird-sync.lock`. |
| `unlinkMovedFile(from, movedTo)` | Removes the source half of a move only once the destination exists, so a failed link or copy can never leave the move having consumed the file. |

It runs on an interval rather than at startup: a restart is no evidence anything was orphaned, and in development that would sweep on every reload.

### 10.7 HDR renditions

Two browsers, two answers. **Chrome** renders HDR stills, on desktop and on Android 14+, from a PQ- or HLG-tagged image. **Firefox** honours no HDR image tagging at all: a flat 50% grey reads 128 whether it carries a PQ cICP chunk or nothing, through a PNG and through a natively decoded JXL alike (§10.5). Its **video** pipeline does composite HDR, on Windows only, by passing the frame through to the compositor and the monitor. The underlying reason is the same for images on every platform and for video on most of them: Gecko's compositor is still 32-bit SDR, and RGBA16F framebuffers (bug 1889288) gate all of it.

So `POST /api/photos/:id/hdr` builds **six** renditions of one photo: a 4:4:4 AVIF still, a 4:2:0 AVIF baseline control and a one-frame AV1 video, each as **PQ** and an **SDR reference**. HLG was dropped: everything that renders HDR renders PQ, and PQ is absolute where HLG is relative to the display's own range. The comparison is the point; a single HDR file on an unknown display proves nothing. Encoding client-side was ruled out. Firefox 153 exposes no `VideoEncoder`, and `VideoFrame` rejects every 10-bit pixel format (`I420P10 is unsupported`), so there is neither an encoder to call nor a way to hand it HDR pixels.

**Decode.** This is the path that makes anything HDR, and until it existed nothing the server produced was. `decodeRaw(..., 'rec2020-linear')` asks LibRaw for Rec.2020 primaries (`output_color=8`), an identity gamma curve, and `no_auto_bright`. The last one matters most: auto-brightening normalises exposure, which spends exactly the headroom above diffuse white that carries the HDR. The result is scene-referred, so a normally exposed frame's mean sits far below the sRGB render's; which is what the integration test asserts, since a decode that quietly stopped applying these would still produce a plausible-looking file.

**All of this is in `native/rawshim`** - the grade, the colour fit, the argv and both child processes (`tone.rs`, `hdr_fit.rs`, `hdr_args.rs`, `hdr.rs`). It was TypeScript, and the graded frame was written to ffmpeg's stdin from there: ~115MB at 24MP and ~366MB at 61MP crossing the FFI boundary to reach a consumer that was never on this side of it. One call now takes a 16-bit decode handle and a path and produces the file, so a still and its video twin still share one decode without the samples ever leaving.

The argv construction moved with it rather than staying behind, which is the right split even though the argv holds no pixels: leaving it in TypeScript would have meant the encoder's settings living apart from the encoder invocation, and the two only make sense together.

**The port was held to a pin rather than to judgement** (`hdr_pin.integration.test.ts`). Neither half could be verified by "the tests still pass": the argv carries colour signalling whose loss is invisible until a browser declines to treat a file as HDR, and the grade's failure modes look like ordinary pictures. So the TypeScript's output was recorded first - 192 argv rows across the variant/medium/size/edge matrix, and the graded samples for five cases - and the Rust was required to match. It did: **the argv identical across all 192 rows, and the graded samples bit-identical on all five cases**, every one of ~29.6M `u16` samples.

Worth recording how nearly that pin was useless. Perturbing the BT.2390 knee changed nothing, because `eetf` returns early when the frame already fits the display: at 1000 nits the fixture never reaches the roll-off, so the pin covered none of the subtlest arithmetic in the grade. Two `peakNits=203` cases fixed it, and a 0.5 → 0.501 shift then fails. A pin nobody tries to break is a pin that proves nothing.

**Encode.** One `zscale` call applies the transfer for both media, then they diverge. Both are AV1 via **libaom**, at **4:4:4 10-bit**. The still is muxed by **avifenc** rather than ffmpeg, because ffmpeg's avif muxer writes no `colr` box and AVIF has no equivalent of the bitstream filter to repair one; `--jobs all` matters more than any other flag, since avifenc is single-threaded by default and that alone is 9.6s against 0.5s on a 24MP frame.

**4:4:4 is not a setting, it is an AV1 profile**, and that decides the encoder. Profile 0 is 4:2:0, Profile 1 is 4:4:4, Profile 2 is 4:2:2. SVT-AV1 implements Profile 0 only and *converts silently* - asking it for 4:4:4 or 4:2:2 yields 4:2:0 with no error - so it cannot be used here at all. libaom and rav1e implement all three. Measured decoder support:

| | 4:2:0 | 4:2:2 | 4:4:4 |
|---|---|---|---|
| AVIF still, Chrome and Firefox | yes | yes | yes |
| AV1 video, Chrome | yes | no | no |
| AV1 video, Firefox | yes | yes | yes |

Chrome refuses Profile 1 and 2 video outright (`MEDIA_ERR_SRC_NOT_SUPPORTED`), and `canPlayType` in Firefox reports `"no"` for them while playing them anyway - dav1d decodes every profile in software. Since the video exists only for Firefox, Chrome's refusal costs nothing: Chrome is served by the still. Not VP9, whose colour signalling does not survive this ffmpeg build and which has no metadata bitstream filter to put it back; not HEVC, which Firefox would not play at 4:4:4 at all.

**SVT-AV1 caps height at 8704 and does not cap width.** Measured, not read off a spec: 16384x4096 and 12288x4096 both encode, 6336x9504 does not, and the encoder says why in its own words, `Source Height must be less than or equal to 8704`. Only the full-resolution video (§10.5) is large enough to meet it, and it is fitted to that height rather than rotated to spend the free width. Rotating buys 9% linear resolution on a 3:2 frame, and the natural way to signal it back, the MP4 display matrix, is on Firefox 153's own list of things that stop a video being shown as HDR, so it would have to come back as a CSS transform in the one browser this file exists for.

Moving off SVT-AV1 gives up the **mastering-display and content-light metadata**, which reaches the file through `-svtav1-params` and has no libaom equivalent. Those are tone-mapping hints, and Firefox 153 does no tone mapping, so nothing that consumes this file reads them. The load-bearing signalling is the CICP, which survives.

### 10.7.1 Grading scene-linear to display-referred

The decode is scene-referred, and scene-referred data carries no exposure: LibRaw scales sensor saturation to full range whatever was metered. Tying linear 1.0 straight to the display peak therefore made brightness a function of the exposure rather than of the subject - measured over eight bodies, a 9.3x spread in mean brightness, with every clipped frame flat against the peak. `native/rawshim/src/tone.rs` grades the samples before they reach ffmpeg, and the same eight frames come out within 2.5x with nothing clipping.

Two ITU standards do the work, so no look had to be invented:

- **ITU-R BT.2408** puts diffuse white at **203 nits** (`HDR_REFERENCE_WHITE_NITS`), the value that makes HDR read at the same brightness as the SDR beside it.
- **ITU-R BT.2390** §5.4.1 supplies the **EETF**, a Hermite roll-off applied in PQ space that compresses everything above the display's peak into it rather than clipping.

Neither standard says *which* sample is diffuse white, because a camera takes that from the metered exposure and a raw file has no rendering intent. `HDR_WHITE_QUANTILE` (default 0.90) picks it from a histogram - the same heuristic dcraw's auto-bright uses - and is the knob to reach for if a library renders consistently dark or hot.

**A lower quantile renders brighter**, which is the opposite of the obvious reading: it places diffuse white further down the histogram, so everything above it scales up. The default was 0.99 and it was too high for landscape work. On a daylight frame that is half sky, the brightest 1% *is* sky and specular cloud edges rather than a lit white surface, so the anchor sat where the headroom should have started: peak 470 nits, greenery at 40. Measured on that frame, only **0.002% of pixels** are within a whisker of sensor saturation - a genuine specular tail of ~4,600 out of 60M - while p99 sits a full 1.21 stops below it. At 0.90 the same frame peaks at 823 with its greenery at 70.

The alternative would be normalising the brightest sample to the display peak, and that is precisely what the grade exists to avoid: it makes a photo's brightness depend on whether one glint happened to clip, which is what produced the 9.3x spread in the first place. Place diffuse white correctly and the tail lands wherever the scene actually put it.

The **peak is read off the frame, not off sensor saturation**, and that is what makes the grade exposure-invariant: both the white level and the peak scale with exposure, so their ratio, and therefore how much roll-off the highlights get, is a property of the scene. Anchoring the peak at sensor clip instead would give a frame shot two stops down four times the compression for the same subject.

The curve is baked into a 65536-entry lookup table, because a 60MP frame is 180M samples and `pow()` that many times is not free. The grade runs per variant rather than once, since the **SDR reference is graded with its peak equal to its reference**: the roll-off then lands diffuse white on display white, so it renders identically to the HDR one everywhere below that and differs only above it, which is what makes it a control rather than a second picture.

`HDR_PEAK_NITS` (default 1000) is now only the declared mastering peak and the roll-off target - no longer the exposure control - so it sets how much headroom sits above diffuse white. It is not interpreted the same everywhere: Chromium renders HDR stills relative to SDR white and caps headroom at 4 stops, while Firefox 153 does no tone mapping at all, so it is a knob to set against a display rather than a value that transfers.

Three traps, all silent:

- **SVT-AV1 discards the primaries and transfer** however the `-color_*` options are set, producing a file that reports `color_primaries=unknown`. The `av1_metadata` bitstream filter writes them back into the sequence header. Without it the encode succeeds and the result is not HDR, which is why a unit test pins the exact CICP numbers.
- **Frames are fitted to `HDR_MAX_EDGE`** (default 3840), inside the same `zscale` call so the resampling happens in linear light; resizing after the transfer would average PQ code values and darken the result. The check page reports each rendition's actual dimensions rather than implying full resolution. This also sidesteps a limit that only SVT-AV1 had: a maximum frame height, so 9504x6336 encoded while the same 60MP frame as 6336x9504 failed with `code: -22`. libaom takes either orientation.
- **The renditions outlast a request.** `Bun.serve` idles a connection out after 10s by default and the client sees a closed socket rather than an error, which reads as a crash. `idleTimeout` is raised to Bun's 255s maximum; the lossless render (§10.5) was already close to the old limit on a large frame.

The SDR still is tagged sRGB where the SDR video is tagged BT.709: they share primaries, but BT.709's transfer is a camera OETF and a browser renders an untagged still against sRGB, so sRGB is what makes the control look like an ordinary picture. Stills are 10-bit for every variant, so the control differs from the HDR ones in transfer alone; the SDR video stays 8-bit, which is what an SDR video is.

**Confirmed on a real HDR Android display**, Chrome: both the AVIF still and the one-frame video render visibly brighter than their SDR references, so both paths work. Two things worth keeping from that run. `dynamic-range` reported `high` while `video-dynamic-range` reported `standard`, and the video was plainly HDR regardless: the video-plane query describes bi-plane devices like TVs, cannot be answered without knowing whether a given frame reaches a hardware overlay, and is not something to gate on. And the video looked sharper than the still until `image-rendering: pixelated` was applied to both, at which point they matched. That is Chrome's scaler, not the encode: measured against the frame both were encoded from, the still scores *better* (SSIM 0.9932 against 0.9923) at twice the bitrate. The `<img>` path filters a downscale properly; the video plane scales more cheaply and the resulting aliasing reads as detail.

**A blank video row is usually the codec, not the tagging.** Firefox on Android ships `media.av1.enabled` off for battery, and Safari has no software AV1 decoder at all; it plays AV1 only where the hardware does, so Intel Macs, M1/M2 Macs and iPhones before the 15 Pro cannot, however current their Safari. Both fail all three videos identically, SDR included, which is the tell: an HDR problem would spare the SDR reference. The page prints what the browser claims for AV1 before loading anything and marks a failed panel rather than leaving it blank. Neither gap is worth working around, because both of those browsers decode the AVIF stills, which is the path that matters on their platforms; if an Apple video path were ever wanted it would be HEVC 10-bit, hardware-decoded on every Apple device.

### 10.8 Matching the camera's own rendering (`fit.rs`)

A render carries none of what the camera would have done to the same frame: not the maker's colour science, and not the picture profile the photographer chose on the body. Buying that normally means sourcing, storing and hosting a lens profile and a colour profile per body, which is tedious where it is possible and impossible where a maker never published one - and it still cannot honour a per-shot setting. Everything needed is already inside the RAW, in the JPEG the camera put there. `MATCH_EMBEDDED_JPEG` fits the transform that takes a render to that JPEG, and applies it to every rendition built from a render - SDR here, and HDR through §10.8.1, which reuses this section's geometry and refits only the colour.

**Geometry first, colour second, and the order is not negotiable.** A colour transform is fitted from pixel pairs, and a pair means nothing unless both pixels show the same point in the scene. On a frame whose JPEG is distortion-corrected, fitting colour first plateaus at ΔE76 16 however much capacity the colour model is given - per-channel curves, curves plus a 3×3 matrix, and a 33³ 3D LUT all land within 1.5 of each other - because no tone curve can map a pixel onto a different pixel's colour. Correcting geometry first takes that same frame to 1.51. The corollary is that the geometry stage cannot use colour as its matching signal.

**Geometry is read where the camera recorded it.** Sony writes a distortion spline at `IFD0` → SubIFD (`0x014a`) → tag `0x7037`: an `SSHORT` array whose first element is the knot count, the knots evenly spaced from frame centre to corner, in units of 1/16384 of the half-diagonal and anchored at zero in the centre. Plain TIFF parsing reaches all of it; none of Sony's enciphered `0x94xx` blocks are involved. Validated against an independent fit of the render against the JPEG - at 28mm the spline says −2.83% at the corner and the fit says −2.78% - and the values track focal length per shot rather than coming from a table, the 28-75 zoom crossing zero near 32mm and reaching +4.5% at 75mm. Three things do not generalise and must not be assumed: the **knot count is per body and per tag** (ILCE-7CR 16, ILCE-6300 11, and within one RX100M3 file the vignetting tag uses a different count from the distortion one), **most older bodies record nothing at all** (14 of the 20 measured, so the fitted fallback is the common path rather than a contingency), and the **vignetting tag `0x7032` must not be applied** - it describes a corner gain of +50% where the measured scene-linear ratio between the corrected render and the JPEG is flat, so applying it would inject a ~35% corner error.

**The spline carries no overall rescale**, being anchored at the centre, while the camera also crops and rescales to keep the frame full. That one scalar is fitted. It is *nearly* derivable - for pincushion, tightest-fill predicts it exactly, `1/(1 + 740/16384) = 0.95679` against 0.9569 fitted - so the prediction seeds the search, but for barrel the camera is more conservative than tightest-fill, so a scan around the seed still runs.

**Candidate warps are scored by the colour residual they leave behind.** This is what makes the search robust: a wrong warp cannot be rescued by any tone curve, so a good score means genuine correspondence, and the number being minimised *is* the acceptance criterion. It needs no band selection, no subpixel interpolation and no outlier rejection. Feature matching was tried first, in four variants, and every one produced a *confident* wrong answer - three of them independently reporting "no distortion" for a frame that has 4.4% of it. The general lesson is worth more than the specific bug: **a radial error and a radial model will always find each other**, so a null result from a detector means nothing until the detector is shown to recover a synthetic injection of the effect it is looking for. An integration test does exactly that, and it earned its place immediately by catching that only the crop was being refined and never `k1`, so a 3% injection came back as 4%.

**Colour is per-channel curves plus a 3×3 matrix, not a 3D LUT.** 777 coefficients beat a 17³ LUT and tie a 33³ one at 107k, because the vendor transform is close enough to separable that the extra dimensions only fit noise in the cells one frame never populates. Curves are binned means, gap-interpolated, extended at the end slope rather than flattened (which would crush every highlight the frame happened not to sample) and forced monotone so a thin bin cannot invert them. Clipped and high-gradient pixels are excluded: the first are not invertible, and on the second a fraction of a pixel of misregistration swamps the colour difference being measured.

**The residual floor is content, not model.** After geometry, ΔE lands around 1 where content is smooth and 2.5-3 in fine detail, and per-tile fits show why: on one frame the smooth tiles score 0.81-1.07 while dense-detail tiles score 2.79-3.07. It is the camera's noise reduction and sharpening against LibRaw's demosaic, which no colour transform should try to reproduce - and note that blurring both images does not remove it, because NR is edge-preserving and nonlinear, so the two are not a linear filter apart. Adding model capacity for it is wasted: a 33³ LUT scores *worse* than curves plus a matrix at every blur level.

**One fit per photo, and nothing is stored.** The fit is on the job rather than the target, so the grid tile and the full view cannot disagree about colour. Across jobs - the max-resolution export is built on demand, long after the import - the fit is deterministic, so refitting lands on the same transform rather than a second opinion, which is why no profile is persisted. A test pins that determinism, because it is the only thing standing between "no storage needed" and two differently-graded copies of one photo.

**Applied after the resize, not before.** The distortion model is in normalised radii and the colour transform is a per-pixel lookup, so the order is immaterial to the result - and warping a 60MP decode to produce an 800px tile costs seconds per rendition. Measured: 59-75ms at 800px and ~0.6s at 3840px, against 1.2-2.9s at full resolution. A test pins the equivalence.

**One decode serves the fit and every rendition.** This was the single biggest cost and it was pure waste: `writeSdr` decoded per target, so a `render` import demosaiced the same 60MP frame twice for the grid tile and the full view, and the fit decoded a third time for an identical result. Sharing one lazy decode across the job took the fit on a 60MP frame from 3.8s to 1.9s and the unmatched baseline from 4.8s to 2.9s, so it is a win whether or not matching is on. Lazy because an embedded-source job may never need a decode at all, and the fit is skipped outright unless some SDR target actually demosaics - an embedded grid already carries the camera's look.

**On by default**, because a render that does not look like the camera's own JPEG is the wrong picture, and what is left costs a fraction of the decode it rides along with. On a 61MP ILCE-7CR frame, building the grid tile and the full view goes from 2.9s to 5.3s, the added 2.4s being a ~1.9s fit paid once per photo plus ~0.4s of transform across the two renditions. Where the geometry has to be searched rather than read the fit is roughly twice that. `MATCH_EMBEDDED_JPEG=false` turns it off for an import where throughput matters more.

The lever if that ever matters is caching geometry by (lens, focal length) rather than per photo - the three 28mm frames measured agree to ~10%, so geometry pools even though colour does not - but that needs storage and is not built. Only Sony is verified; Canon records an equivalent but no CR2 or CR3 has been tested, so those fall through to the fitted path.

### 10.8.1 The same look in HDR (`hdr_fit.rs`)

The colour half does not lift to HDR, and the reasons are structural rather than approximate. The SDR curves are indexed by an 8-bit render level and answer with an 8-bit JPEG level, so their **domain stops at display white** - which is the whole of what HDR adds - and 8 bits of output is coarser than the shadows of a PQ signal, so applying them would band. **The geometry does lift**, being a property of the lens and not of a colour space, and it is the expensive half: it is reused as fitted, and only the colour is refitted in the domain the grade works in, Rec.2020 linear normalised so diffuse white is 1.0. That normalisation is what makes the curve extrapolable, which is what lets the camera's rendering stop at diffuse white and BT.2390 take over above it (§10.7.1).

**Below diffuse white the camera's per-channel rendering; above it, one shared gain.** Past the ceiling the whole pixel is scaled down until its brightest channel sits at the top of the fit domain, read there, and scaled back up by the same factor - so a bright orange keeps the camera's orange and only gets brighter, and a pixel twice as bright comes out twice as bright. This is the point of the exercise: an 8-bit JPEG turns everything above its clip point to flat white, and the extra range exists precisely to keep those highlights coloured.

Letting each channel run on its own extrapolation instead is what tinted the sky magenta, and it took two fixes because it had two causes. The visible one was free extrapolation, measured at Δa\* +11.8 in the top L\* band. The larger one was the **mask**: a pixel was dropped if *any* channel was near clipping, so in a sky - where blue is the high channel - every sky pixel vanished from red's and green's curves too. Both ran out of data well below the ceiling and were extrapolated from there, tinting the 75-89 L\* band Δa\* +5.2 on pixels sitting *inside* the fit domain. The end slopes tell the story: 0.435 / 0.206 / 0.336 before, 0.390 / 0.411 / 0.336 after gating each curve on its own channel. A per-channel curve needs only its own channel in range; the matrix still wants all three, being cross-channel.

**The 3×3 is weighted perceptually, and that is not a detail.** Unweighted least squares in linear light is dominated by the brightest pixels - on a frame that is half sky, the sky *is* the fit - and the matrix it lands on oversaturates everything darker, measured at 1.093× the camera's mean chroma. Weighting each sample by d(∛v)/dv, so it counts for its perceptual size rather than its photometric one, takes that to 1.042; a mild ridge towards identity keeps it from inventing a cross-channel term out of what the frame does not contain. The last 4% is a saturation that varies with level, which a 3×3 structurally cannot express, so one fitted scalar blends towards luma. Together: held-out ΔE 2.26 on the test frame, contrast and saturation both within 0.2% of the camera's.

Two performance traps, both measured on a 61MP frame. **Warping before downscaling** took the fit from 1.6s to 17s, and the SDR path already had the order right: down to twice the fit grid first, so the warp resamples prefiltered pixels rather than aliasing on the way in. And in the grade, **returning tuples per pixel** cost more in collection than all the arithmetic - 180M allocations - so the matched loop is flat and scalar, with a per-channel lookup for the below-ceiling case that covers nearly every pixel of a photograph. Grading with the match is the price of a cross-channel transform - there is no single input level to key a lookup on - which is why the resize below matters so much: at 3840 the whole rendition is 1.7s matched against 0.9s not, where at native resolution it is 8.1s against 2.9s.

**Resize, then warp, then grade** - in that order, and each position is load-bearing. The resize comes first because the grade used to run on all 61MP before handing ffmpeg a frame it immediately fitted to 3840, so ~15/16 of the most expensive step was discarded; doing it in linear light here instead is the same picture, and took the full-size rendition from ~7s to 1.7s. The warp comes next because the distortion model is in normalised radii, so warping 61MP to make a 3840px rendition is sixteen times the work for the same result. The grade comes last because the colour was fitted from pairs that only correspond *through* that warp.

That reordering costs one thing: the levels can no longer be measured where they are used. Averaging pulls a specular peak in, so a downscaled copy reports a different diffuse white and a different scene peak, and the full-size rendition would grade to a different brightness than the max-resolution one. `measureLevels` runs once on the decode and both share the answer, which a test pins across three scale factors.

**Geometry and colour travel as one object**, and that is a fix rather than a preference. They shipped separately at first: the geometry was used to build the fit and then never applied to the output, so an HDR rendition had the camera's colour with LibRaw's shape, and disagreed with its own SDR twin about where everything in the frame was. `HdrMatch` carries both so applying one without the other is not expressible.

**`match` is required, not optional, everywhere it is passed.** These option objects are built by spread, TypeScript does not excess-check a spread, and an *optional* field a caller forgets is dropped in silence - which is exactly what happened: `HdrEncodeOptions` never declared it, the worker spread it in, and the product rendered unmatched while a unit test calling `grade` directly went on passing. Written `match: HdrMatch | null`, every call site has to say which it means, and an integration test drives `encodeHdr` rather than `grade` so the wiring itself is covered.

**Verification stops at the signalling.** `ffprobe` confirms BT.2020/PQ/BT.2020-ncl and 10-bit on both media, and that each SDR reference is tagged as intended. Whether any of it lights up a panel is not observable from script: the frame goes to the compositor, and anything read back through a canvas has already been tone-mapped. `GET /hdr-check/:photoId` serves a page putting all six side by side, for looking at on real hardware. It is served by the API rather than the web client because the HDR machine may not be the one running the UI.

---

## 11. Metadata Extraction (`metadata.ts`)

Used during sync to populate photo records and compute file hashes.

### 11.1 Implementation

Metadata is read via the same per-format dispatch as decoding (§10): sniff the header, route to the format's reader. libvips is **not** used for RAW metadata, as it has no RAW loader and, when coaxed to open an ARW as a generic TIFF, report the embedded preview's dimensions rather than the full-res sensor values.

For Sony ARW, metadata comes from **LibRaw's header parse**: `libraw_init` then `libraw_open_file` populates `imgdata.sizes` (dimensions and `flip` orientation), `imgdata.other` (capture `timestamp`, parsed GPS), and `imgdata.color` (color space), followed by `libraw_adjust_sizes_info_only` to flip-adjust `sizes.iwidth`/`iheight` (see below), all **without** calling `libraw_unpack`/`libraw_dcraw_process`, so no pixel data is decoded. This is the fast path used per file during scan. `colorSpace` in Stage 1 is the constant `sRGB` output space: LibRaw exposes no stable accessor for the camera's source color-space EXIF tag, and the decode pipeline always outputs sRGB, so this field is fixed (informational + a stable, non-varying hash input) rather than read per file. (`imgdata.color` holds calibration/profile data, not a simple source-space identifier.) The EXIF capture time is naive (the tag carries no zone). LibRaw exposes it only as a pre-computed `time_t` in `imgdata.other.timestamp` (derived by interpreting the naive `DateTimeOriginal` as the process's local timezone), with no accessor for the EXIF `OffsetTimeOriginal` tag. Stage 1 therefore reads that `time_t` back through the same local zone `mktime` used and re-encodes those components as a `Z` UTC ISO string (§4), which stores the camera's wall clock verbatim whatever the server's zone is; taking the `time_t` as an instant instead would slide every capture date by the server's offset. The stored value is a wall clock rather than an instant, so the client formats it in UTC (`captureDateTime`) rather than in the viewer's zone, which would slide it a second time. The zone itself comes from a second, direct read of the file: `exif_zone.ts` walks the TIFF header the RAW already is, IFD0 into the Exif IFD, and returns `OffsetTimeOriginal` (0x9011), falling back to `OffsetTime` (0x9010), into the `date_taken_offset` column. Bounded to the first 256KB, so it costs a page or two rather than a read of a 25MB file, and null when a pointer leads past that window. The tags arrived in EXIF 2.31 (2016), so older bodies record nothing and the column stays NULL: a Sony ILCE-7CR writes `+11:00`, an ILCE-6300 writes no offset at all. Blank and malformed values ("      ", `+1100`) are read as absent rather than as UTC. It is deliberately not a hash input (§9.2), for the same reason `dateTaken` is not: the hash is a change detector for a file the scan has already decided to open, which only happens once mtime or size differs (§9.1), and mtime is itself hashed. Descriptive metadata therefore adds no detection the hash does not already have. Rewriting the zone tag in place while preserving mtime and size defeats the quick-check before a hash is ever computed, so hashing it would not catch that case either. `date_taken` stays the wall clock either way, so ordering and the date filters are unaffected by whether a body recorded a zone; the offset is what the viewer shows beside the time and what a true instant would be derived from. The reader also `stat`s the file to fill `mtime`/`fileSize`, so the scan-time result carries them all the way to Phase 3 apply (§9.4) without a second `stat` inside the transaction.

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

// Stage 1: one ARW reader. A second format adds a header sniff here.
async function extractMetadata(filePath: string): Promise<FileMetadata> {
  // stat() + LibRaw header parse, no unpack
}
```

Body and lens come from `libraw_get_iparams()` (`normalized_make`/`normalized_model`, falling back to the raw `make`/`model`) and `libraw_get_lensinfo()` (`Lens`). LibRaw leaves the lens blank or `---` on fixed-lens bodies, and both spellings are stored as NULL: "unknown" rather than a lens named `---`.

**Sensor crop.** Some bodies (the ILCE-7CR among them) report masked border columns as part of LibRaw's "visible" area, `sizes.width`/`height` equal `raw_width`/`raw_height` with zero margins, while the file separately states the real picture in `sizes.raw_inset_crops[0]`. Decoding the visible area verbatim then bakes black bars down two edges of every thumbnail. Both the header read and the decode therefore crop to that inset when the file states a usable one (an origin of `65535` means "not stated", and a crop that does not fit the raw frame means the struct layout drifted; either way, no crop). `dcraw_process` emits an upright image, so the sensor-space margins are rotated by the same flip before being applied. The two paths must agree: the stored `width`/`height` describe the picture the thumbnail shows.

The processor is opened header-only and closed (`libraw_close`/`libraw_recycle`) immediately after reading the fields; the memory-leak audit note in §10.4 applies here too.

These struct reads are at hand-computed byte offsets validated against real ARWs from four bodies, so a LibRaw upgrade that reorders a field would degrade to plausible garbage rather than an error. `raw_header.integration.test.ts` pins the known-correct values for the checked-in fixture.

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

1. **Keep the thumbnails.** They are *not* removed. The Bin is a view the user browses to find something to restore, and it is useless if every frame in it is a grey placeholder. The two AVIFs are roughly 1% of the size of the RAW the Bin is already retaining, so deleting them saves almost nothing and costs the feature. They are removed only when a photo is permanently purged.

2. **Move RAW file to Bin:**
   - Determine the bin path:
     - If the photo is in a shoot: `<shoot_folder>/Bin/<original_filename>`
     - Otherwise: `<library_root>/Bin/<original_filename>`
   - If a file with the same name already exists in the Bin, append a numeric suffix (e.g. `IMG_0001_1.ARW`, `IMG_0001_2.ARW`).
   - Move (rename) the file. Do **not** copy-and-delete.

3. **Update DB record:**
   - Set `is_deleted = 1`.
   - Set `needs_processing = 0`.
   - Do **not** delete the record.

### 12.2 Restore

`POST /api/photos/restore` is the undo of a soft-delete. Delete records the pre-Bin `file_path` in `deleted_from_path`, and restore moves the RAW back to exactly that path, clears `is_deleted` and blanks the column.

- Shoot and album membership need no restoring: soft-delete never touches `shoot_id` or `album_photos`, so both survive the round trip.
- If something else occupies the original path by then, the move takes a numeric suffix rather than overwriting a live photo.
- A row predating the column restores to the library root; the next sync reconciles its shoot from the path.
- Restore is what the client's undo toast calls, so binning is always reversible from the UI.

### 12.3 Bin Folder

The Bin folder for shoots lives at `<shoot_folder>/Bin/` (inside the shoot folder itself). The Bin folder for non-shoot photos lives at `<library_root>/Bin/`.

**Never under `data_path`.** A Bin holds originals, and the data directory is the one tree the system deletes wholesale (§6, §10.6); a bin inside it would mean removing a library, or clearing `.bowerbird/` by hand, silently destroying every photograph the user had binned. Both bins therefore sit beside the photographs they came from, where the only thing that can remove them is the user.

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
| `PATCH` | `/api/libraries/:id` | Update a library (default ordering) |
| `DELETE` | `/api/libraries/:id` | Delete a library |
| `POST` | `/api/libraries/:id/sync` | Trigger sync for a library |
| `GET` | `/api/libraries/:id/sync/status` | Get sync/processing status |

### 13.2 Photos

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/libraries/:libraryId/photos` | List photos in a library (paginated, filterable) |
| `GET` | `/api/libraries/:libraryId/photos/missing` | List missing photos in a library |
| `GET` | `/api/photos/:id` | Get full photo detail |
| `PATCH` | `/api/photos/:id` | Update photo metadata (rating, triage, notes) |
| `POST` | `/api/photos/delete` | Soft-delete photos (body: `{ photo_ids: string[] }`) |
| `GET` | `/api/config` | Thumbnail format, sizes and qualities, so a client can state what it is rendering |
| `POST` | `/api/photos/restore` | Restore soft-deleted photos to where they were deleted from (§12.2) |
| `POST` | `/api/photos/reprocess` | Rebuild thumbnails for a selection from a named source (§10.3) |
| `POST` | `/api/photos/refresh-metadata` | Re-read the RAW headers for a selection |
| `POST` | `/api/photos/:id/lossless` | Build the full-resolution lossless render (§10.5) |
| `POST` | `/api/photos/:id/hdr` | Build the HDR renditions, both media, all variants (§10.7) |

Query parameters for listing (`PhotoListQuerySchema`, §5.3):
- `offset` (int, default 0)
- `limit` (int, default 100, max 500)
- `is_missing` (boolean, optional filter)
- `needs_processing` (boolean, optional filter)
- `include_deleted` (boolean, default false)
- `is_deleted` (boolean, optional filter)
- `rated` (boolean, optional: `true` = at least one star, `false` = unrated)
- `triage` (optional, comma-separated verdicts to include, e.g. `triage=untriaged,picked` for the default gallery view that hides rejects)
- `ordering` (optional, overrides the collection's stored ordering for this request only, so a client sort control does not edit the library)
- `q` (optional, case-insensitive substring of `file_path`)
- `taken_from` / `taken_to` (optional `YYYY-MM-DD`, inclusive bounds)
- `match` (optional, `all` (default) or `any`)

The same schema serves the library, shoot and album listings, so a filter behaves identically wherever the user is.

`rated` is a "has any rating" test rather than an equality one, because the question during a cull is "what have I not judged yet".

`match` selects how `rated`, `triage`, `is_missing` and `needs_processing` combine. `all` intersects them; `any` unions them, which is what a "show me anything still needing attention" filter means; as an intersection, "picks and unrated and missing" is almost always empty. It applies only to those four: scope (soft-delete, `q`, the date range) always intersects, so narrowing by filename or date still narrows a union.

The date range filters on `COALESCE(date_taken, date_added)`; the same date the listing sorts and labels by; so a file the camera never dated stays reachable. `taken_to` is inclusive of the whole closing day (the column is a timestamp, the bound is a date).

Library, shoot and album responses each carry a `photo_count` (excluding binned photos), and libraries carry `last_synced_at`, so a client can show how large and how stale a collection is without a second request per row.

`include_deleted` and `is_deleted` do different jobs: the former lifts the default "hide soft-deleted rows" clause, the latter selects on the flag. The Bin view is `include_deleted=true&is_deleted=true`; without the pair a client could ask for "live and deleted together" but never for "deleted alone".

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
| `GET` | `/image/:photoId/renditions/:rendition` | Stream one rendition: `grid`, `full` or `max` (§10.1) |
| `GET` | `/image/:photoId/renditions/:rendition/video` | The one-frame AV1 twin of an HDR rendition (§10.7) |
| `GET` | `/image/:photoId/embedded.jpg` | The camera's own JPEG, lifted out of the RAW unchanged |
| `GET` | `/image/:photoId/original.arw` | Stream original RAW file |
| `GET` | `/image/:photoId/full.jpg` | The full rendition transcoded to JPEG, as an attachment |

**Dynamic range is not in the URL.** The library decides it, so a client naming `full-hdr` would be guessing at a file that may never have been built; the route resolves it from `preview_hdr` instead, and `PhotoDetail.renditions` tells the client what it is looking at.

`embedded.jpg` and `full.jpg` are produced per request and never stored: extraction is a header read plus a copy, a download is occasional, and another derivative per photo on disk would cost more than either does.

**Caching.** Thumbnails are rebuilt in place under a stable URL, so every image response carries an `ETag` (file size + mtime) and `Cache-Control: no-cache`. Without a validator the browser caches heuristically with nothing to revalidate against, and keeps showing the pre-rebuild picture; `no-cache` still caches, it just always asks first, which is a 304 in the common case. `If-None-Match` is answered directly.

That covers everything that *asks*, which is every fresh page load. But an `<img>` whose `src` attribute has not changed never asks at all, so a rebuild is invisible to the copy already decoded in a live page; and a fresh element with the same `src` is handed that copy without revalidating, so remounting does not ask either. Every image URL therefore carries the photo's `date_reprocessed` as a version (§18.6): stamped by whatever wrote the file, delivered on the row, so it is right from the first render, identical in every client, and stable across reloads. Two URLs, two cache entries; the ETag then keeps each of them honest.

These endpoints:
- Resolve the file path from the photo record and library configuration.
- Stream the file directly from disk using Bun's file streaming (no buffering into memory).
- Set appropriate `Content-Type` headers (`image/avif` or `image/x-sony-arw`).
- Set `Content-Length` from file stats.
- Return 404 if the file does not exist on disk. Soft-deleted photos **are** served: the row and both files still exist, and the Bin view depends on being able to render them (§12.1).
- Support `Range` requests for partial content (HTTP 206), enabling seeking for large files. `Bun.serve` answers these against a `BunFile` body (including `Content-Range` and a 416 for an unsatisfiable range) but does not advertise the capability, so the handler sets `Accept-Ranges: bytes` itself.

The served thumbnails are already rotated to display orientation (baked in during processing, §10.4), and the `width`/`height` in photo responses are the matching upright dimensions. Clients render them as-is and must **not** apply the photo's `orientation` value to them.

Implementation approach:
```typescript
app.get('/image/:photoId/renditions/:rendition', async (c) => {
  const photo = await photosService.get(c.req.param('photoId'));
  if (!photo) return c.notFound();
  
  const library = await librariesService.get(photo.library_id);
  const filePath = getRenditionPath(library, photo.id, rendition, library.preview_hdr);
  
  const file = Bun.file(filePath);
  if (!await file.exists()) return c.notFound();
  
  return new Response(file);  // Bun streams this from disk
});
```

`Bun.file()` returns a lazy reference that streams from disk when consumed as a `Response` body, no full read into memory.

### 13.6 Config, settings and events

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/config` | Thumbnail format, sizes and qualities, so a client can state what it is rendering |
| `GET` | `/api/settings` | App-wide preferences |
| `PATCH` | `/api/settings` | Update them |
| `GET` | `/api/events` | Server-sent events; `thumbnail` carries the id of a photo whose renditions were just written (§18.6) |

Three different things, by how far their scope reaches: `config` is fixed by the deployment (environment variables, §15); the `libraries` row holds what belongs to one catalogue (the preview source and HDR, §10.2); `settings` is app-wide and lives in a key/value table, holding `preview_rendition_mode` and the rendition `remember` remembers. A table rather than a column per setting because they are read one at a time and never queried across, and adding one should not need a migration. A value the build no longer understands reads as its default rather than failing the request: these are preferences, and the viewer has to open with or without them.

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
| `SMALL_THUMBNAIL_QUALITY` | `80` | AVIF quality for small thumbnails, 1-100 (§10.1) |
| `FULL_THUMBNAIL_QUALITY` | `80` | AVIF quality for full thumbnails, 1-100 (§10.1) |
| `THUMBNAIL_EFFORT` | `0` | AVIF effort, 0-9; the default of 4 is 10x slower for +0.5dB (§10.1) |
| `SMALL_THUMBNAIL_SIZE` | `800` | Longest edge in pixels for small thumbnails |
| `FULL_THUMBNAIL_SIZE` | `3840` | Longest edge in pixels for full thumbnails |
| `MATCH_EMBEDDED_JPEG` | `true` | Give SDR renders the camera's own colour and lens correction, fitted per photo against the embedded JPEG; ~+2.4s on a 61MP frame (§10.8) |
| `WATCH_ENABLED` | `true` | Auto-sync a library when its files change on disk (§9.8) |
| `WATCH_DEBOUNCE_MS` | `2000` | Debounce window for coalescing filesystem events (§9.8) |
| `SYNC_FULL_AT` | `03:00` | Local `HH:MM` for the daily full reconcile; `""` disables (§9.8) |
| `PRUNE_EVERY_DAYS` | `7` | Interval for the orphaned-file sweep; `0` disables (§10.6) |
| `LOSSLESS_QUALITY` | `88` | AVIF quality for the SDR full-resolution export (§10.5) |
| `LOSSLESS_QUANTIZER` | `8` | avifenc max quantizer for the HDR one; lower is better (§10.5) |
| `HDR_PEAK_NITS` | `1000` | Display peak the BT.2390 roll-off targets, and the declared mastering peak (§10.7.1) |
| `HDR_REFERENCE_WHITE_NITS` | `203` | ITU-R BT.2408 HDR Reference White; what diffuse white is graded to (§10.7.1) |
| `HDR_WHITE_QUANTILE` | `0.90` | Quantile of the frame taken as diffuse white (§10.7.1) |
| `HDR_CRF` | `20` | Encoder quality for the HDR renditions; lower is better (§10.7) |
| `HDR_PRESET` | `8` | Encoder speed; libaom `-cpu-used` 0-8 and avifenc `--speed` 0-10, both clamped (§10.7) |
| `HDR_MAX_EDGE` | `3840` | Longest edge of an HDR rendition; AV1 cannot encode a full-size sensor frame (§10.7) |
| `CORS_ORIGINS` | *(unset)* | Comma-separated origins allowed to call the API, or `*`. Unset means "any port on whatever host the request arrived at", so the client works on loopback and over the LAN without hardcoding an address, while an unrelated site on the internet is still refused. |

---

## 16. Testing Strategy

Two tiers, both run by `bun test`, split by whether a module needs the container's native dependencies (`bun:ffi`/LibRaw, an on-disk photo tree) or can run anywhere against mocks.

### 16.1 Unit Tests

Services and API handlers whose dependencies can be mocked are unit-tested with dependencies supplied via constructor injection.

**Repository mocks:** Each repository interface is mocked to return predetermined data, allowing service logic to be tested in isolation without touching SQLite.

**Service mocks:** API handler tests mock the service layer to test request validation, response formatting, and HTTP status codes.

**Exceptions covered by integration tests instead (§16.3):** `SyncService`, the image-streaming API, and repository DB behaviour are *not* unit-tested; `SyncService` and the repositories exercise real SQL (mocking a repository well enough to test the sync algorithm would test the mock, not the SQL), and image streaming depends on `Bun.file`. These run against a real in-memory `bun:sqlite` DB and the LibRaw FFI in the container integration suite, which is the authoritative coverage for scan/diff/apply, the move/rename/delete races, the sync generation token, inode dedup, and image responses.

### 16.2 Key Test Cases

The sync-service, photo-deletion, and image-streaming cases below run in the integration suite (§16.3); the rest are unit tests.

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
- Concurrency vs. a user mutation mid-scan: an in-flight move's hardlink pair (link+unlink) is collapsed by inode so no duplicate row is inserted; a library deleted mid-scan aborts `NOT_FOUND` (no FK crash); a stale sync generation's detached processing tail doesn't stomp a newer sync's status

**Photo deletion:**
- Thumbnails are kept, so the Bin can be browsed
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

Unit tests (mocked dependencies, run anywhere):

```bash
bun run test
```

That runs `bun test src`, covering `src/**/tests/*.test.ts`. Test helpers (`describe`, `expect`, `jest.fn`, …) are imported from `bun:test`.

Integration tests (need real `bun:sqlite` + LibRaw, so they run in the container):

```bash
docker compose -f docker-compose.dev.yml up -d
docker exec -w /app bowerbird-dev bun test test/integration
```

These live in `test/integration/*.integration.test.ts` and cover the sync engine, image streaming, and repository DB behaviour end-to-end against a real Sony ARW fixture.

---

## 17. Implementation Order

The following order respects dependency chains — each step depends on the steps above it.

1. **Project scaffolding**: `package.json`, `tsconfig.json`, directory structure.
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

---

## 18. Web Client (`web/`)

A separate Vite + React app with its own `package.json`, dev server and build. It is a pure API consumer: it holds no photo logic of its own and talks to the server over HTTP from a different origin, which is why the API carries CORS (§15).

### 18.1 Stack

| Concern | Choice |
|---|---|
| Build / dev server | Vite 5 (port 5174, bound to `0.0.0.0`) |
| UI | React 18 |
| State | MobX 6 with standard (TC39) decorators |
| Routing | React Router 6 |
| Components | Base UI (unstyled primitives), wrapped once in `src/ui/ui.tsx` |
| Icons | lucide-react |
| Calendar | react-day-picker, restyled through its CSS variables |
| E2E | Playwright, driving the real API and a temp library |

Every control on screen comes from `src/ui/ui.tsx`, and each variant list is short on purpose: four button variants, four text roles, two heading levels. Uniformity is enforced in code rather than by discipline; `Button`, the segmented filter chips, `Select`, `TextField` and the menu triggers all carry the same `.ui-btn` class, so height, type size and icon size cannot drift between a filter and a toolbar button. A new fifth colour should mean rethinking the screen, not adding a variant.

The one deliberate exception: a link styled as a button is not routed through Base UI's `Button`, which would relabel the anchor `role="button"` and cost it the link role and open-in-new-tab. `Button` clones the passed element instead.

Standard decorators (`@observable accessor x`), not `experimentalDecorators`: MobX wires them up without a `makeObservable` call. They must be lowered before Rollup sees them, so `esbuild.target` and `build.target` are pinned to `es2022` in `vite.config.ts`; at `esnext` esbuild passes the `accessor` keyword straight through and the production build fails to parse.

Request and response types are `import type`-ed directly from `src/schemas/*` (the server's Zod schemas). The client therefore cannot drift from the API, and because the imports are type-only they are erased at build time, so no server code or Zod runtime reaches the bundle.

### 18.2 Layer split

Strict three layers per feature folder, no barrel files:

- **Stores** (`*_store.ts`) hold observables and computeds only, one per domain: libraries, photos, shoots, albums, sync. There is no aggregate root store; each is provided through its own React context.
- **Presenters** (`*_presenter.ts`) are the only writers. Every mutation, reaction and in-flight `AbortController` lives here. Cross-domain work goes presenter-to-presenter: `PhotosPresenter` bulk actions call `ShootsPresenter.addPhotos` / `AlbumsPresenter.addPhotos` rather than writing a sibling's store.
- **Components** read stores and bind presenter methods to callbacks.

MobX strict mode is on, so a mutation attempted outside an action warns in the console: the single-writer rule is enforced at runtime, not just by convention.

### 18.3 Screens

`/settings` (add / remove libraries, per-library ordering and sync), `/libraries/:id` (grid, filters, selection, bulk actions), `/libraries/:id/shoots` (tree + create), `/libraries/:id/bin`, `/shoots/:id`, `/albums`, `/albums/:id`, `/photos/:id`.

Every registered library is listed permanently in the rail, and the active one expands to its sections. There is no "choose a library" screen: adding one is a setup step that belongs in Settings, not a gate you pass through on each visit. Syncing lives in Settings for the same reason: it is maintenance on the library, and the gallery is for looking at photos. Settings and the shortcut sheet sit together at the foot of the rail, apart from the catalogue links, because they are about the app rather than the photographs.

There is no title bar. It only ever restated the library the rail already highlights, and the vertical space is worth more to the photographs.

Only `/libraries/*` names the library in the URL. Shoot and photo routes resolve it from the loaded entity so the rail keeps its context on a deep link, instead of blanking out. The photo route resolves it through a `@computed`, and the detail is not cleared while the next one loads, so stepping between photos in one library re-renders nothing in the shell.

### 18.3.1 Gallery controls

Five named views (Active, Untriaged, Picks, Rejects, All) answer the questions asked constantly and cost one click. Everything rarer lives behind a **Custom** menu of checkboxes that sends `match=any`, so ticking several means "any of these" rather than an empty intersection. A calendar range, a filename search, a sort and a thumbnail-size slider complete the row.

There is no "clear filters" button and no "default order" entry: All is the clear, and the sort always shows the concrete ordering in effect rather than an indirection through the collection's stored default.

Presets are named points in the same space as Custom, so selecting one shows its constituents already ticked there rather than leaving the menu looking untouched.

Three view modes share the same tiles: **grid** crops nothing but gives every photo a uniform cell so rows line up, **masonry** lets each keep its own shape (CSS columns, since `grid-template-rows: masonry` is not shipping), **list** trades density for filename and date. The zoom slider runs from many-across to a single photo filling the width.

Sort, filter, tile size and view mode are remembered per collection in `localStorage`, so returning to a shoot finds it as you left it. The filename search and the date range deliberately are not: those are questions asked in the moment, not preferences.

Rating and verdict sit on every tile, always visible and clickable, because a cull is mostly those two decisions and routing them through the detail view is what turns a ten-minute pass into an hour. Clicking the verdict a photo already has, or the star it already sits on, clears it.

A verdict or rating can move a photo out of the slice being viewed, so a change re-reads the page when a triage or rating filter is active. Filtering locally instead would mean a second copy of the server's filter logic, free to drift.

**Shift-click extends from the anchor on either half of a tile**, the frame and the tick box: the box is the visible handle for selecting, so a range built by clicking one box and shift-clicking another has to work. The anchor is the last photo toggled on its own, falling back to the keyboard cursor when nothing has been - arrowing to a photo and shift-clicking another is the same gesture as in a file manager, and a first shift-click has nothing else to reach for. Extending moves the cursor itself rather than leaving that to the caller, which would have to know to focus *after* extending: with focus as the fallback anchor, focusing first makes every range start and end on the photo just clicked.

The bulk action bar sits directly under the filters, where the selection was made, rather than at the foot of a grid the user has scrolled away from. Its actions include rebuilding thumbnails for the selection from either source (§10.3). While a selection exists the keyboard cursor's ring is suppressed: two different rings on one tile only invites "why is this one different".

Rebuilt thumbnails change behind a URL that does not, so the client appends a version to image URLs once a rebuild has happened in the session. The server's `ETag` covers a fresh page load; this covers an image already decoded in the current one.

### 18.4 Culling

Rating a shoot is the daily job, so it must not require opening each frame. The grid holds a keyboard cursor (distinct from the selection) and binds:

| Key | Action |
|---|---|
| `← → ↑ ↓` | Move the cursor |
| `0`–`5` | Set rating |
| `Z` | Undecided |
| `C` | Pick (again to clear) |
| `X` | Reject (again to clear) |
| `Del` | Move to Bin |
| `Space` | Add to the selection |
| `F` | Fullscreen, in the photo view |
| `I` / `O` | The camera's JPEG / the render, in the photo view (§10.1) |
| `Esc` | Clear the selection |
| `?` | Shortcut overlay |

`Z`, `X` and `C` are deliberately adjacent, in that order left to right, matching the Undecided / Reject / Pick order of the control: the left hand rests on them while the right drives the arrows. Each button shows its key, so the shortcut is learned from the control rather than from a help sheet. They work in the photo view as well as the grid, because that is where a close look leads to a verdict. `X` for reject also matches the convention photographers already have from Lightroom. Both keys toggle, so the same key that sets a verdict clears it.

Rejecting is not deleting. A reject stays in the catalogue and leaves the default "Active" view (untriaged + picked), which is what makes it useful during a pass; binning is the separate, undoable action on `Del`.

### 18.5 The photo view

The metadata panels sit beside a portrait frame and beneath a landscape one, so the image always gets the axis it needs. The page is a flex column filling the viewport and the stage takes every pixel the chrome is not already using. The stage supports fit/zoom (click, the magnifier button, or the wheel), drag-to-pan while zoomed, and a fullscreen mode whose only chrome is a bar that fades in on pointer movement.

The stage has no border or backdrop. A photo's aspect almost never matches the space it is given, so a framed, filled stage always showed dead margin on one axis and read as bars around the image; without the box there is nothing for the photo to fail to fill.

**The panels are laid out before the data that fills them arrives, so the stage is never resized under a photo it has already painted.** The strip under a landscape frame is a grid track the stage is sized against, so a panel that is absent while the detail is in flight and present a moment later moves the photo: it painted full-size and then shrank. Every panel therefore renders from the route, with the fields the detail answers standing at `loading` until it lands; the verdict and rating come from the loaded summary, which already carries them, so they are right from the first frame and hittable throughout. Reserving a fixed strip instead is dead margin under every photo whose panels are shorter than it, which is most of them.

The one thing that still has to be waited for is **which edge the panels take**, so the stage prepares a frame while that is unknown but does not show it (`hold`). The shape decides, and the loaded summary carries it, so the wait is real only on a deep link into a photo with no collection loaded. That never showed until the stage started warming the next photo: a preloaded frame decodes the instant it is asked for, well before the detail request returns, so it painted and then jumped.

Clicking and scrolling zoom **about the pointer**, not the centre: with `transform-origin` at the centre and `d = pointer - centre`, the offset that pins the point under the cursor is `d - (next/current) * (d - offset)`. Scale and pan are a single piece of state, because that formula needs the current offset to compute the next one; doing it by calling `setOffset` from inside a `setScale` updater made the maths run about twice over (React re-invokes updaters; a side effect in one is a bug regardless), landing the photo at roughly double the intended offset. The layout read happens in the handler and the resulting `DOMRect` is passed in, so the updater itself stays pure.

The image is absolutely positioned inside the stage. As a normal grid item its intrinsic height sized the grid row, so `height: 100%` resolved against the photo rather than the viewport and tall frames were cropped instead of fitted.

Panning is clamped so the photo cannot be dragged away from the viewport edge. The limit is derived from the `object-fit: contain` geometry (the fit scale times the zoom), not from the natural size, and it is re-applied when zooming out too, since shrinking the image shrinks the legal offset.

The stage's `src` is keyed off the route rather than the loaded detail, and the image stays hidden until that src decodes. The store deliberately keeps the previous detail while the next loads (so the rail does not collapse), which otherwise means the stage paints the frame *before* the one the URL asks for.

**`open` is the photo the view is on; `loadedDetail` is the one that has arrived.** They disagree for the length of a fetch, deliberately, and the two questions are different: everything about *where the reader is* - the neighbours the arrow keys offer (`detailIndex`), which library's default applies, whether a response that has just resolved is still wanted - reads `open`, while the panels read what has landed.

`open` is a union, `{ id, status: 'loading' | 'ready' } | { id, status: 'missing', error }`, rather than a detail plus a pair of flags. Every state that cannot happen is then unspellable, which is what the flags kept getting wrong: "nothing loaded and nothing in flight" was indistinguishable from "no such photo", so the first render of every step reported the photo as missing; and "missing" read its message out of the store's shared error slot, which a failed *list* fetch also writes. The reason a read failed now travels with the read that failed.

Nothing reads `loadedDetail` without naming the photo it wants (`detailFor(photoId)`). Six places had to make that comparison by hand and two of them didn't, which is how a stale response came to overwrite the open photo: a detail fetch is not ordered against the one before it, so every write after an `await` also checks `isCurrent` first.

**The previous photo's frame is held for up to 100ms after a step** (`STALE_FRAME_MS`), rather than cleared on the route change. Even a warmed neighbour has to decode, and dropping the old frame first turns that into a blink of stage background on every step. The cap is what keeps it honest: the panels beside the stage already describe the photo in the URL, so a frame held past its decode is the wrong picture rather than a smooth step, and a rendition that has to be *built* would otherwise leave it up for the length of the build. The frame is stored with the photo it belongs to, not as a bare src, because everything gated on "this photo is up" - warming the neighbours, above all - has to tell the held frame from the arrived one.

That hold is only reachable because **the detail page no longer tears itself down between photos**. "Photo not found" was rendered whenever no detail matched the route and nothing was in flight, which is exactly the state of the render that first sees a new id: the fetch starts in the effect *after* it. Every step therefore unmounted the whole page, stage included, for a frame. The page now believes a photo missing only when the read for *that* photo came back empty (`open.status`, above), and `openDetail` marks the read as started synchronously, ahead of the settings load it used to sit behind.

**Both neighbours are warmed by mounted, invisible `<img>`s** rather than detached `new Image()`s, and only once this one is up, so they never compete for the connection with the frame being waited on. Mounted because a decode is for the size an element is *drawn* at: a detached image decodes at natural size, which is the wrong entry, and the visible element then paid for a second decode at paint - the same trap the rendition swap fell into (§10.1). Backwards and forwards, because a cull steps both ways.

**Which rendition the viewer shows is answered without waiting for the photo's detail** (`PhotosStore.showing`). Two facts decide it, and the client holds both before the fetch: the *setting* says which rendition the reader wants, and the *library* says which one was built on import. Deriving either from the detail meant a reader set to the camera's JPEG in a library that renders got the render first - fetched, decoded and painted, lens distortion and all - and swapped out the moment the fetch landed, paying for both files on every step.

The setting can only be trusted for a rendition every photo is certain to have (`isAlwaysBuilt`): the camera's JPEG, extracted from the RAW on demand, and the library's own default, built on import. The other two are built on request, so asking early is a 404 rather than a picture, and they wait for `openDetail`. That same test decides what is worth warming, so the neighbours are only ever fetched at the rendition on screen.

**Both facts it needs are on the row, and neither is read off the detail.** `defaultRendition` reads `preview_source` from the **library**, found through the row's `library_id`, rather than the `default_rendition` the server puts on the detail: the server derives that from exactly the same library setting (§13.2), so this is the same answer a round trip earlier - and it is per photo, which matters in an album spanning two libraries, where the detail on hand belongs to a photo from the other one. `preferredRendition` reads `preview_rendition` from the row for the same reason, which is what lets "last used per photo" answer on the first frame; on the detail alone, that mode painted the library's default and swapped to the reader's own choice a moment later - the original complaint, in the one mode that still had it.

**The page is a layout and seven observers, not one.** The nav, the frame, and each panel read only what they show - the notes box holds its own draft, the triage panel reads the verdict and rating off the row, the camera panel reads the camera fields, the preview panel is the only one that hears a frame decode. As one component they all re-rendered on anything any of them watched: a keystroke in the notes box redrew the stage, and a star redrew the camera settings.

Splitting the components is only half of it, because **`loadedDetail` is deep-observed and written into rather than replaced.** A fresh object notifies everyone reading any part of it, which is what `reconcile` already avoids for grid rows; `patch` therefore assigns the changed fields into the detail the panels are holding, minus `renditions` and `album_ids` - a patch cannot change those, but they arrive as new objects every time and would read as a change to the two components that watch them. A rating click now re-renders the triage panel and nothing else.

A "Thumbnail on screen" panel reports what is actually being displayed (its source, pixel dimensions, format, colour space and encode quality) separately from the original RAW's size and dimensions, because the two are easy to confuse and only one of them is what you are judging sharpness on.

Every metadata panel shows its two most important rows and hides the rest behind a same-size toggle, so each costs the same three lines however much a camera recorded. Download (RAW or JPEG), the rebuild actions and Bin live in the page header beside the prev/next controls, which keeps every action on the photo in one place rather than buried at the bottom of a panel column.

Landing straight on `/photos/:id` used to leave prev/next dead: the neighbours come from the loaded collection, and a deep link has none. Opening the detail with no collection loaded now opens the photo's library as well.

Destructive actions split by reversibility. Binning is undoable, so it just happens and reports with an undo toast wired to `POST /api/photos/restore`. Deleting a library, shoot or album is not undoable, so each asks first via a native `confirm()` that names the specific consequence (removing a library keeps the RAW files but destroys every rating, note, pick and membership).

### 18.6 Thumbnails and the sync strip

Thumbnails are generated asynchronously, so a tile's first request can 404 while processing is still writing the file, and nothing in the page can know when that changes. **The server says so**: `ProcessingService` announces each photo whose renditions it has just written, and `GET /api/events` streams those announcements to every connected client as `event: thumbnail` (`EventsApi`).

**The version is a column, and it travels on the row.** `photos.date_reprocessed` already meant "when were this photo's renditions last written", which is exactly what a URL has to name; it is on `PhotoSummary`, so every view that renders a photo is already holding it. Appending it is the only thing that makes a rebuilt file visible to an `<img>` that has already decoded the old one (§13.5). Remounting the element is not an alternative: three fresh `<img>`s with the same `src` produce one network request between them, because the browser hands the later ones the copy already in its in-memory resource cache without revalidating. The URL itself has to differ.

Everything else follows from it being the server's value rather than something a client made up. It is there on the first render, so there is no plain-URL window to be stale in. It survives a reload, so revisiting a catalogue still revalidates rather than re-downloading. Two browsers agree. And the viewer's warmed neighbours are painted at the URL they were warmed at, because both readings come off the same row - which is the invariant a client-side version could not hold, since whatever held it was keyed by the view rather than by the photo.

**The announcement carries the new value**, not just the fact of a change, so learning about a rebuild costs nothing beyond the event: `PhotosPresenter.renditionsRebuilt` writes it into the row already on screen, and mobx notifies the one tile whose field moved. Nothing is re-fetched to find out what the version became.

Per photo rather than per rendition because a reprocess rewrites or drops all of them together (`dropStaleRenditions`), so a rendition-level version would be three copies of one fact.

**Stamping the row and announcing it are the same act, and both happen where a rendition is written.** Two paths write one: the queue's result handler, which already stamped it (`markProcessed`), and `runOneOff`, which serves the viewer's on-demand build (`POST /photos/:id/renditions/:r`, including the force rebuild that deliberately rewrites a file behind an unchanged URL) and the grid tile repaired on a detail read (§13.2). That second path wrote files without touching the row at all, so it now stamps one too (`touchReprocessed`) - otherwise a client that reloads after a force rebuild reads a version older than the file it names.

**Being told is the fast path, not the only one.** A tile that 404s also retries on a backoff (`RETRY_DELAYS_MS`, shared with the viewer), because delivery is not guaranteed: the stream can be down, or connect a moment after a tile has already asked, or the client can be asleep for longer than the replay buffer. Without that floor a single missed announcement leaves a tile blank for the life of the page, which is the one thing the counter it replaced, crude as it was, did cover.

The tile's retry and the row's version both feed the same suffix, and both are moments, so the newer wins and neither can produce a URL the other has already used - which a URL that repeats itself would turn into a request the browser never makes.

The version is told rather than guessed, and that is the whole point. What it replaced was a pair of global flags: `reloadToken`, bumped on every completed list fetch, so the grid re-requested *all* of its thumbnails whenever anything refetched the list and re-rendered every tile to do it, at a poll a second for the length of an import, which is exactly when the grid is largest and the least of it has changed. The other was `rebuiltAt`, a session timestamp that made every *subsequent* photo in the viewer miss the browser cache once because one photo had been rebuilt.

The stream carries an `id:` per event and keeps the last few hundred in a ring buffer, so a browser reconnecting after a blip replays what it missed through `Last-Event-ID` rather than waiting out the backoff above. An id from a previous run of the server (one at or beyond the current counter) replays nothing rather than the whole buffer; a restart is therefore a gap in the announcements, and the backoff is what closes it. A heartbeat every 20s keeps the connection from being idled out (`idleTimeout`, §index.ts), and waits on the disconnect as well as the timer, so a departed client is dropped at once rather than at the next beat.

The sync status bar renders one cell per photo queued by the current run, filling as `photos_processed` climbs (§9.6). It stops polling as soon as the library reports idle.

**The poll re-reads the grid for rows, not for thumbnails.** It does so while the *scan* is inserting them and once more on the tick that finds the run finished - not through the processing phase, which is the long one. By then the row set is settled and each thumbnail announces itself, so a list request per second would answer with the page the grid already has, filtered and counted over the whole library to say so. The exception is a view filtering on what processing changes ("No thumbnail"), which a refetch is still the only way to learn.

**A refetch that returns the same page changes nothing observable.** `reconcile` writes the server's fields into the row objects already on screen rather than replacing them, and hands back the *same array* when the ids and their order are unchanged; a fresh array notifies everything reading the list, which during a sync is the whole grid, once a second, for a page that did not move. In the same spirit the emptiness checks test `photos.length` before `loading`, so a populated grid short-circuits away its dependency on a flag that toggles twice per fetch.

### 18.7 Running and testing

```bash
cd web && bun install
bun run dev                       # http://localhost:5174, expects the API on :3000
bun run test:e2e                  # Playwright; starts its own API + Vite on :3111/:5199
```

`bun run test:e2e` builds a throwaway library under `/tmp/bowerbird-e2e` from the ARW fixture and drives the real stack, so it needs LibRaw present. `VITE_API_URL` points the client at a non-default API origin.
