| `MATCH_EMBEDDED_JPEG` | `true` | Give renders the camera's own colour and lens correction, fitted per photo against the embedded JPEG; ~+2.4s on a 61MP frame for SDR (§10.8), and again for HDR (§10.8.1) || `POST` | `/api/photos/:id/renditions/:rendition` | Build one rendition on demand: `full` or `max`; `?force=true` drops the cached copy first (§10.1) |# Bowerbird — Design Document

## 1. Overview

Bowerbird is a high-performance RAW photo management and cataloguing backend designed to run on a server or NAS where photos are stored on local spinning disks. It exposes a REST API that a thin client (desktop, mobile, or web) can consume over the network. The web client that ships in this repo is one such consumer; it is a separate app with its own build and dev server, and is described in §18.

**Stage 1 scope:**

- Library management (create, sync)
- Photo listing, filtering, and metadata
- Shoots and albums
- Rendition building (grid + full-size AVIF)
- Streaming access to renditions and original RAW files
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
| RAW decoding | Per-format dispatch (header sniff → fastest reader); Sony ARW and Canon CR3 via LibRaw `bun:ffi` |
| Metadata extraction | LibRaw header parse (no pixel decode), per-format dispatch |
| Testing | Bun's built-in test runner (`bun test`, run via `bun run test`) |
| Logging | `src/logger.ts`, levelled and scoped; `console` is banned everywhere else by lint (§14.3) |
| Package manager | `bun install` (no npm/pnpm/yarn) |

### System Dependencies

- **LibRaw**, must be installed on the host system. The Bun process loads `libraw.so` / `libraw.dylib` via FFI. On Debian/Ubuntu: `apt install libraw-dev`. On macOS: `brew install libraw`.
- **libvips**, the JPEG decode and encode, and nothing else - the resize and blur it used to do are Rust now (§10.4). Not the AVIF encode either; that is libavif's, below. Linked by `native/rawshim` rather than dlopen'd, so it is needed to build as well as to run: `apt install libvips-dev` / `brew install vips`. This is the library sharp used to bundle; see §10.4 for why it moved out of node_modules.
- **ffmpeg**, applies the PQ transfer and encodes the HDR video (§10.7). Needs libzimg for the `zscale` filter and **libaom** for the video; a build missing either cannot produce one. libaom is driven with `-usage allintra`, which is what a one-frame video actually is.
- **libavif**, which encodes every AVIF this app writes, in process (`avif.rs`, §10.7) - so `libavif-dev` at build time and `libavif16` at runtime. ffmpeg's own avif muxer writes no `colr` box and so cannot tag a still as HDR at all, which is the whole reason this library rather than that muxer. `libavif-bin` comes too, for the `avifenc` the linked path is pinned against.

### NPM Dependencies

| Package | Purpose |
|---|---|
| `hono` | Web server and routing |
| `zod` | Schema validation (v4) |
| `@parcel/watcher` | Filesystem watching (§9.8); native, with prebuilt bindings for every platform this runs on |

There is no image-processing package. Everything that touches pixels is in `native/rawshim` (§10.4), which links LibRaw, libvips and libavif directly.

Testing uses Bun's built-in `bun test` runner, so there is no test-framework dependency.

Entity IDs (UUID v4) are generated with the runtime built-in `crypto.randomUUID()`, no third-party UUID package.

RAW decoding and RAW metadata extraction are **dispatched per format**: a cheap header sniff (magic bytes / EXIF `Make`) selects the fastest maintained reader for that format, so each format can use its optimal library rather than a single lowest-common-denominator one. Sony ARW and Canon CR3 both decode via LibRaw (fast, actively maintained), so the dispatch currently resolves to one reader. Additional formats are added by registering another reader behind the same interface; Sony RAW is the priority when a reader supports only a subset of formats.

No other third-party dependencies should be added without explicit approval.

---

## 3. Project Structure

```
bowerbird/
├── src/
│   ├── index.ts                    # Entry point: creates Hono app, wires dependencies, starts server
│   ├── logger.ts                   # Levelled logging; the only module allowed to touch console (§14.3)
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
│   │   │   ├── folder_rules_repository.ts   # excluded / plain folders (§4.7)
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
│   │       ├── processing_service.ts  # Rendition generation orchestrator
│   │       ├── processing_worker.ts   # Bun worker thread for image processing
│   │       ├── raw_decoder.ts         # LibRaw FFI bindings
│   │       ├── metadata.ts            # Per-format metadata extraction (LibRaw header parse)
│   │       └── tests/
│   │           └── processing_service.test.ts   # (raw_decoder/metadata: integration-tested via LibRaw)
│   └── utils/
│       ├── hash.ts                 # File hash computation
│       ├── files.ts                # File system helpers (recursive listing, etc.)
│       ├── scope.ts                # Is this path part of this library (§9.1); scan and watcher share it
│       └── paths.ts                # Path computation helpers (rendition paths, bin paths)
├── test/
│   ├── integration/               # bun:test suites needing real bun:sqlite + LibRaw (run in-container)
│   └── fixtures/                  # one real file per format (ARW, CR3) for decode/metadata tests
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
  name        TEXT NOT NULL,  -- display name; create stores the folder name (or parent + year) when none is given
  ordering    TEXT NOT NULL DEFAULT 'taken_asc'
    CHECK (ordering IN ('taken_asc', 'taken_desc', 'added_asc', 'added_desc')),
  -- How much of the folder tree this library is, and whether its folders are
  -- shoots (§4.7).
  include_subfolders INTEGER NOT NULL DEFAULT 1,
  mirror_shoots      INTEGER NOT NULL DEFAULT 1,
  bin_name    TEXT NOT NULL DEFAULT 'Bin'  -- folder soft-deleted RAWs move into, and the name the scan skips (§12.3)
);
```

- `root_path`, absolute path to the library root folder on disk.
- `data_path`, absolute path to the data directory for generated files. If NULL, defaults to `<root_path>/.bowerbird/`.
- `name`, what the library is called in the rail and in Settings. Required. On create, an omitted or blank name is filled from the root folder and stored: the last path segment, or when that segment is a four-digit year, `"<parent> <year>"` so date-sorted trees do not all show as `"2025"`. Renaming the folder on disk afterwards does not change the stored name.
- `ordering`, default ordering for photo listings in this library.
- `include_subfolders`, whether the scan descends past the root at all (§9.1). A standing rule rather than a decision taken once at import: a folder created next month is out of scope for the same reason today's are, so turning it off writes no `folder_rules` rows and never needs revisiting. Off makes shoots meaningless for the library - a shoot *is* a subfolder, and its photos would never be scanned - so the UI disables the Shoots section and forces `mirror_shoots` off with that as the reason.
- `mirror_shoots`, whether sync keeps shoots in step with the folders on disk (§9.4.1). On, every folder holding photos is a shoot and the catalogue cannot disagree with the tree; off, a shoot exists only where the user made one, and untracked folders are offered on the Shoots page instead (§18.3.4).
- `bin_name`, what this library's bin folder is called at its root (§12.3). Per library rather than a constant because the name is also what the scan skips: a root that already keeps a folder called `Bin` would otherwise have it adopted as the bin, and everything inside it dropped from the import with nothing said. `POST /api/libraries` refuses a root already holding a folder of this name and the Add-library dialog marks the field, so the collision is settled while the name is still being chosen. Create-only, and deliberately absent from `PATCH`: renaming it later would strand every already-binned RAW in a folder the scan would then walk straight back in.

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
  orientation       INTEGER NOT NULL DEFAULT 0,  -- LibRaw flip orientation code; informational + hash input only, NOT to be applied to renditions (§11)
  is_missing        INTEGER NOT NULL DEFAULT 0,
  is_deleted        INTEGER NOT NULL DEFAULT 0,
  date_taken        TEXT,
  date_added        TEXT NOT NULL,
  date_updated      TEXT,  -- last modified on disk
  -- One pending flag and one written-at stamp per import stage (10.2): the grid
  -- tile the gallery shows, then the photo viewer's renditions. Split so a run
  -- interrupted between them resumes at the one it did not reach, and so a URL
  -- versioned off a stamp moves only when its own file did (13.5).
  needs_tile        INTEGER NOT NULL DEFAULT 1,
  needs_renditions  INTEGER NOT NULL DEFAULT 1,
  tile_built_at     TEXT,
  renditions_built_at TEXT,
  processing_error  TEXT,  -- last rendition-generation error; NULL if none/succeeded (§10.2)
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
CREATE INDEX idx_photos_needs_tile ON photos(needs_tile) WHERE needs_tile = 1;
CREATE INDEX idx_photos_needs_renditions ON photos(needs_renditions) WHERE needs_renditions = 1;
CREATE INDEX idx_photos_is_missing ON photos(library_id, is_missing) WHERE is_missing = 1;
CREATE INDEX idx_photos_is_deleted ON photos(library_id, is_deleted) WHERE is_deleted = 1;
```

- The `_order_` composite indexes serve the library and shoot list orderings (§5.1, §8.2 `listByLibrary`/`listByShoot`), and they are keyed **exactly as `orderByClause` spells the sort**: `(collection, is_deleted, <sort expression>, id)`, with the `taken_*` pair leading on the indexed `(date_taken IS NULL)` expression so the NULL-last grouping is part of the key rather than something evaluated per row. Getting this wrong is expensive in a way a pager hid: the `id` tiebreak that makes paging a total order (§18.3.3) is not optional, and an index without it sent every one of the four orderings through `USE TEMP B-TREE FOR ORDER BY` - a sort of the whole library **per request**, measured at 927ms for one block of a million-photo library, on a scroll that asks for ten thousand blocks. Keyed to match, all four plan as `SEARCH … USING COVERING INDEX` with no b-tree, and the same block costs 0ms.
  - The `id` tiebreak follows the direction of its sort (`… DESC, id DESC`), so `added_desc` is the ascending index walked backwards rather than a second index. `taken_desc` is the one ordering that genuinely differs by direction - NULLs stay last while the dates reverse - so it is the only one given a `_desc` twin.
  - `is_deleted` sits ahead of the sort columns because every listing filters on it, which keeps a deep `OFFSET` inside the index instead of probing the table for each row it skips: 326ms rather than 1097ms to reach position 900,000 of a million.
  - `SELECT COUNT(*)` is the other half, and no ordering index can cover it - the filter chips vary, so it is a scan of everything that matches: **774ms of a 792ms block fetch** at a million photos. So a listing only counts when asked to (`count`, §5.3), and `PhotoListResponse.total` is absent when it was not. Nothing can change the count without starting a new pass over the collection - a filter, a sort, a bin, a scan tick all go through `refresh` - so the client asks on the first block of each pass and reuses the answer for the rest (§18.3.2). The number on screen is exactly as fresh as it was; it is simply not recomputed ten thousand times per scroll.
  - Album listings (`listByAlbum`, §8.2) are not covered: albums have no `library_id` (§4.4) so they span arbitrary photos, and `album_photos` is keyed only on `(album_id, photo_id)` (§4.5), so neither the date composites nor the album PK anchor an album-scoped ordering; these listings therefore incur a filesort, accepted as albums are typically small.

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
  -- The folder's identity independent of its name, so a rename on disk is
  -- recognised rather than read as a delete plus a create (§9.4.1).
  folder_ino        INTEGER,
  folder_birthtime  REAL,
  UNIQUE (library_id, folder_path)
);

CREATE INDEX idx_shoots_library ON shoots(library_id);
CREATE INDEX idx_shoots_parent ON shoots(parent_id);
```

- `folder_path` is the **full** path from the library root to this shoot's folder (forward slashes), e.g. `Weddings/2024/Smith`. It is *not* parent-relative: storing the full path lets sync reconciliation (§9.4) and create-adoption (§8.5) test membership with a `file_path` prefix check, and lets the most-specific (longest matching) shoot win for nested folders. On create it is the requested `parent_path` plus the name, and `parent_id` is then read back off it (§8.5) rather than chosen alongside it. Nothing *in the app* rewrites it afterwards: `name` seeds the folder once and is a label from then on, so renaming a shoot never moves a file (§8.5). It does follow the folder when the folder itself moves **on disk**, which is the one writer (§9.5).
- **Membership test (used everywhere "a file falls under a shoot" is checked):** a file belongs to a shoot iff `file_path` starts with `folder_path + '/'`; the trailing separator is required so shoot `NYC` (`folder_path` `NYC`) does not capture files in sibling shoot `NYC2`. "Directly under" a shoot means the remainder after that prefix contains no further `/` (deeper files belong to a descendant shoot). Among all matching shoots, the one with the longest `folder_path` wins.
- When a photo is added to a shoot, its file is physically moved on disk into the shoot's folder.
- **A shoot is identified by its folder, not by its name** (`UNIQUE (library_id, folder_path)`). The folder is the thing that exists; the name is a label on it. Names were once unique library-wide, which mirroring (§9.5) makes simply false to disk: a tree with `NYC/Day1` and `LA/Day1` is ordinary, and a constraint that rejects it would have the catalogue refusing to describe folders the user already has. Uniqueness on `folder_path` is also *tighter* against the collision the old constraint was defending, two shoots sharing one folder, since that is the collision stated directly rather than inferred from names. Renaming a shoot therefore never conflicts.
- `folder_dev`, `folder_ino` and `folder_birthtime` are the folder's identity independent of its path, `stat`'s `dev`, `ino` and `birthtimeMs`, recorded on create and refreshed on every scan that sees the folder. A rename preserves all three (verified on ZFS; POSIX guarantees the inode across a `rename(2)` within a filesystem), so a shoot whose folder_path has gone can be found again wherever it now sits (§9.4.1), including one holding no photos at all. **`dev` is half the key, not a detail:** inode numbers are unique only within one filesystem, so a library with a card reader or a share mounted inside it would otherwise match a dead shoot against an unrelated folder on the other volume and rewrite every one of its photos' paths onto it. `birthtime` is the third guard, against a recycled inode number, and is advisory: some filesystems report `0`, so it only rejects a match when both values are non-zero. All three are NULL for a shoot whose folder has never been scanned, and a move across filesystems changes the inode, which is what the fallback in §9.4.1 is for.
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
- These tables hold a **choice**, never a default. A shoot with no row falls back to its first photo in the shoot's own ordering, computed in the `SELECT` (`shoots_repository.ts`) rather than written at import. The first photo moves as photos are added, binned or re-dated, so a stored default would go stale, and once stored it could no longer be told apart from a photo the user actually picked. Binned photos are excluded, so the banner agrees with the photo count beside it. A row here still wins, and deleting it returns the shoot to its first photo rather than to no banner at all.

### 4.7 `folder_rules` table

```sql
CREATE TABLE folder_rules (
  library_id   TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  folder_path  TEXT NOT NULL,  -- root-relative, forward slashes, no trailing separator
  rule         TEXT NOT NULL CHECK (rule IN ('excluded', 'plain')),
  PRIMARY KEY (library_id, folder_path)
);
```

The exceptions to what the two library settings (§4.1) say in general. Both are the user overruling a default about one folder, so they are one table with one primary key rather than two lists that could disagree about the same path.

- **`excluded`**, the folder is not scanned, so nothing inside it is in the catalogue. Subtree-wide by construction: a folder that is never walked has no children to consider. This is the folder of rejects triaged years before the library existed, and the rest of the tree that is not photographs.
- **`plain`**, the folder is scanned normally and its photos are in the library, but mirroring will not make it a shoot. Per-folder and **not** inherited: declaring `A` plain leaves `A/B` free to be a shoot, since "this folder is not a set of photographs" says nothing about what is filed beneath it.
- A `plain` rule is what makes "delete this shoot but keep its photos" survive the next sync; without it, mirroring would recreate the shoot within seconds and the delete would read as broken (§8.5).
- Both rules are recorded whether or not `mirror_shoots` is on, because deleting a shoot is a statement about the folder rather than about the current setting, and turning mirroring on later should not resurrect a shoot the user has already dismissed.
- The `PRIMARY KEY` means one rule per folder: `excluded` and `plain` are answers to the same question ("what is this folder to the library"), so the second write replaces the first rather than stacking.

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
  name: z.string().trim().optional(),          // blank: store the inferred folder name (§4.1)
  ordering: OrderingSchema.default('taken_asc'),
  include_subfolders: z.boolean().default(true),  // §4.1
  mirror_shoots: z.boolean().default(true),
  bin_name: BinNameSchema.default('Bin'),      // one folder name, not a path (§12.3)
});

export const LibrarySchema = z.object({
  id: UuidSchema,
  root_path: z.string(),
  data_path: z.string().nullable(),
  bin_name: z.string(),
  name: z.string().min(1),
  ordering: OrderingSchema,
  rendition_source: RenditionSourceSchema,
  rendition_hdr: z.boolean(),
  rendition_hdr_video: z.boolean(),
  include_subfolders: z.boolean(),
  mirror_shoots: z.boolean(),
  last_synced_at: z.string().nullable(),
  photo_count: z.number().int(),
});

// Every field optional: the settings UI changes one control at a time, and a
// partial update must not reset the others to their defaults.
export const UpdateLibraryRequestSchema = LibrarySchema
  .pick({ ordering: true, rendition_source: true, rendition_hdr: true, rendition_hdr_video: true,
          include_subfolders: true, mirror_shoots: true })
  .extend({ name: z.string().trim().min(1) })
  .partial();

export const FolderRuleSchema = z.object({           // §4.7
  folder_path: z.string(),
  rule: z.enum(['excluded', 'plain']),
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
  width: z.number().int().positive(),   // display/upright dims, match the served rendition
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
  orientation: z.number().int(),  // LibRaw flip orientation code; informational only, renditions are already upright (§11), do NOT rotate them by this
  date_taken: z.string().nullable(),
  date_added: z.string(),
  date_updated: z.string().nullable(),
  tile_built_at: z.string().nullable(),
  renditions_built_at: z.string().nullable(),
  needs_tile: z.boolean(),
  needs_renditions: z.boolean(),
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
  ordering: OrderingSchema, // the ordering this page was built in (§18.3.1)
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
    needs_tile: z.stringbool().optional(),
  });

// What a bulk action applies to. The same filters as a list query, in JSON
// rather than in a query string, plus runs of positions in the collection they
// describe (§18.3.3). No ordering: the collection owns that (§18.3.1).
export const PhotoSelectionSchema = z.object({
  scope: z.discriminatedUnion('kind', [ /* library | shoot | album */ ]),
  filters: PhotoFiltersSchema.default({}),
  ranges: z.array(z.object({ start: z.number().int().min(0), end: z.number().int().min(0) })).min(1).max(10_000),
});

export const PhotoTargetSchema = z.union([PhotoIdListSchema, z.object({ selection: PhotoSelectionSchema })]);
```

### 5.4 `shoots.ts`

```typescript
export const CreateShootRequestSchema = z.object({
  library_id: UuidSchema,
  parent_path: z.string().default(''),  // root-relative folder the shoot's folder goes in; '' is the library root
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

// What becomes of the photographs, asked rather than assumed (§8.5). The
// reversible answer is the default: 'remove' takes rows and renditions with it.
export const DeleteShootQuerySchema = z.object({
  photos: z.enum(['keep', 'remove']).default('keep'),
});
```

`folder_ino` / `folder_birthtime` (§4.3) are not in the response: they are how the server recognises a folder through a rename, and mean nothing to a client.

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
```

### Path Resolution

```typescript
function getDataPath(library: Library): string {
  return library.data_path ?? path.join(library.root_path, '.bowerbird');
}

// Originals, so outside the data directory (§12.3). One bin at the library root,
// laid out inside itself like the library around it: `relFolder` is the folder a
// photo was binned from, empty for one binned from the root. The only place the
// bin's name is spelled, so a second spelling cannot disagree with the scan.
function getBinPath(library: Library, relFolder = ''): string {
  return path.join(library.root_path, library.bin_name, relFolder);
}
```

### Sync Exclusion

The scanner must skip the data directory (`.bowerbird/` or whatever `data_path` points to if it is a subdirectory of the library root) when recursively listing files. It should also skip any directory named `.bowerbird` to avoid picking up nested data directories.

This is one of five rules that together answer "is this path part of this library", alongside hidden directories, the library's bin (§12.3), its `include_subfolders` setting (§4.1) and its `excluded` folders (§4.7). They live together in `isInScope` (§9.1) rather than being restated by each caller, because the scan and the watcher answering it differently is not a visible failure - it is a folder that quietly still wakes syncs, or a sync queued for paths the scan will discard.

---

## 7. Supported File Formats

Sony ARW (`.arw`) and Canon CR2/CR3 (`.cr2`, `.cr3`), case-insensitive.

The sync scanner matches files by extension. All other files are silently ignored. The extension set is the *scan filter*; the actual decoder/metadata reader is chosen later by header sniff (§10, §11), so a further format is added by registering a reader plus extending this set. The same table carries the media type the original is served under (§13.5).

The table is the *only* gate, because everything asking "is this one of ours" goes through `isSupportedFile`: the full walk, the watcher (both the event it acts on and the scoped sync's paths), and `findOriginalsAnywhere`, which is what carries a stray original out of a data directory before that directory is deleted (§8.1). A format added here is therefore both ingested and protected from that sweep, in one edit; one added to only half of them would be imported and then deleted with the renditions.

```typescript
const RAW_MEDIA_TYPES = new Map([
  ['.arw', 'image/x-sony-arw'],
  ['.cr2', 'image/x-canon-cr2'],
  ['.cr3', 'image/x-canon-cr3'],
]);

function isSupportedFile(filename: string): boolean {
  return RAW_MEDIA_TYPES.has(path.extname(filename).toLowerCase());
}
```

**Canon needed no second reader, and that is the point of the split.** LibRaw decodes CR3 and parses its header like any other format, so the decode, the embedded preview, the exposure and the body and lens names all arrived working. Three things did not, and each is a place the ARW-only assumption had hardened into code rather than a Canon feature:

- **The capture zone.** `exif_zone.ts` read the offset tags straight out of the TIFF header a RAW "already is". A CR3 is an ISO base-media file; its EXIF sits in a `CMT2` box under `moov`, as a complete little TIFF of its own. Walking the box tree that far and handing the block to the same IFD reader is the whole of it (§11.1).
- **The masked-border crop.** Measured against the raw frame rather than against the window LibRaw already emits, so on every body that declares an inset crop - which is every Canon - it was applied twice. See §10.4.
- **GPS.** Canon reports a parsed fix on every frame and zeroes it when there was none, which read as 0,0: a real place, in the Gulf of Guinea. An all-zero triple is now "not recorded".

**CR2 came for free on top of that**, and is the case the split was meant to make cheap: it is a plain TIFF, so the capture-zone reader takes its first branch rather than the box walk, and the crop and GPS fixes above are per-body rather than per-format. Verified on EOS 600D frames - 18MP at the dimensions the header states, portrait orientation, lens and exposure, and an embedded JPEG for the grid tile. A 2011 body predates EXIF 2.31, so it records no capture zone at all and reports `null`, which is the absence the tag is nullable for rather than anything unread.

**CR2 is not in the set.** It is TIFF-based and LibRaw reads it, so it is likely a one-line addition, but nothing here has been run against one.

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

**Constructor dependencies:** `PhotosRepository`, `AlbumsRepository`, `ShootsRepository`, `LibrariesRepository`. `delete()` needs the library for its root and `bin_name`; the bin path then follows from the photo's own `file_path` and asks no shoot anything (§12.3).

**Methods:**

| Method | Description |
|---|---|
| `get(photoId)` | Returns full photo detail by ID. |
| `listByLibrary(libraryId, pagination, filters?)` | Returns paginated `PhotoSummary` list for a library. Excludes soft-deleted photos unless `include_deleted` is set (§13.2). Supports optional `is_missing` and `needs_tile` filters. Ordering is determined by the library's `ordering` setting, with NULL ordering dates sorted last. |
| `listByShoot(shootId, pagination, filters?)` | Returns paginated `PhotoSummary` list for a shoot. Accepts the same `include_deleted` filter (§13.2), excluding soft-deleted by default. |
| `listByAlbum(albumId, pagination, filters?)` | Returns paginated `PhotoSummary` list for an album. Accepts the same `include_deleted` filter, excluding soft-deleted by default. |
| `listMissing(libraryId, pagination)` | Convenience method: calls `listByLibrary` with `is_missing: true` filter. |
| `update(photoId, updates)` | Updates mutable fields: `rating`, `triage`, `notes`. |
| `delete(photoIds)` | Soft-deletes photos: moves RAW files to Bin, sets `is_deleted = 1`. Renditions are kept so the Bin stays browsable. See §12. |
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
| `processUnprocessed(libraryId?)` | Queries for photos owing either stage (`needs_tile` or `needs_renditions`) with `is_missing = 0`, spawns Bun worker threads (up to configured concurrency) to generate them. Each stage clears its own flag and stamps its own `*_built_at` as it lands. |
| `processPhoto(photoId)` | Processes a single photo on the main thread: resolves the raw file and rendition output paths from the repositories, dispatches the job to a worker (§10.2, §10.3), and persists the result. |
| `getProcessingStatus(libraryId)` | Returns count of photos pending/completed processing. |

### 8.5 Shoots Service (`shoots_service.ts`)

**Constructor dependencies:** `ShootsRepository`, `PhotosRepository`, `LibrariesRepository`

**Methods:**

| Method | Description |
|---|---|
| `create(request)` | Creates a shoot record. The folder is named after the shoot `name`, created inside `parent_path` (the library root when it is empty); `folder_path` is stored as the full root-relative path (§4.3). A `parent_path` that resolves outside the library root, or inside its data directory (§6), is refused: a shoot's photographs must be inside the library and must not be in the tree that goes with it when it is removed. `parent_id` is **derived**, not requested: it is the most-specific shoot whose folder contains the new one, which is the same rule that decides which shoot a photo belongs to (§9.4), so the tree can never disagree with the folders on disk. That also means a shoot can sit under a plain folder that is not a shoot itself. If the folder does not exist, it is created. If it **already exists**, it is kept as-is and its photos are **adopted**: every existing non-deleted photo record whose `file_path` falls under this folder and for which this shoot is the most-specific matching shoot (i.e. not already claimed by a more-specific descendant shoot) has its `shoot_id` set to the new shoot. No files move on disk and no reprocessing occurs (renditions are keyed by photo UUID, unaffected by shoot membership). This mirrors the sync reconciliation rule (§9.4) and makes an orphaned folder from a prior shoot delete re-adoptable. RAW files physically present but not yet in the DB are picked up by the next sync, which will assign them to this shoot via the same reconciliation. The folder is `stat`ed either way and its identity recorded (§4.3), so a shoot can be followed through a rename from the moment it exists rather than from its first scan. Creating a shoot for a folder that carries a `plain` or `excluded` rule (§4.7) clears that rule: the user is answering the same question again, the other way. |
| `get(shootId)` | Returns a shoot by ID. |
| `list(libraryId)` | Returns all shoots in a library. |
| `addPhotos(shootId, photoIds)` | Moves photo files on disk into the shoot's folder. Updates each photo's `file_path` and `shoot_id` in the DB. A photo can only belong to one shoot; if it already belongs to another, it is moved out of the old shoot folder. If a file with the same name already exists in the destination folder, append a numeric suffix (e.g. `IMG_0001_1.ARW`, `IMG_0001_2.ARW`) so no existing file is overwritten and no two records share a `file_path` (§12.1). |
| `removePhotos(shootId, photoIds)` | Moves photo files back to the library root. Updates each photo's `file_path` and clears its `shoot_id`. If a file with the same name already exists in the library root, append a numeric suffix (e.g. `IMG_0001_1.ARW`, `IMG_0001_2.ARW`) so no existing file is overwritten and no two records share a `file_path` (§12.1). |
| `delete(shootId, photos)` | Deletes the shoot record. **No files or folders on disk are touched** (see principle above), whichever disposition is chosen. Shoots *beneath* it survive: they are re-parented onto its own parent first, because `parent_id` cascades and mirroring would otherwise rebuild those folders as fresh shoots with default names, losing every label, description, banner and ordering they had. `photos: 'keep'` leaves every photo in the library and clears its `shoot_id` via `ON DELETE SET NULL`, writing a `plain` rule (§4.7) so mirroring does not recreate the shoot on the next sync. `photos: 'remove'` writes an `excluded` rule instead and **hard-deletes** the photo rows under the folder, along with their renditions (via `deletions.ts`, §10.6.1, rather than waiting for the sweep). The originals stay exactly where they are on disk; what goes is the catalogue's record of them, and with it their ratings, verdicts and notes. Clearing the rule later re-imports them as new photos, with new ids and rebuilt renditions. |
| `update(shootId, updates)` | Updates mutable fields: `name`, `description`, `ordering`. A **name change is metadata only**: the name is a label, so nothing moves on disk and no `folder_path` or `file_path` is rewritten, and it cannot conflict, since a shoot is identified by its folder rather than its name (§4.3). Setting `banner_photo_id` upserts the `shoot_banners` row; clearing it (null) deletes that row; it is not a column on `shoots` (§4.6). |

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
2. List all files under `root_path`, descending into subfolders only when the library's `include_subfolders` is set (§4.1), and skipping:
   - The data directory (`.bowerbird/` or custom `data_path` if it's under `root_path`).
   - Any hidden directories (starting with `.`).
   - The library's bin, `<root>/<bin_name>` and everything under it (§12.3), so soft-deleted files are never re-imported. Anchored at the root, unlike the rules above it: that is the only place a bin is ever made, and matching the name at every depth would take a folder of the user's own called `Bin` out of the library in silence.
   - Any directory carrying an `excluded` rule (§4.7), and therefore everything beneath it.

   These five questions live together in `src/utils/scope.ts`, and the **watcher asks them too** (§9.8). It had its own copy of the first three rules, which is two lists to keep in agreement about what the library contains; with the last two added the cost of them drifting is a folder the user excluded still waking a sync on every change, and scoped syncs queued for paths the scan will then ignore.

   They split in two, and the split is not cosmetic. Four of them read the path alone and answer the same whether what sits there is a file or a folder, since each is about a *segment*: that is `isPathAllowed`. Only `include_subfolders` needs to know which it is looking at, because a root-only library keeps the files in its root and discards the folders beside them - the same string answers differently depending on what it names. The scan always knows what it is looking at, so `isDirInScope` is the two halves together. A watcher event names a path and not what kind of thing is at it, so the watcher asks `isPathAllowed` and settles the remaining question for files alone; a stray folder path costs nothing downstream, because the scoped sync tests it with `isDirInScope` before reading it.
3. Filter to supported extensions only (`.arw`, `.cr3`). This yields the set of **present** file paths.
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

1. File extension (lowercase, e.g. `.arw`, `.cr3`)
2. Image width (pixels)
3. Image height (pixels)
4. Date modified (filesystem mtime, ISO string)
5. Color space (string identifier; the constant sRGB output space, see §11.1)
6. File size in bytes
7. Orientation/rotation (LibRaw `flip` orientation code, or `0` if not present)

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

1. **Moves:** Update `file_path` for each moved photo. Clear `is_missing` if it was set. **Reconcile shoot membership from the destination path:** if `newFilePath` falls under a known shoot's `folder_path`, set the photo's `shoot_id` to the **most-specific (longest-matching) `folder_path`** shoot (so a file under `NYC/Day1` maps to `Day1`, not the ancestor `NYC`); if it moved out to the library root (or a non-shoot folder), clear `shoot_id`. This keeps DB shoot membership consistent with files the user relocated on disk directly (rather than via the shoots API).
2. **Modifications:** Update `file_hash`, `width`, `height`, `orientation`, `date_updated`, and both pending flags for each modified photo, plus any other changed metadata columns (GPS, `date_taken`). Clear `is_missing` if it was set.
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
   - `needs_tile = 1`, `needs_renditions = 1`
   - `is_missing = 0`
   - `is_deleted = 0`
   - `rating = 0`
   - `triage = NULL`
4. **Reappearances:** Clear `is_missing = 0` for each reappeared photo. No other change (content and path are unchanged).
5. **Removals:** Set `is_missing = 1` for each removed photo. Do not delete files or records. Count only photos that transition `is_missing` from `0` to `1` toward `photos_removed`; a record already at `is_missing = 1` reappears in the removed list every scan (so delayed move-matching in §9.3 can still pair it), but it is not a new removal and must not be re-counted. This keeps `photos_removed` a per-sync delta consistent with `photos_added`/`photos_moved`/`photos_modified`.

**A run with no rows commits as it scans, in batches of 1000.** A first import is hours of opening and hashing, and one closing transaction makes all of it contingent on reaching the end: kill the server at hour three and three hours of decodes are gone, with the next run starting from nothing. Applying a *partial* scan is normally unsafe for the reason §9.10 gives (absence from a half-built `present` set reads as a removal), but that reasoning needs rows to be absent from. When `dbPhotos` is empty (a library's first sync, and a scoped sync whose paths are all new) the diff can only be additions: no removal can be derived, so no move can pair either. Each batch is then true on its own, whatever the scan goes on to find, and a killed import resumes at the batch it reached rather than at zero; the rows it wrote carry the mtime and size that make §9.1's quick-check skip them, so the resumed scan does not re-open them either.

Only that case qualifies. Against a populated library an addition can still turn out to be the far half of a move, so its inserts stay in the closing transaction where move detection can still claim them. Shoot membership is safe to resolve early for the same reason a batch is: a shoot relocation (§9.4.1) takes existing photos to move, and a run with no rows has none.

### 9.4.1 Shoot reconciliation

Two steps wrap the apply phase, and both exist because **the folders on disk are the truth and the shoots are the catalogue's account of them**. Relocation runs *before* step 1, so membership is resolved against corrected paths rather than being cleared and rebuilt; mirroring runs *after* the transaction, once the scan's folders and photo counts are settled.

**Relocation: a shoot's folder moved.** Nothing on disk distinguishes a renamed folder from one deleted and another created, and the watcher cannot help - the kernel pairs the two halves of a rename with a cookie that no portable JS watcher exposes. Two independent answers, tried in order:

1. **The inode.** A shoot records its folder's `ino` and `birthtimeMs` (§4.3), and the scan already walks every directory, so it can key them by `dev:ino` as it goes (the same key `scanFiles` uses to collapse hardlink pairs). A shoot whose `folder_path` is gone, whose recorded identity turns up at another path, **is** that folder: not an inference, so no time window, no all-or-nothing photo test, and no need for the folder to hold any photos. It resolves a rename made while the server was down just as well as one made while it was running, which no watcher event can do.
2. **The photos** (`detectShootRelocations`, `sync_algorithm.ts`). If every file that was under `A/` is now under `B/`, each keeping its position within the folder, then `A` became `B`. Deliberately all-or-nothing: a partial match means files were also added, removed or reshuffled, so the folder's identity is genuinely ambiguous and a wrong guess silently adopts someone else's folder. `folderStillOnDisk` separates a folder that moved from photos merely reorganised inside one that did not - sorting a shoot's frames into a new `Selects/` subfolder moves every one of them keeping each filename, which is indistinguishable from a rename by the paths alone.

The second is not redundant once the first exists: a move to **another filesystem** (a copy under the covers) mints a new inode, and so does a restore from backup, where every inode in the library is new at once. The inode answers precisely, the photos answer approximately, and the cheap precise one is asked first.

Either way the whole subtree follows by prefix, and descendant shoots come with it. A relocated shoot also answers every photo move beneath it at once - the paths shift by a prefix and membership does not change - so those moves drop out of the per-photo loop and the folder becomes two `UPDATE`s rather than one per frame.

**The gap this leaves**, deliberately: create `B`, copy the photos over, then delete `A`, *while the server is running*. The sync after the copy imports `B` as new photos while `A` still exists, so when `A` goes there are no additions left to pair with its removals. No moves, therefore no relocation by either route - the shoot's photos go `is_missing` and the copies in `B` belong to no shoot. Reconciling that is a photo-level problem rather than a shoot-level one (the same thing happens to a single photo copied and deleted with no shoot involved), so it belongs to the deferred flow that lets the user pair a missing photo with its counterpart, not here. Done in one `mv`, or with the server down, it is a single diff and route 2 handles it.

**Mirroring: folders become shoots.** With `mirror_shoots` set (§4.1), after the transaction:

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
  status: 'idle' | 'scanning' | 'processing';
  photosToScan: number;
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

**Both phases of a run report progress, not just the second one.** `photosProcessed` against what was queued covers rendition building; `photosScanned` against `photosToScan` covers the scan, which on a first import is the longer of the two: minutes of opening and hashing every file, during which a status that only carried zeros left the client with nothing to say but "scanning". The counters are updated from the loop that opens and hashes, which is where a scan's whole cost is (the `stat` pass before it opens nothing), and `photosToScan` is only known once that pass has collapsed hardlink pairs, so a run reads 0/0 for the walk and the stats, then counts through the files. Both settle on the number of files found, so the client renders one bar per phase off the same pair of numbers.

No generation guard on those writes, unlike the ones after the scan: the sync lock is not released until scan and apply are both done, so no newer generation of the same library can exist to stomp.

**A process with no status in memory reads the outstanding work off the database.** The status object does not survive a restart, but the work does: `needs_tile` / `needs_renditions` are columns, so a library the last process had half-imported comes back owing exactly what it owed. Reporting a flat `idle` with zeros there is a lie the client cannot see past; the strip would show nothing to do while thousands of renditions were missing. `getSyncStatus` therefore falls back to `countPendingProcessing` and reports it as `photosProcessing` against `idle`: work waiting, not work running.

**Nothing starts it.** Startup wires the watcher, the daily reconcile and the prune, and triggers no sync (`src/index.ts`); reading the status does not either. A restart mid-import resumes when the user asks, when the watcher sees a file change, or at `SYNC_FULL_AT`, and the status is what tells them there is something to ask for. Automatic resume would mean a server that comes back up saturating its cores on a job the user may have killed it to stop.

`last_synced_at` is the other half of this, and the durable one: it is a column, so it survives the restart the status does not, and says how stale the catalogue is (§4.1).

### 9.7 Sync Lock

Sync is locked **per library**, so two different libraries can sync concurrently while the same library cannot be synced twice at once. The lock is a **file at the library root**, `<root_path>/.bowerbird-sync.lock`, created with exclusive semantics (`open` with `O_CREAT | O_EXCL`, i.e. Bun/Node `wx` flag) and holding the owning PID and an ISO start timestamp. (It is a hidden file with no RAW extension, so the scanner ignores it regardless.)

- `syncLibrary(id)` acquires that library's lock; if already held it throws `SYNC_IN_PROGRESS` (409).
- `syncAll()` acquires each library's lock independently as it processes it; a library whose lock is already held is skipped (and logged), and the remaining libraries proceed.
- **Stale-lock recovery:** if the lock exists but its PID is no longer alive (crash during a prior sync), it is reclaimed rather than blocking forever.
- The lock is released (file removed) in a `finally` so it is cleared on both success and error.

The in-memory `SyncStatus` (§9.6) is process-local and lost on restart; the per-library lock file is the cross-process source of truth for "is this library syncing".

### 9.8 Sync Triggers: Manual, Scoped Watcher, Daily Backstop

`syncLibrary` runs in three ways:

1. **Manual**, `POST /api/libraries/:id/sync`. A full scan (whole tree).
2. **Scoped (watcher)**, the `LibraryWatcher` accumulates the changed relative paths in each debounce window and calls `syncLibrary(id, scopePaths)`. A scoped sync **does not walk the tree, and does not read a directory either**: it stats the changed paths themselves and reconciles them against the DB rows at those paths, plus every already-missing row (the move-source pool). Its cost scales with the number of changed paths, not with library size and not with how many photographs sit beside them.
   - File-scoped, because the watcher names both halves of a move (§9.8). It used to `readdir` each changed path's parent, which found a target that was never reported - insurance against an event stream that had already been chosen for reporting both halves, paid for on every scoped run by reading a directory that may hold thousands of frames. A move whose halves land in different windows still pairs, through the missing pool rather than through the directory.
   - The failure it gives up on is visible and repairable: a target nothing reported leaves the photograph flagged missing in the UI, and a manual sync (or the nightly full reconcile) restores it. Which is also what a modification nothing reported does, and what every change made while the server was down does.
   - A debounce window with more than 256 distinct changed paths (bulk import) falls back to a full sync.
3. **Daily full reconcile**, `DailySync` runs `syncAll()` once a day at `SYNC_FULL_AT` (local `HH:MM`, default `03:00`, `""` disables), overlap-guarded and re-scheduled each day so it holds its wall-clock time across DST. This is the correctness **backstop** for anything the event-driven watcher missed: dropped or coalesced events, and every edit made while the server was down. It's overnight by default because a full scan holds the library mutex (§9.9) for its whole duration.

**The watcher is `@parcel/watcher`, not `node:fs` and not `chokidar`.** Two independent requirements, and only one library meets both.

*It has to name where a folder went.* Measured against a real tree, Bun's recursive `fs.watch` reports a directory rename, a directory *move*, and an `rm -rf` identically: one `rename` event naming only the **source**. The destination is never named, even when it is inside the watched tree. That is enough to know something left and nothing about where it went, so a folder rename could only be resolved by the nightly full walk.

*It has to cost one watch per directory.* This is where `chokidar` fails, and the reason it was tried and dropped. It calls `fs.watch` on every **file** as well as every directory: measured on a 200-directory, 10,000-file tree, 10,201 inotify watches and 120 MB against `fs.watch`'s 201 and 34 MB. A 300k-frame library therefore wants ~300k watches, against a kernel default of 8,192 and a common distribution default of 65,536. Past the limit it emits an error *per failing path*, so the retry below would re-walk the whole tree every five minutes for ever. The per-file watches buy nothing either: the handler keeps only the path, and the directory's own watch already reports its children.

`@parcel/watcher` takes 204 watches and 35 MB on that same tree, settles in 55 ms, and names both halves of every move - same level, into a subfolder, out to the root - including the rename of a folder holding no photographs, which §9.4.1's photo evidence structurally cannot see. Its `ignore` list takes the data directory, the bin (§12.3) and the excluded folders, so none of those subtrees is walked at all rather than filtered afterwards, and the per-event check applies the scan's own rules (§9.1) so the two cannot disagree about what the library contains. The bin earns its place there twice over: it is one known path, and it only grows, mirroring the whole folder tree as photographs are binned.

**An event the library does not contain schedules nothing.** The watcher used to arm its debounce for every batch it was handed and decide relevance afterwards, per path. A batch where nothing survived that filter then ran the timer down to a sync with an empty path set - which is a *full* one, because an empty scope is how a dirty re-run asks for the whole tree. The sync lock (§9.7) is a file at the library root, so every sync's own lock woke the watcher that started the next one: a library nobody was touching syncing once per debounce window, for ever, each run reporting `added=0 removed=0`. The lock is in the `ignore` list now, and a batch that recorded nothing arms no timer, which answers the class rather than that one path.

**Nor does a file the library will never hold.** A text file, a sidecar, a JPEG export saved beside the raws is in scope by *path* - `isPathAllowed` is about folders - so it used to be handed to a scoped sync like a candidate photograph, and a whole sync run (a mutex, a lock file, a transaction, a settled announcement) went by to conclude it was never one. The watcher settles it instead, with one `stat`, asked only of paths whose extension is not one of ours (§7) so a bulk import stats nothing extra. A folder always passes, because an empty one's rename reports no other event at all and dropping it would lose the shoot relocation (§9.4.1); so does a path that is already gone, which is a deletion and could have been either.

It is a native module, which is why its prebuilt bindings matter: they cover linux x64 and arm64 in both glibc and musl, plus macOS and Windows, so nothing is compiled at install time on any platform this runs on.

A moved folder reports as the folder, with no per-file events beneath it. That is enough: §9.4.1 identifies it by inode and the subtree's paths shift by a prefix, which is two `UPDATE`s rather than one per frame.

### 9.9 Library Mutex

Sync snapshots the DB, then scans **asynchronously**, then applies. A user mutation that moves files (shoot add/remove/rename, photo delete) landing mid-scan would make that snapshot stale. `libraryMutex` (one process-global instance) serializes those mutations against sync **per library**: whoever arrives second queues rather than failing, since these are interactive requests.

- `syncLibrary` takes the sync **lock file first, then the mutex**. Lock-first keeps sync-vs-sync fail-fast (`SYNC_IN_PROGRESS`, 409, §9.7); the mutex only makes *mutations* wait. Mutations never take the lock file, so there is no cycle to deadlock on.
- The mutex is acquired at exactly one level per operation (e.g. in `rename`, not its caller `update`), since it is not re-entrant.
- This closes the mutation-vs-scan race class at the source, rather than guarding each symptom. The per-write guards it supersedes are kept anyway (path-guarded `setMissing`, the `(dev, ino)` collapse, the re-checks before FK writes) because they also cover the cross-process case the in-memory mutex cannot.

### 9.10 Stopping a sync

`DELETE /api/libraries/:id/sync` aborts the library's current run. The generation token (§9.6) *is* the `AbortController`, so "which run" and "how to stop it" are one thing, and a stop can never reach a newer generation than the one that was asked for.

What a stop means depends on which phase it lands in, and neither leaves anything half-applied:

- **During the scan**, the loop that opens and hashes checks between files, so a stop lands within one file's decode rather than at the end of the walk. On a populated library every write is a single transaction *after* the scan, so abandoning it applies nothing: `syncLibrary` returns an idle status rather than raising, because the caller asked for this, and the detached processing in its `finally` never starts.
  - **Except on a first scan, which keeps what it reached.** A half-built `present` set is normally unusable, and dangerously so: absence from it is how §9.1 detects a removal, so applying a truncated scan would mark every file it had not got to as missing. That reasoning needs rows to be absent from. When the run has none - `dbPhotos` is empty, which is a library's first sync, and also a scoped sync whose paths are all new - no removal can be derived, and therefore no move either, since a move pairs a removal with an addition. All a stopped scan can then hold is "these files are new", which is as true of a scan that saw half the library as of one that saw all of it, so it is applied and the files it never reached are simply added by the next sync. Otherwise a stopped 50k-frame import would throw away every file it had already read and hashed.
  - That case is exactly the one §9.4 commits in batches, so most of what a stop keeps is already on disk before the stop arrives; all the stop itself adds is the tail of the batch in hand. A kill is the same event without the courtesy of asking, and it keeps the same work for the same reason.
  - The stop is still a stop: the processing that follows a partial commit is handed the same aborted generation, so it queues nothing and the photos land owing their renditions. `last_synced_at` is stamped, which says when a sync last ran rather than that the catalogue is complete.
- **During processing**, the pool retires each worker as its current job lands instead of killing it mid-encode, which would leave a half-written rendition. What is already on disk stays - a tile is valid whether or not the rest of the run finished - and the photos it never reached keep their `needs_tile` / `needs_renditions` flags, so the next sync picks them up. The status settles to idle through the same tail that a completed run does.

**The pool is asked whether to stop, rather than handed a signal.** A batch is keyed by library and outlives the sync that started it: a later sync of the same library coalesces into the running batch (§10.2) and whatever it passed is dropped by that dedup. Given a fixed `AbortSignal`, the batch would go on watching a generation that has already finished, and a stop aimed at the current one would reach nothing; the button would do exactly nothing, silently, and only when two syncs happened to overlap. `SyncService` therefore passes a predicate that reads whichever generation is current at the moment it is asked.

Deleting a library aborts its run for the same reason: its rows are cascade-gone, so there is nothing left to finish.

**Why the full scan stats every file.** Skipping the stat for files in directories whose mtime is unchanged was tried and removed: the stat is the *only* cost it saves (the mtime+size quick-check already skips the expensive decode for unchanged files), and skipping it also skips the `(dev, ino)` collapse that `moveIntoDir`'s non-atomic `link()`-then-`unlink()` window depends on. A cross-directory move bumps only the destination directory's mtime, so the source stays "unchanged" and is pruned; the destination is then inserted as a new photo while the source row survives, leaving a duplicate. Making it safe means restoring the stat, which leaves no saving.

---

## 10. Processing Pipeline

### 10.1 Overview

Processing converts RAW files into **renditions**: derived copies of one photo, each existing for a stated reason.

| Rendition | Constraint | Why it exists | Output path |
|---|---|---|---|
| `grid` | Longest edge = `GRID_RENDITION_SIZE` (default 800px) | The library grid. Always SDR | `<data_path>/renditions/grid/<photo_uuid>.avif` |
| `full` | Longest edge = `FULL_RENDITION_SIZE` (default 3840px) | The photo view | `<data_path>/renditions/full[-hdr]/<photo_uuid>.avif` |
| `max` | Native resolution, never fitted | Pixel-peeping (§10.5) | `<data_path>/renditions/max[-hdr]/<photo_uuid>.avif` |

Sizes and quality come from configuration (§15). Nothing in the pipeline hardcodes them.

These were three trees under three names - `thumbnails/`, `previews/` and `lossless/` - with the vocabulary to match, which read backwards in both directions: `thumbnails/full` was a 3840px image the viewer showed *by default*, and `previews/` was the one thing it did *not*. They are the same idea at different sizes and dynamic ranges, so building any of them is one job type over a list of targets rather than three that differed mostly in what they called their output path.

**The camera's embedded JPEG is deliberately not a rendition.** It is the original bytes, served straight out of the RAW like the RAW itself (`GET /image/:id/embedded.jpg`), never resized into HDR or transcoded into AVIF and cached as a copy of its own. The one exception is the grid tile, which cannot be a 9504px preview and so is re-encoded to 800px whatever its source.

**Dynamic range is in the directory, not the filename**, because the file is the cache: a copy built while the library was SDR would otherwise be handed back forever, so turning HDR on and asking for the full-size view returned the old sRGB AVIF and nothing ever rebuilt it. HDR is stored *beside* the SDR copy rather than replacing it, so turning the setting off does not throw away work that turning it back on would redo. The video twin gets its own `-hdr-video` directory: the orphan sweep keys on the one extension a directory is supposed to hold, and two in one directory would have it delete the video as a superseded format on every pass (§10.6).

**Everything is AVIF**, every rendition, the full-resolution export (§10.5) and the HDR renditions (§10.7) - and every one of them goes through **libavif**. The SDR path moved off libvips' `heifsave` once the HDR one was already linked: measured at matched quality on a 3840px frame it is 307ms against 275ms at the grid and full setting, and 370ms against 302ms at the export's, for files within half a percent of the same size. It also takes libheif out of the chain, and with it the plugin-priority trap `vips.rs` used to guard against - the guard went with the code that needed it. **The encode never resizes**: `save_avif_frame` hands libavif the frame where it lies, always. Sizing belongs to whoever built the frame - the SDR base is resized once in `job::run`, an embedded preview is shrunk during its JPEG decode - so nothing arrives here the wrong size, and every job the service builds names one target. Going through a libvips pipeline regardless had `finish` materialise a second copy of the frame - 183MB on a 61MP export - to hand over pixels libavif could read in place. The resize survived as an unreachable fallback for a job naming two SDR sizes, and it was the wrong fallback: it would have run *after* `render_base`'s sharpen, which is a deconvolution calibrated for the size it ran at, so a second SDR target wants a copy of the base per target resized ahead of that sharpen instead. It decodes natively in every current browser with no polyfill, it is the only format here that carries HDR to Chrome and Safari alike, and at matched quality it is smaller than the WebP it replaced: the full-size rendition is 375 kB at q60 against 1019 kB for WebP q90. Nothing migrates existing files; the orphan sweep keys on the extension a directory is supposed to hold, so stranded WebP is collected on the next pass (§10.6).

**The SDR renditions are 4:2:0 too** (`sdr_full_chroma`), for the same reason and on its own numbers - a separate setting because the amounts are not the same size, and because the grid tile is a different question from the native-resolution export. Measured on the 24MP fixture:

| rendition | | wall | CPU | peak RSS | bytes |
|---|---|---|---|---|---|
| grid tile, 800, whole job | 4:4:4 | 85ms | 0.12s | 94MB | 13.7 kB |
| | 4:2:0 | 76ms | 0.12s | 90MB | 12.5 kB |
| viewer, 3840, encode only | 4:4:4 | 483ms | 2.88s | 476MB | 1.72 MB |
| | 4:2:0 | 224ms | 1.71s | 420MB | 0.53 MB |
| full resolution, encode only | 4:4:4 | 1468ms | 10.34s | 918MB | 8.48 MB |
| | 4:2:0 | 842ms | 7.25s | 651MB | 5.02 MB |

The viewer rendition encodes in **less than half the time** - a larger margin than the HDR still gets, since 8-bit 4:4:4 is where libaom's chroma planes cost most relative to the rest of its state.

**The grid tile is a different measurement and has to be read as one.** It is the whole job rather than the encode alone, because the tile never decodes a RAW: it comes off the embedded JPEG, DCT-scaled during the decode (§10.4), so the entire thing is 76ms and ~60MB above baseline where the other two rows sit on top of a demosaic. 4:2:0 saves 9% of a 12.5kB file there and about 9ms.

**And the tile has no chroma to lose.** The camera's preview is already subsampled - `yuvj422p` on the fixture, which is typical - so a 4:4:4 tile was storing chroma at a resolution the source never had. Measured against a near-lossless encode of the same tile, the combined SSIM goes 0.992211 to 0.991865, a difference of **0.0003**, and the U plane 0.9952 to 0.9946. That is as close to free as this gets, and it is the rendition every photo in the library has - the grid, masonry and list views all request it, as do the shoot and collection banners.

Per-plane at 3840, against a near-lossless 4:4:4 reference, the same shape as §10.7:

| | Y | U | V | All | bytes |
|---|---|---|---|---|---|
| 4:4:4 q26 | 0.9433 | 0.9561 | 0.9563 | 0.9519 | 1.72MB |
| 4:2:0 q26 | 0.9436 | 0.8802 | 0.8953 | 0.9064 | 0.53MB |
| 4:2:0 q16 | 0.9695 | 0.9054 | 0.9169 | 0.9306 | 1.52MB |

Luma is identical at a matched quantizer and *better* at matched bytes. Chroma is worse either way, and it does not fully recover at any quantizer - 4:2:0 needs q0 and 6MB to pass 4:4:4's combined score at q26 and 1.7MB. Which of those matters is a judgement about where a viewer looks, not something the metric settles, and the setting exists so it does not have to be settled here.

Two encoder settings were measured rather than inherited, and both defaults were wrong:

- **`effort` buys essentially nothing, and costs everything.** libvips defaults to 4. Measured on a 3840px frame at Q88, with `Q` fixed the file size does not move - effort searches harder for the same quantiser, so what it can buy is quality, and it barely does:

  | effort | ms | bytes | PSNR |
  |---|---|---|---|
  | 0 | 509 | 5.666MB | 40.13 |
  | 1 | 545 | 5.685MB | 40.15 |
  | 2 | 951 | 5.615MB | 40.16 |
  | 4 | 5318 | 5.646MB | 40.59 |
  | 9 | 132601 | 5.713MB | - |

  Effort 4 is 10x the time for +0.46dB at the same size; effort 9 is 260x the time for a file 0.8% *larger*. On the 800px grid tile it is worse still, 15ms to 1626ms for +0.33dB and a bigger file. So effort is pinned at 0 in `renditions.ts` rather than offered as a setting: there is no value of it worth choosing, and a knob whose every other position is a loss is a knob that only costs the reader time.

  This previously claimed effort 4 was 13.6s against 0.6s "for a file only ~15% smaller". The time ratio was roughly right; the 15% was not - the file is not smaller at all. Worth correcting because it framed effort as a size/speed trade with a real size on one side, when at fixed `Q` there is nothing on that side.
- **The quality settings are libaom quantizers**, 0-63 and lower is better, because that is the scale the encoder underneath takes. They were libvips' 1-100 until the encode moved, and the defaults are the measured equivalents rather than fresh guesses: matched on SSIM, Q80 lands on 13 and Q88 on 8, and the fit holds away from the two points it was taken at - Q60, Q70 and Q95 predict within 0.0007 SSIM. **The direction inverted**, so a value carried across from the old scale means close to its opposite. Those equivalents were written down as 26 and 16 while libavif was halving every quantizer it was given (§10.7); the files were always the ones described here, only the numbering was doubled.
- **AVIF quality is not WebP's scale.** Carrying the old 90 across would have produced 2551 kB renditions, 2.5x larger than what they replace. q80 is where shadow detail stops visibly degrading on real frames; q60 and q70 lose it. Quality is nearly free once effort is 0 (596ms at q60 against 898ms at q85), so this is chosen on appearance, not cost.

**The grid tile is always the camera's embedded JPEG**, whatever the library is set to. It is a small SDR rendition, so the only thing worth optimising is how fast it appears, and the embedded preview is the fastest source there is: ~125ms against ~1.5s to demosaic (§10.3). A body that embeds no JPEG falls back to a render inside the worker, so this is "the fastest source available" rather than "always the JPEG".

**`rendition_source` governs the photo viewer, not the grid**: `embedded` serves the camera's JPEG in the viewer as itself and builds no rendition at all, `render` builds the full-size view by demosaicing. Alongside `rendition_hdr` and `rendition_hdr_video` it lives on the `libraries` row, not the server: one catalogue may be scanned JPEGs where the camera's rendering is the point and another RAWs worth demosaicing. `embedded` is the default. Changing any of them is deliberately **not retroactive**; it decides what gets built next, and rebuilding a catalogue is an explicit action.

**Only `full` and `max` are ever HDR, and only they take the chroma setting.** The grid stays SDR whatever the library says: a wall of HDR tiles is punishing to look at, and it would put a LibRaw linear decode and two encoder passes on every photo in an import rather than one AVIF encode. It is always 4:2:0 for a reason of its own - it is 800px among other tiles, and its usual source is the camera's already-subsampled preview, so `sdr_full_chroma` would buy it 0.0003 SSIM for a third again the encode. Neither is offered as a knob, and the two are refused differently because they arrive differently. **HDR is a caller's argument, so an HDR grid tile is a bad request and `processing_service.target` throws `VALIDATION_ERROR` rather than quietly building an SDR one** - a coercion would leave the mistake somewhere nobody reads, and the mistake is not benign: `renditionDir` gives no HDR grid path, so a request honoured would encode HDR and file it as SDR, which decodes wrong rather than merely costing more. Chroma is a setting the service reads rather than something a caller asks for, so there is no request to reject there - only a policy that the setting covers `full` and `max` and not the grid.

`renderOne` is `async` for that throw: the grid-tile repair calls it fire-and-forget and clears its in-flight set in a `.finally()`, so a synchronous throw would skip both, leave the photo unrepairable for the life of the process, and turn a detail read into a 500.

That holds for the render fallback too. A body with no usable JPEG preview builds its tile by demosaicing, and it is still SDR and still 4:2:0: what makes full chroma pointless at 800px is the size and the wall, not where the pixels came from.

**An import builds `grid` always, and `full` only when the library renders.** A library serving the camera's JPEG has nothing to build for the photo view - it hands over the RAW's own bytes - so it pays one small encode per photo and no demosaic at all. `max` is never built at import: it is native resolution and tens of megabytes, so it happens on request and only once.

With `rendition_hdr_video` also set, the worker writes the one-frame AV1 twin off the same decode. Firefox applies a PQ transfer to nothing but video and renders an HDR still dark, so that file is the only rendition reaching an HDR display there, and the client serves it in place of the AVIF on Firefox alone (§10.7). It is a separate opt-in rather than implied by HDR because it is a second encode per photo for a file no other browser ever reads. Only a second *encode*: it shares the still's graded frame, so it costs an AV1 pass rather than another resize, warp and tone map (§10.8.1). `renditions[x].video` carries that file's path and weight rather than a boolean, so the panel describing what is on screen names the MP4 the viewer is actually watching instead of the AVIF beside it.

**Every rendition reports its weight, the stills included.** It used to be read in the browser off the Resource Timing entry for the response that had already arrived, which cost the server nothing and described what the reader actually paid. It only worked in Chromium: Firefox leaves `encodedBodySize` at 0 for a cross-origin resource whatever `Timing-Allow-Origin` says, and the app and the API are always separate origins, so the panel read "unknown" there for every photo. It comes off the same stat that answers `built` now - free for a stored rendition - and for the camera's JPEG, which has no file of its own, off lifting it out of the RAW: a header read and a copy, about a millisecond, on a single-photo read.

**The viewer sees a three-step quality ladder**: the camera's JPEG, `full`, and `max`. They are the same picture at different costs, so it treats them as interchangeable and `viewer_rendition_mode` (§13.6) decides which one a photo opens at: pinned to one of the three, or reopened at whatever was chosen last, either across the catalogue (`remember`) or for that photo (`remember_per_photo`, stored on `photos.viewer_rendition` and carried on the summary so the viewer can act on it before it has fetched anything, §18.5). Server-side rather than in the browser because the same catalogue is opened from a phone, a laptop and whatever is plugged into the good monitor, and "where I left off" is worth nothing if it only holds on one of them. All three stay on offer whichever is showing, the step back down to the camera's JPEG included: comparing a render against it is a reason to switch.

Comparing two of them is the reason to have three, so `I` and `O` switch straight to the camera's JPEG and to the render, and the stage holds the frame it is already showing until the next one has decoded rather than dropping to the background between them - a flash on a swap between two files that are both already cached says "loading" where nothing was loaded. The same decode-then-swap covers a genuinely slow one; only a photo *change* clears the stage, because there the previous frame is the wrong picture.

The incoming frame is **mounted as a second, invisible element over the current one** and that element is then kept rather than replaced. Decoding into a detached `new Image()` first is not enough: the browser decodes for the size an element is drawn at, so the visible element decoded the file a second time when it took the src, and a 3840px AVIF flashed on the way in while the 1080px camera JPEG - the same swap in the other direction - did not. Firefox's video twin swaps the same way, promoted on `loadeddata` since a `<video>` has no `decode()`; it is a rendition comparison like any other and would otherwise be the one path that still flashes.

Against that, the file being the cache means a change to the pipeline is invisible on every photo already looked at. **"Disable cache when changing rendition"** (`?force=true`) removes the stored copy and its video twin before building, so choosing the same rendition again renders it afresh. It is a checkbox under the Rendition menu rather than a fourth entry in the ladder because it modifies the choice rather than being one, and it is off by default and per-session: it is for working on the renderer, not for looking at photographs. The camera's JPEG ignores it, having no build to force past.

`PhotoDetail.renditions` answers the client's questions from **disk rather than from a column** - what each one's path is, whether it is built, whether it is HDR, whether a video twin exists - because settings are not retroactive and a library switched to HDR after an import still has SDR files. `default_rendition` is what the viewer opens at when nothing has been chosen, so the client never has to re-derive it from what happened to be built.

**A missing grid tile is rebuilt when the photo is opened.** The queue only visits photos flagged for processing, so a tile deleted under a catalogued photo - a wiped cache, a sweep that went too far - is a hole in the grid that nothing ever fills; reprocessing the photo would fill it at the cost of every other rendition. Opening the photo is when someone is looking, so `GET /api/photos/:id` stats the tile and, if it is gone, renders that one rendition in the background from the source the import used (the photo's `rendition_source`, or the library's). A side effect on a read, deliberately: the file is the cache, and repairing a cache on the read that noticed it is empty is what a cache does. One repair per photo is in flight at a time.

**Reprocessing clears every rendition it does not itself rewrite.** A photo is reprocessed because its pixels changed, so the copies beside it are of the old file and nothing else would ever notice - the max-resolution export in particular would be served forever. The ones the job is about to write are exempt, or the sweep would delete what it just made.

**A run that owes only the tile sweeps nothing.** `POST /api/photos/rebuild-tiles` sets `needs_tile` alone, and a run that was never going to write a rendition neither stamps `rendition_source` nor sweeps: nothing said the pixels changed, so the viewer's copies are still of the file it has. Sweeping there made regenerating a grid rendition delete the render the photo view was holding, which the next look then paid for again.

Every writer on this path fails on a missing directory rather than creating one, and ffmpeg fails the whole job rather than the one output, so the worker creates the directory for each of its job's outputs before it runs. At the call site instead, each new rendition is a directory somebody has to remember, and the one that was forgotten took the still down with it.

### 10.2 Concurrency Model

Processing uses **Bun worker threads** for parallelism. The concurrency level is configurable (default: 4 workers).

**The queue is built in the order the grid will show it.** `listPendingProcessing` orders by the library's own `ordering` (`taken_asc` by default, so oldest capture first), using the same clause the gallery reads by, NULL capture dates included. A 50k-frame import otherwise filled in whatever order the rows happened to be inserted, which is the scan's order and therefore the filesystem's - so the first screenful was among the last to get its renditions, and the user watched an empty grid while work was being done on photos three thousand rows down. Both passes follow it, since each iterates the same staged list.

Only applied when the run names a single library: a batch spanning several has no one ordering to follow, and those runs are always an explicit set of ids the user just asked to rebuild. Above one `IN (...)` chunk the order is per chunk rather than global, which affects only sets far larger than a scoped sync ever carries (the watcher falls back to a full sync past 256 paths, §9.8).

The orchestrator (`processing_service.ts`):
1. Queries for all photos owing either stage with `is_missing = 0` (a photo whose file went missing while processing was still pending must not be run against the absent file; excluding it leaves its flags set so it is generated on the sync that clears `is_missing`, §9.4 step 4).
2. Maintains a work queue.
3. Spawns up to N Bun `Worker` instances, each running `processing_worker.ts`.
4. Sends photo processing jobs to workers via `postMessage`.
5. Workers send completion/error messages back.
6. On a success message, the orchestrator clears the flag for the stage that landed and stamps its `*_built_at`; the renditions stage also writes `rendition_source` and clears `processing_error`. On a failure message, it clears *both* flags (so the photo is not silently reprocessed on every subsequent sync, and a file whose tile could not be built is not asked for renditions), records the worker's `error` string in `processing_error`, leaves the stamps unchanged, and logs via `console.error`. Such a photo has no rendition on disk (the worker deletes any partial or stale output on failure, §10.3), so the image endpoints 404 (§13.5), but `processing_error` distinguishes a failed photo from an unprocessed one.

### 10.3 Worker Implementation (`processing_worker.ts`)

Each worker:
1. Receives a message naming the RAW, the targets it has to write, and the sizes and qualities for each (passed in from config).
2. Decodes the RAW once, through `native/rawshim` (§10.4) → an RGB bitmap **already rotated to display orientation** (the decoder applies the EXIF flip; the raw buffer carries no EXIF for a downstream library to auto-rotate from). Lazily, and a **tile job never reaches it**: the grid tile comes off the embedded JPEG, so a tile-only pass opens the file for its preview and demosaics nothing (§10.1).
3. Fits the camera-match profile once, if the library asked for it (§10.8).
4. Builds one graded base at the largest SDR size any target needs, and writes each target's AVIF from it.
5. On any failure, deletes every output the job names, if present (best-effort unlink), before reporting - so a failed job leaves no partial rendition and a failed reprocess does not leave the prior run's stale ones on disk (both share the UUID-keyed path). This upholds the §10.2 no-rendition invariant.
6. Sends back `{ photoId, success: true, source }` or `{ photoId, success: false, error: string }`.

**The decode never enters the JS heap, and never leaves Rust at all.** Steps 2-4 happen inside one `bb_run_job` call: TypeScript sends the job as JSON and gets JSON back, so a 60MP frame is decoded, fitted, graded and encoded without its pixels - or an address to them - crossing the FFI boundary. Nothing is freed by hand. A decode is an owned `Frame` in a local and is dropped when its scope ends, which is what releases the 8-bit one once the base is built and the scene-linear one as soon as the grade has copied out of it (§10.7).

**Nothing in the product moves samples across the boundary at all now.** There were two that did - the scene-linear frame TypeScript wrote to ffmpeg's stdin, and the HDR fit that read the same pixels - and both moved into Rust. `pixels()` survives for the tests that compare a decode against what was written (§10.4, "Handles, not pixels").

**One grade, not one per rendition.** The base is built at the largest SDR size the job asks for and every smaller rendition is a resize of it rather than its own warp and re-grade, which is legitimate because the order does not change the result: the distortion model is in radii normalised to the half-diagonal and the colour transform is a per-pixel lookup, so neither depends on resolution. Going 3840→800 is also a cheaper resize than 9504→800. The integration suite checks the reasoning rather than trusting it, comparing a grade-then-resize against a resize-then-grade.

**No job carries two SDR targets any more, so read that as the reason the sharing is safe rather than as something happening.** It described a single job writing an 800px tile and a 3840px view together, which is what the pre-split pipeline did. Tiles and renditions are two passes now, and the tile takes the embedded JPEG, so the only thing that reaches the shared base is one `full` or `max` - or a grid tile whose file embeds no preview. **A tile job does not demosaic**, and the sentence that used to be here is the easiest way to conclude that it does.

**An import runs in two passes, tiles before renditions.** Both cover the same photos, so this is purely an ordering choice, and it is the reason the stages are split at all: measured over 23 real ARWs, a tile is 124ms where a rendition is 1518ms, and at concurrency 8 that is 30 img/s against 3. On a 2000-frame shoot the whole grid is browsable in about a minute rather than after the eleven minutes the renders take.

**The pending flag is per stage, because everything that reads it wants to know which one.** `needs_tile` and `needs_renditions` each clear as their own pass lands, so a run interrupted between them resumes at the second rather than redoing a tile already on disk; the queue asks for either (`countPendingProcessing` counts photos owing one, since the sync strip counts photos rather than stages); the gallery's "No rendition" filter means `needs_tile`, a photo with a tile being no hole in the grid; and the detail panel can say which of the two it is waiting on rather than reporting one word for two rather different waits. A failure clears both: the failure is the file, not the stage.

A failure sweeps *every* derivative of that photo, not just the stage that failed. A photo is being reprocessed because its pixels changed, so a rendition the failed run never reached is of the old file and would otherwise be served forever with nothing to notice. The exception is a run that owed the tile alone (§10.3): nothing there says the pixels changed, so a failed rendition rebuild leaves the viewer's copies where they are.

**Rendition source.** The job names where the pixels come from:

| Source | What it does | Trade-off |
|---|---|---|
| `render` | Demosaics the RAW (steps 2-3 above) | Full sensor resolution, slow |
| `embedded` | Lifts the camera's own JPEG out of the file (`libraw_unpack_thumb` + `libraw_dcraw_make_mem_thumb`) | Much faster, the maker's colour treatment, but only as large as the body embedded, which ranges from 640×480 to the full sensor |

The embedded JPEG carries its own EXIF orientation, so the decode applies it (`autorot`); a render is already baked upright by the decoder (§11.1) and must not be rotated again. A file with no JPEG preview (some bodies embed a bitmap, or nothing) is a property of the file rather than an error, so an `embedded` request falls back to a render. The result reports what was **actually** used and `photos.rendition_source` records it, so the client can state which pixels are on screen instead of leaving the user to guess.

### 10.4 The native layer (`native/rawshim`, `raw_decoder.ts`)

Everything that touches pixels is in one Rust library, called from TypeScript over `bun:ffi`. It links LibRaw for the decode, libvips - the library sharp wrapped - for the JPEG decode and encode, and libavif for every AVIF (§10.1). The resampling and filtering in between are the crate's own, in `image.rs` and `fit.rs`. TypeScript orchestrates: it passes a path and a job, and gets back a written file, a struct of scalars, or a count.

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
1. Calls `libraw_init(0)` to create a processor. LibRaw's default `user_flip = -1` already applies the camera's EXIF orientation during `dcraw_process`, so the output RGB buffer is upright (a raw bitmap carries no EXIF, so nothing downstream can rotate on its own). **Do not override `user_flip` to `0`**; that would emit unrotated pixels and misorient landscape/portrait renditions. Relying on the default also avoids poking a struct field by offset through FFI, which is version-fragile.
2. Opens the file with `libraw_open_file`.
3. Calls `libraw_unpack` and `libraw_dcraw_process`.
4. Calls `libraw_dcraw_make_mem_image` to get the processed image in memory.
5. Reads the image dimensions and pixel data from the returned struct.
6. Copies the pixels into a JS `Buffer`. The mem-image is heap-allocated by LibRaw and must be freed with `libraw_dcraw_clear_mem` on every path (see step 8), including if the copy in this step throws.
7. Returns `{ width, height, data: Buffer }` (raw RGB pixels).
8. Cleans up in a `finally` so every path (including a decode or copy error) releases resources: `libraw_dcraw_clear_mem` on the mem-image pointer if it was allocated (null-guarded, since an error before step 4 leaves it unset), then `libraw_recycle` and `libraw_close` on the processor.

**Memory-leak audit:** every LibRaw allocation must be paired with its free on all paths, including errors. The three owners are the mem-image (`libraw_dcraw_clear_mem`), the unpacked data (`libraw_recycle`), and the processor (`libraw_close`). The implementing agent should audit the full FFI lifecycle, not just these calls.

**One copy, not two** - and for a while that claim was wrong. The frame is copied out with the masked-border crop applied on the way, rather than copied whole and then cropped out of that, which on a 60MP frame is ~190MB moved twice. But `dcraw_make_mem_image` is *itself* a copy: `dcraw_process` leaves the frame in `imgdata.image` as four `ushort` planes in sensor orientation, and that call allocates a second whole frame to interleave it into. Measured on a 24MP frame it is 153-198ms, with the copy after it another ~80ms, against a ~535ms decode - nearly half the decode spent moving bytes that had already been computed.

**So the scene-linear decode reads `imgdata.image` directly**, interleaving, orienting and cropping in one parallel pass. On a 24MP frame that is 575ms to 372ms on a Sony and 593ms to 338ms on a Canon, ~40% off the decode.

Only the scene-linear one, and the reason is the output curve rather than caution. `copy_mem_image` **rebuilds `imgdata.color.curve` before reading it** - the table sitting in the struct is not the one LibRaw is about to use - so reproducing it means reproducing dcraw's `gamma_curve(gamm[0], gamm[1], 2, (t_white << 3) / bright)`. The *shape* of that curve is standard: a linear toe of slope `ts` joined to a power law of exponent `pwr`, solved for continuity, which is the same construction as BT.709 (0.45, 4.5), sRGB (1/2.4, 12.92) and ProPhoto (1/1.8, 16) - LibRaw's default `gamm` is literally BT.709. What is *not* standard is where its arguments come from: on the sRGB path `t_white` is scanned out of a histogram against `auto_bright_thr`, a dcraw heuristic this has no business shadowing, and shadowing it against a binary `.so` is the same "we believe this is right" bet the wrapper exists to avoid.

On the scene-linear path every one of those arguments is a constant set a few lines earlier: `no_auto_bright` pins `t_white` at 0x2000, `bright` is 1, and `gamm` is {1,1}. Solve dcraw's curve for those and the bisection takes g[3] to 1 with g[4] at 0, so the table collapses to `curve[i] = i`. There is therefore no lookup on this path at all - the identity is not an assumption about LibRaw, it is what those constants make the curve. The guard checks all four before taking the direct route and falls back to `dcraw_make_mem_image` otherwise, which is what the 8-bit path always does.

That reasoning is exactly the kind that looks right and renders half a frame wrong, so it is pinned rather than argued: `raw_decode.integration.test.ts` decodes both ways and requires the bytes to match, on both fixtures, at full and half size - the two flip orientations and the two inset cases between them.

**The fit to the rendition's size happens here too**, in the same pass. A 3840px HDR rendition off a 24MP frame wants 59MB, and building the whole 145MB decode only for the grade to box-average it down meant that buffer coexisting with LibRaw's 194MB working set. Averaging straight out of `imgdata.image` is the same box filter over the same source pixels in the same order, so `box_resize_u16` then finds the frame already at size and declines - the intermediate simply never exists. Measured on the 24MP fixture at 3840, the decode's transient falls from **420MB to 338MB** and what it leaves resident for the rest of the job from 188MB to 106MB, which is the figure that multiplies by `processing_concurrency`.

It is bit-identical, and pinned that way rather than asserted: the reference arm of the differential test applies the same fit as a separate pass afterwards, so the SHA1s only match if fusing it changed nothing. Verified at 3840, 800, 640 and native, including the half-size cases where the two stages compose.

The fit is only applied to the scene-linear path. The 8-bit one is reduced by a different filter (Lanczos3, against the box average here), so shrinking it here would change the picture rather than just move where the work happens.

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

**Both decodes take it, the scene-linear one included.** The HDR decode used to pass 0 unconditionally and demosaic a 61MP frame in full, only for the grade to box-resize it to 3840 as its first act (§10.8.1) - fifteen sixteenths of the most expensive stage in the pipeline, thrown away. It asks for the largest HDR edge the job wants, exactly as the SDR decode asks for the largest SDR one, and a `max` target still reports 0 and is never halved. The two renditions therefore anchor their grades on decodes of different resolutions, and since the grade's anchor comes from the frame, `full` and `max` can land on slightly different tone curves. Measured by grading both to the same output size: a **0.32% difference in mean brightness**, 0.2% RMS.

Worth stating plainly, because an earlier draft defended this by analogy to the SDR path, and that analogy is false - the SDR path derives no exposure from frame content at all, so decode size genuinely cannot matter there. The defence is the measurement, not the analogy: 0.32% is well under the ΔE 0.21 this design already accepts for skipping the crop search (§10.8) and far under a just-noticeable difference. If it ever needs to be exact, the fix is to measure the levels resolution-independently rather than to stop halving.

**An all-HDR job takes no 8-bit decode at all** (§10.8). Nothing renders SDR there, so the camera-match fit was that decode's only reader - and it can read the scene-linear one instead.

**`half_size` has no setter in the C API**, and that is why the decode lives in Rust (`native/rawshim`) rather than in TypeScript. The FFI could only reach the field by locating `libraw_output_params_t` at runtime and writing at an offset; that worked, and was cross-checked from two directions, but its neighbours are `four_color_rgb` and `use_auto_wb`, either of which silently changes the picture when written to by mistake while leaving the dimensions perfectly plausible. bindgen resolves the field from the same headers the runtime library was built from, so the offset is the compiler's problem and stops being ours.

The wrapper owns the whole decode, because it is one job: as-shot white balance, the PPG demosaic, the half-size decision and the masked-border crop. **The decode itself buys no speed** - measured against the TypeScript path it is 0.99x on a 61MP frame and 1.07x on a 24MP one, pixel-identical, because the time is inside LibRaw's unpack and demosaic either way. That was a correctness change. What it also did was put the boundary in the right place for everything else to follow.

#### Commands, not handles

**A rendition job crosses as JSON and comes back as JSON.** `bb_run_job` takes UTF-8 bytes describing the job and writes UTF-8 bytes into a buffer the *caller* allocated. No address this library owns is ever handed over, so there is nothing for the other side to hold between calls, nothing to free, and no lifetime resting on a convention.

That last point is why it changed. The previous boundary passed an opaque pointer to a bitmap Rust owned, and each operation took a handle and returned another - which reads as safe and is not, because a raw pointer carries no lifetime. `hdr_source<'a>(image: *const BbImage, ..) -> Option<(Source<'a>, ..)>` had a **free lifetime parameter**: `'a` was constrained by nothing, so the caller picked it and a borrow of the pixels could outlive them by any amount. The compiler accepts a use-after-free written that way; it was held off by review and by runtime null checks, not by the type system.

Ownership says it instead. Everything the worker used to orchestrate - two lazy decodes, the camera fit, the shared base, the per-target loop - is `job.rs`, where a decode is an owned `Frame` in a local, borrowed with real references and dropped when nothing holds it.

**Three things fell out that were previously hand-managed.** The worker's `open` list and its `finally` are gone, because a value is dropped when its scope ends - two of the three ways that shape could leak a 366MB frame. `release_pixels` and the `release_source` flag are gone: freeing the decode before the encode allocates is the peak that matters, and `hdr::Decode::Owned` says it to the compiler, where the flag said it to a reader and needed a nulled pointer and a re-check at every accessor to be safe. And `Frame` holds `Vec<u16>` for a 16-bit decode rather than bytes every reader reinterpreted - which the old shape could not do, since it had to hand over one `*mut u8` and free it as one allocation.

Measured across the change: HDR at 3840 peaks at 343MB against 339, native 577MB against 582, SDR at 3840 424MB against 421. Within noise, which is the claim - this is a safety change and it had to cost nothing.

**Unsafe is denied crate-wide** and exempted one operation at a time, by three lints that only work as a set. `deny(unsafe_code)` stops new unsafe appearing unmarked; `deny(unsafe_op_in_unsafe_fn)` stops an `unsafe fn` body being one blanket over its contents, so the count means operations rather than functions; and `deny(unfulfilled_lint_expectations)`, paired with `#[expect(unsafe_code)]` rather than `#[allow]`, makes a marker that no longer covers anything an error too - so unsafe that is refactored away takes its marker with it in the same commit. `grep -rn "expect(unsafe_code)" native/rawshim/src` is the audit. What remains is irreducible: reading the command buffer at an entry point, and calling LibRaw, libvips, libavif and lensfun, which are C.

**The handle API is gone.** It outlived its last production caller by a while, because the pins had to assert on what the library produced and reading samples back was the only way to do it. It was not: everything those assertions actually check is a digest, a statistic or a comparison, and each is cheaper to compute where the pixels already are. `bb_for_testing_debug` answers those questions in the same shape as `bb_run_job` - JSON in, JSON out - and `rawshim_pixels.ts` and `jpeg_match_test_only.ts` are deleted. Nine entry points remain, none of which returns a pointer, and `bb_free` and `bb_buffer_free` no longer exist because nothing is handed over to be freed. Marked unsafe operations went from 71 to 38 as a side effect.

Getting this wrong the first time is worth recording, because the wrong version looked reasonable. Each call took a pixel pointer and returned a buffer, so `bb_fit` copied the render out of JS into a `Vec`, having already copied it *into* JS at the end of the decode: three ~45MB moves of pixels no JavaScript ever read. The same mistake shaped the libvips calls, one function per operation, each materialising its result for the next to copy back in - which threw away the lazy pipeline that is the whole reason libvips is fast, and is why the first native version *lost* to sharp on a 61MP fit, 915ms against 423ms. Chaining the operations into one graph and borrowing rather than copying closed most of it; moving the boundary closed the rest.

The rule that falls out: **pixels cross only on their way into an HTTP response.** Nothing else. `GET .../embedded` hands the camera's preview to a `Response` unchanged, and `GET .../download` hands over a transcoded JPEG where the library is SDR (an HDR one streams the AVIF from disk and crosses nothing); both are bytes bound for a socket, and both are copied into a buffer this side allocated rather than handed over as an address. Every other path - the decode, the fit, the grade, the warp, all four encoders - begins and ends on the Rust side.

The door in the other direction is **`rawshim_for_testing.ts`**, and lint keeps it shut: `.oxlintrc.json` bans it from `src/**`, allowing it only under `test/` and `**/tests/**`. Everything it exposes is prefixed `_for_testing_`, including the entry point it travels through, so reaching it from production code means typing the word.

It is small now, because most of what used it was never about TypeScript. **A test that asserts on Rust belongs in Rust**: the decode pins, the halving gate, the camera-match fit and the HDR grade all moved into `native/rawshim/src/fixture_tests.rs`, and the FFI round trip they used to make bought nothing but a JSON encoding of the answer. Moving them deleted nine entry points and most of the debug commands. What stays in TypeScript is what is genuinely about TypeScript: a job through a real worker thread, a rendition through the service, the settings round-trip, and the encodes verified with `ffprobe`.

**There is no exception, and there was nearly one.** The last candidate was `raw_header`'s black-border check, which reads four specific pixels, one per edge: a masked border that was not cropped decodes as black bars, and that shows up in no aggregate at all, because the frame is mostly picture and a bar barely moves a mean. It looked like the one assertion that needed bytes, and a guarded write-to-disk door was built for it. It is not - four triples is a summary like any other, so `pixelsAt` returns them and the door is gone. A point outside the frame comes back null rather than black, so a wrong coordinate cannot pass for a dark pixel.

A lint rule rather than a comment because the failure mode is a plausible-looking one. Reading samples into TypeScript to compute something over them reads as ordinary code, and it is how the colour model ends up living in two places and how a per-pixel loop ends up in the slower of the two languages. What `src/**` can reach is `rawshim_job.ts`: a command in, a result out, and for a download the encoded bytes of a response body.

Getting there took removing three round trips that each looked reasonable. The embedded preview was extracted into a `Buffer` - 5-14MB, since a 61MP body embeds a full-resolution one - and handed straight back to be decoded. The fit took that preview *and* the whole RAW, 60-120MB, so TypeScript could find one maker-note tag in the first few kilobytes. And a rendition being transcoded was read off disk into JavaScript only to be passed back down; `decodeFile` takes the path instead.

#### Two Rust suites

`cargo test` runs on synthetic inputs and finishes in 0.04s, which is what makes it worth running on every edit. The tests that decode a real RAW sit behind a `fixtures` feature - `bun run test:native:full`, ~8s - and that is the pass before calling something done. A cargo feature rather than `#[ignore]`, so the two have names and the slow one cannot be run by accident.

Committed fixtures assert their own presence and point at `git lfs pull`; the one fixture too big to commit - a 61MP frame, needed for the halving cases - prints a SKIPPED line instead. An opt-in suite that silently runs nothing is worse than one that says the checkout is incomplete.

Both pins moved here and both still pass **unregenerated**, which is the whole point of them: `hdr_argv.pin.txt` and `hdr_grade.pin.txt` were produced by the TypeScript this subsystem replaced, so a Rust reimplementation matching them says the behaviour is unchanged since *before the port* rather than since the last commit. That is why the grade digest is a SHA-256 hand-rolled beside the SHA-1, and why the channel stats are formatted to two decimals - both had to reproduce exactly what JavaScript wrote.

The differential decode pin lost its machinery on the way. `BOWERBIRD_REFERENCE_COPY` existed because the route was read from the environment inside the library, which meant a subprocess per case to set it. In one process it is just a parameter.

#### What it bought

An import job - decode, fit, grade, and write a 3840px view plus an 800px tile - against the sharp pipeline it replaced. That was one job doing both; the tile is its own pass off the embedded JPEG now (§10.3), so read the tile column as history rather than as what a tile costs today:

| Frame | sharp | native | |
|---|---|---|---|
| 24MP, no halving | 3478ms | 1560ms | 2.2x |
| 61MP, halved to 15MP | 2701ms | 2135ms | 1.3x |
| 61MP, halved to 15MP | 3425ms | 2620ms | 1.3x |

By stage on the 24MP frame, which is the clearest because nothing is halved: decode 499→490 (identical code), fit 844→466, grade 1542→307, 3840px AVIF 563→280, 800px tile 30→21.

The grade is where the boundary shows: it was a JS loop over 72MB with a sharp resize round-trip on either side, and is now one pass in Rust. The encoders are roughly 2x, which is not our work but the system libvips 8.15.1 build against sharp's bundled one. **The fit is not where it shows** - it was already in Rust before the handles, at 451ms, so removing its copy is inside the noise. Worth stating plainly, because "we removed three 45MB copies" invites the assumption that the copies were the cost; on the fit they were not.

The embedded-preview and header paths (§11.1) still use LibRaw's C API through `bun:ffi` directly: they touch no struct that lacks an accessor, so they have nothing to gain from crossing into Rust.

`bun run build:native` builds it, at cargo's stock release profile; the Docker build does so in its own stage and copies only the `.so` forward, keeping rustc, cargo and libclang out of the shipped image.

**`opt-level` and LTO are not levers here.** Measured end to end on the rendition job, `opt-level = 2`, `opt-level = 3` and `opt-level = 3` with fat LTO and one codegen unit are indistinguishable - every stage inside noise across two frames. Structural rather than incidental: the expensive work was inside libvips and LibRaw, both precompiled shared libraries no profile of ours reaches and LTO cannot cross into, and this crate's own hot loops (`warp`, `pairs`, `score`, `apply`) already vectorise at `opt-level = 2` and are all in one crate, so there is nothing for LTO to inline across. A pinned `opt-level = 2` was removed for saying nothing; a full rebuild is 0.4s either way. Half the premise has since moved - the resize and blur are this crate's now, not libvips' - so the measurement is due a repeat; both replacements carry their own SIMD kernels rather than relying on the profile to vectorise them, which is the reason to expect the conclusion to hold rather than a reason to assume it.

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

**B is ten times the throughput of C**, which is what makes staging worth doing rather than interleaving: on a 2000-frame shoot, doing every tile first fills the whole grid in about a minute, where a combined job would take the full eleven that C needs before the last rendition appeared.

**Opening the RAW is not a time sink, so B and C need not share one.** The suspicion was that a fused pass would be needed to avoid opening each file twice, but extracting the embedded preview - `libraw_open_file` plus `unpack_thumb` - is **5ms of B's 124ms**. LibRaw reads headers lazily and the embedded preview is a few MB, so B never touches the sensor data C needs. They can be scheduled independently, which is the whole point.

**A 61MP body embeds a full-resolution preview**, 9504x6336 and 5-14MB of JPEG, not the small preview the name suggests - only the 24MP body in the corpus embeds something small (1080x1616). Decoding that whole to make an 800px tile was most of stage B: 458ms per file, of which 230-540ms was the JPEG decode and, on portrait frames, half of *that* was `autorot` shuffling 60MP. Shrinking during the decode instead (`shrink=` on the loader, then a reduce for the rest) takes B to 105ms.

**The DCT is asked to go all the way to the target**, rather than stopping a factor of two short and leaving the reduce something to work with. It is a quality trade, because libjpeg's scaling and a Lanczos3 reduce are different filters: measured against decoding whole and reducing once, an 800px tile moves from deltaE 0.29 mean to 0.63, and its worst pixels from 7 to 24. The error is confined to fine detail where the two filters disagree - foliage, not sky - and at tile size it is invisible even under a 1:1 crop, which is the whole argument for taking it. Worth 105ms per file against 125ms.

The saving is smaller than the pixel count suggests - a quarter the output pixels for a fifth less time - because the entropy decode is proportional to the *file*, not the output. Huffman-decoding every coefficient block happens either way; only the inverse DCT, the chroma upsample and the colour convert get cheaper.

#### Where the time actually goes

Single-image latency is the wrong measure for an import, and the difference is large enough to change decisions. Throughput on a 24MP frame, 8 cores:

| concurrency | 1 | 2 | 4 | 8 | 12 |
|---|---|---|---|---|---|
| img/s | 0.53 | 1.04 | 1.69 | 2.40 | 2.35 |
| effective ms/img | 1897 | 964 | 590 | 417 | 425 |

It saturates at ~2.4 img/s: 4.5x the single-image rate, and flat past 8. An import is already throughput-bound with every core busy, so per-photo latency work only pays if it reduces total CPU. With the thread pools pinned to one, that budget is decode 495ms (26%), fit 675ms (36%), grade 364ms (19%), the two AVIF encodes 353ms (19%). Measured before the renditions moved to 4:2:0, which roughly halves the encode share (§10.1) and makes the fit a larger fraction of what is left rather than a smaller one.

**Rayon buys ~3% of the fit** (505ms against 490ms with it disabled), which is worth knowing before optimising the scan further. The parallel candidate scan is genuinely parallel but small; what dominates is the sequential refine, a hill-climb whose every step depends on the last. That is also why a GPU is not the obvious answer it looks like - see below.

#### Why not a GPU

Asked twice, because the first answer was framed too narrowly. The work looks like it should suit a GPU - the grade is a per-pixel gather and lookup - and per-image latency is the wrong lens anyway: a batch import has thousands of independent frames, so a device with thousands of weak cores is the right shape in principle.

**Fixed-function AV1 cannot do 4:4:4**, and that used to end the argument. NVIDIA's support matrix gives AV1 as "YUV 420 8-bit and 10-bit" on Ada and Blackwell only; 4:4:4 exists for H.264 and HEVC but not AV1, and neither AMD's VCN 4.0 nor Intel's Arc QSV documents it. Vulkan's `VK_KHR_video_encode_av1` maps to the same silicon, so it inherits the same limit. No hardware *decoder* takes 4:4:4 either.

**That wall moved when 4:2:0 became the default** (§10.1, §10.7). Everything shipped by default is now a profile the video engines encode, so the profile objection no longer rules the fixed-function path out - it only rules out the two settings that turn 4:4:4 back on. What remains is untested here rather than answered: fixed-function encoders are tuned for video at a bitrate rather than a still at a quality, the quality-per-byte comparison against libaom `allintra` has not been run, and it would be a per-vendor dependency for a stage that is already a fraction of an import. Worth revisiting deliberately if encode time ever dominates again; not a settled "no" any more.

**A compute-shader AV1 encoder would sidestep that, and does not exist.** Running the encoder on shader cores rather than the video engine means implementing whatever profile you like, so it is the right question to ask. The state of the art is FFmpeg's Vulkan compute codecs, and the list is FFV1 and ProRes - chosen precisely because they use table-based coding. The barrier is AV1's multi-symbol arithmetic coder: the next symbol depends on the previous one, so a bitstream is a serial dependency chain, and speculation does not go deep.

Batching across images is the right counter-argument and still loses, for a reason that is about the hardware rather than the algorithm. N images give N independent coders, but GPU lanes execute a warp in lockstep, and entropy coding is maximally branch-divergent, so lanes serialise against each other and most of the width is lost. The per-image RDO working set also bounds how many can be resident. The architecture that does work is a hybrid - GPU for transforms, prediction and RDO scoring, CPU for entropy coding - which is what the research does, and which no open-source AV1 encoder implements.

**Demosaic on GPU is real but buys the wrong thing.** NPP's `nppiCFAToRGB` is bilinear with chroma correlation, which is LibRaw's `linear` - measured above as both slower than PPG *and* further from AHD, so the vendor-supported kernel is the algorithm this deliberately does not use. Good GPU implementations exist (darktable's OpenCL kernels, GPL3; Fastvideo's commercial CUDA) but neither is a drop-in. And the stage is smaller than it looks: any rendition under 4864px decodes a 61MP frame at half size, which skips demosaic altogether.

**The RAW unpack is the part that cannot move at all.** ARW and CR2 carry Bayer data in lossless JPEG, whose Huffman decoding is bit-serial - the same objection as the AV1 coder. nvJPEG does not apply, being a baseline DCT decoder. Only Fastvideo claims GPU lossless-JPEG for these formats, proprietary. From the half-size measurements, unpack is roughly half the decode.

So the reachable target is the grade (19% of the CPU budget), plus a demosaic that would be worse, against CUDA as a hard NVIDIA-only dependency and a second implementation of the pixel maths kept in agreement with the CPU one - which has to stay, since the baseline exists for machines with no AVX at all.

**The cheaper lever is the fit**, 36% of the budget and dominated by a sequential refine, so parallelising its axis probes or cutting evaluation count attacks the largest share with no new dependency. The AVIF encoder is *not* a lever: the alternatives were measured and neither beats libaom (below).

**libaom, after measuring the alternatives.** This was settled while the AVIF encode still went through libheif, which can be built against libaom, rav1e, SVT-AV1 or x265 and picks between them by plugin priority. All three AV1 encoders were installed and compared on the 3840px rendition. The encode has since moved to libavif (§10.1), which is libaom and nothing else - so this measurement is what makes that not a narrowing, and the rest of this subsection is why.

| Q | libaom | | | rav1e | | |
|---|---|---|---|---|---|---|
| | ms | bytes | PSNR | ms | bytes | PSNR |
| 60 | 272 | 1.06MB | 33.53 | 1634 | 1.99MB | 34.73 |
| 80 | 404 | 3.50MB | 37.19 | 2300 | 4.80MB | 38.74 |
| 88 | 511 | 5.67MB | 40.13 | 2731 | 6.82MB | 41.50 |
| 95 | 602 | 9.66MB | 44.66 | 3422 | 10.15MB | 45.45 |

rav1e scores better at every Q, which means nothing on its own, because it also spends more bits at every Q. Compared at matched *size* - interpolating rav1e onto libaom's 5.67MB - it lands at ~39.9 PSNR against libaom's 40.13, so the rate-distortion curves are the same within measurement error while libaom is **5-6x faster**. libaom stays.

**rav1e is not slow for want of configuration.** The obvious suspects were checked. The `effort` mapping is not inverted - effort 0 is the fastest for both encoders, so libvips' polarity survives the trip through libheif into rav1e's `speed`. And it is not a missing thread count: measured as CPU time over wall time, rav1e uses *more* cores than libaom (3.7-3.9 against 2.2-3.6) and is still 5x slower, so it is doing more work per output bit rather than doing it on fewer cores. There was also nothing left to set: libvips' `heifsave` exposed no threads, tiles or jobs parameter, so how a plugin parallelised was entirely libheif's business - one of the things calling libavif directly bought back.

Neither encoder saturates the machine, which sounds like an opportunity and is not. An import runs a pool and already saturates the CPU at ~2.4 img/s (above), so per-encode threading would add contention rather than throughput. It would only help the one-photo-at-a-time paths, the on-demand `max` rendition and the lossless export, where 2.2 of 12 threads is genuine idle capacity.

**SVT-AV1 wrote a 201-byte broken file and reported success.** §10.7 records that it implements AV1 Profile 0 only and converts 4:4:4 down silently; through libheif 1.17.6 it did not even manage that - `vips_heifsave` returned 0, and what landed on disk had no valid stream (`missing mandatory atoms, broken header`). Unusable, and unusable in a way that no error surfaced. libheif's `auto` picks by plugin priority, so that was one deployment's package ordering away from a silently corrupt rendition; naming the encoder guarded it, and linking libavif removed the choice.

**The resize and the blur are Rust, and that is a correctness fix before it is a speed one.** libvips did both until the RAW editor needed the same pipeline in the browser, where there is no libvips: the wasm build got a bilinear gather for the reduce and an f64 convolution for the blur, and the two targets then fitted *different lens profiles from the same frame*. Measured against libvips' Lanczos3 on the 6000x4000 -> 1280 reduce a fit actually performs, that gather was **mean 12.4 of 255 off, worst 241** - it reads four of every hundred source pixels and aliases the rest - which is enough to pick a different lens tier on IMG_5360. There is now one `image::resize` (`fast_image_resize`, Lanczos3) and one `fit::blur` (`libblur`, stack blur), both pure Rust, both compiled into both targets, and `fit_from_preview` is a single function rather than a native one and a wasm one that were supposed to agree.

Neither replacement is a compromise made for the browser's sake; both are cheaper than what they replace **and** land where libvips landed:

| | vs libvips | CPU | libvips' CPU |
|---|---|---|---|
| `resize`, 6000x4000 -> 1280x853 | mean 0.87 of 255, worst 6 | 15ms | 255ms |
| `resize`, 1280x853 -> 640x426 | mean 0.11, worst 2 | 1.3ms | 3.8ms |
| `blur`, sigma 6 on 1280x853 | mean 0.60, worst 6 | 1.75ms | 6.5ms |

The 17x on the big reduce is SIMD integer kernels against a general tiled float pipeline, and it is CPU rather than wall time, so it is 17x less machine rather than 17x less waiting. The blur number is against the f64 convolution the wasm build had, which cost 338ms - more CPU than the entire rest of the fit. Only the `matched` grade pin moved, by at most 0.09% of peak on any sample; the `neutral` rows are byte-identical, because no fit runs on that path.

With both gone libvips is down to `decode_upright`, `thumbnail` and `encode_jpeg`, none of which chain, so the lazy `Pipeline` that existed to fuse resize onto blur went with them. `encode_jpeg` now takes pixels straight to `jpegsave_buffer`, which drops the two full-image copies a handle round-trip cost.

**libvips 8.15.1 is the version to write against, not the crate's.** The `libvips` crate targets a later release and its `*_with_opts` helpers send every property their options struct knows about - `tune` for `heifsave`, a `keep` flag for `jpegsave` - neither of which exists in the version Debian and Ubuntu ship. `heifsave` failed outright with ``no property named `tune` ``; `jpegsave` only logged a GLib critical, which is worse, because it looked like it worked. `jpegsave` goes through the raw bindings and names its properties explicitly, keeping the version-coupled part of the dependency to one function. One more of the crate's edges is load-bearing: `VipsImage` derives `Clone` as a shallow refcount copy alongside a `Drop` that unrefs, so cloning one produces `g_object_unref: assertion 'G_IS_OBJECT (object)' failed` on the second drop - hundreds per fit, at one point. Nothing here clones one, and now that the module is two functions wide there is no handle held long enough to be tempted to.

### 10.5 Lossless export

`POST /api/photos/:id/lossless` renders one photo at full resolution into an AVIF kept beside the renditions. It exists because a 3840px rendition is not what you check focus or gradients on, and it is opt-in per photo because it takes real time to build. Unlike every other rendition it is never fitted to a maximum edge: this is the view that gets pixel-peeped. The file is the cache: a second request finds it already there, and `PhotoDetail.renditions.max.built` is a `stat` rather than a column, so it cannot disagree with the disk.

It follows the library's HDR setting, since it is the same render from the same RAW and it would be odd for "view original" to be the one rendition that disagrees with the rest. That includes the Firefox video twin (§10.7): every rendition is the same picture at a different quality level, and they are interchangeable, so each has a video beside it wherever HDR applies. Both stay at native size. The video used to be capped at 8704 rows, which was SVT-AV1's constraint rather than AV1's; libaom takes either orientation, so the twin is now exactly as large as the still it accompanies (§10.7).

**Format.** This was JPEG XL, and the swap to AVIF cost bit depth to buy simplicity. JXL keeps 16 bits where AVIF tops out at 10 here, and at matched quality the files are comparable: 3.42 MB against 2.97 MB on a 24MP frame, 0.34s against 0.48s. What decided it was delivery. No browser decodes JXL without a 1.6 MB wasm module, and the transcode that module needs to hand an `<img>` something it accepts cost more than the entire encode:

| | build | decode | total |
|---|---|---|---|
| AVIF, native everywhere |, | 136 ms | **136 ms** |
| JXL, native (flag) |, | 619 ms | 619 ms |
| JXL, wasm polyfill | 5.2 s PNG transcode | 518 ms | **7.5 s** |

The polyfill's cost was almost entirely the PNG it had to produce: a 121 MB 16-bit intermediate, deflated with dynamic Huffman to save 18% on a buffer that never leaves the tab. A stored-deflate PNG would have cut that to 805 ms, but `jxl-oxide-wasm` exposes no raw framebuffer; only `encodeToPng()`; so there was nothing to hand a faster writer. Deleting the format deleted the problem, along with the wasm, the cICP splicing and the ICC sniffing.

`LOSSLESS_SDR_QUANTIZER` and `LOSSLESS_QUANTIZER` (the HDR one) are both libaom's 0-63, set tight rather than "visually lossless", and kept inside a ~20MB budget on a 60MP frame. The two are separate because 8-bit 4:4:4 and 10-bit PQ do not reach the same picture at the same quantizer.

**Encoding.** Both go through libavif in this process (§10.1, §10.7); the resize is `image::resize` (§10.4). The SDR decode is deliberately 8-bit, because the SDR encode is 8-bit whatever goes in, so a 16-bit decode would be twice the memory for samples it discards. The HDR video is the one rendition that still leaves, to ffmpeg.

An `<img>` rather than a canvas, because a canvas cannot be HDR: neither 2D nor WebGL2 accepts a `rec2100-*` colour space, only `srgb` and `display-p3`, and `configureHighDynamicRange` is absent. An `<img>` keeps the browser's own colour management, HDR compositing, zoom and pan.

On the wasm path HDR signalling rides on a PNG **cICP** chunk (9/16/0/1 = BT.2020 + PQ), inserted after IHDR without touching IDAT; on the native path the tagging already inside the JXL does the same job. Chrome honours both identically: a flat 50% grey reads 128 untagged and 131 tagged, the same shift through the cICP PNG and through a PQ-tagged JXL. A neutral patch is what isolates this, since a primaries change is identity on the achromatic axis and an earlier test against a coloured gradient could not tell colour management from encoder noise. The PNG tag is applied only when the decoded ICC profile actually declares PQ or HLG, since tagging an SDR image would stretch it into HDR range.

**Firefox ignores HDR image tagging entirely**; that same grey reads 128 both tagged and untagged, through cICP PNG and through native JXL alike. Encoding the render as a single-keyframe HDR video to borrow the HDR video pipeline does not rescue it: Firefox 153 exposes no `VideoEncoder` at all, so there is nothing to encode with on the client, and `VideoFrame` rejects every 10-bit pixel format (`I420P10 is unsupported`), so HDR pixels could not be fed in even if there were. A server-side encode would clear that bar, but a PQ-tagged AV1 still shows the same flat-grey value as a BT.709-tagged one in Firefox, so the tag buys nothing today. Untested on an actual HDR display: this machine reports `(dynamic-range: high)` false, and a virtual display advertises no HDR EDID, so only signalling can be verified here, never output.

`libraw_set_output_color` currently pins sRGB, so nothing produced today is HDR: the delivery path is ready for it, the decode is not.

The default for newly indexed photos is the library's `rendition_source` (§10.1). Changing it is deliberately not retroactive: rebuilding an existing catalogue is a job the user asks for explicitly, not something a preference does to thousands of files in the background. `POST /api/photos/:id/renditions/:r?force=true` is that explicit request, one photo at a time, from the viewer that is showing it - there is no bulk re-render, because a selection's worth of RAW renders is minutes of work for pixels nobody has asked to look at.

### 10.6 Orphaned files

Generated files are named `<photoId>.<ext>`, and photo ids are minted per insert, so a catalogue rebuilt over the same folder gives every file a new id and strands the old ones. Nothing in the normal write path notices: processing rewrites renditions in place, and the only unlink is a failed job cleaning up its own partial output.

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

So an HDR rendition is **two** files: an AVIF still and a one-frame AV1 video beside it, both PQ.

There were six for a while, and a page at `/hdr-check` to look at them on: the same photo also as a 4:2:0 AVIF baseline control, and each of the three with an SDR reference to compare against. It answered the question it was built for - HDR output cannot be observed from script, since anything read back through a canvas has already been tone-mapped, so the only way to know whether a file lights up a panel was to put it next to one that should not and look. Once that was settled the page was a diagnostic nothing in the product reached, and it kept a whole second encode path alive behind it: an SDR variant with its own transfer and gamut conversion, a 4:2:0 medium, six renditions per photo, and a directory tree of its own under the data path. It is gone, and this section describes what ships. HLG was dropped: everything that renders HDR renders PQ, and PQ is absolute where HLG is relative to the display's own range. Encoding client-side was ruled out. Firefox 153 exposes no `VideoEncoder`, and `VideoFrame` rejects every 10-bit pixel format (`I420P10 is unsupported`), so there is neither an encoder to call nor a way to hand it HDR pixels.

**Decode.** This is the path that makes anything HDR, and until it existed nothing the server produced was. `decodeRaw(..., 'rec2020-linear')` asks LibRaw for Rec.2020 primaries (`output_color=8`), an identity gamma curve, and `no_auto_bright`. The last one matters most: auto-brightening normalises exposure, which spends exactly the headroom above diffuse white that carries the HDR. The result is scene-referred, so a normally exposed frame's mean sits far below the sRGB render's; which is what the integration test asserts, since a decode that quietly stopped applying these would still produce a plausible-looking file.

**All of this is in `native/rawshim`** - the grade, the colour fit, the argv and both child processes (`tone.rs`, `hdr_fit.rs`, `hdr_args.rs`, `hdr.rs`). It was TypeScript, and the graded frame was written to ffmpeg's stdin from there: ~115MB at 24MP and ~366MB at 61MP crossing the FFI boundary to reach a consumer that was never on this side of it. One call now takes a path and a job and produces the file, so a still and its video twin still share one decode without the samples ever leaving.

The argv construction moved with it rather than staying behind, which is the right split even though the argv holds no pixels: leaving it in TypeScript would have meant the encoder's settings living apart from the encoder invocation, and the two only make sense together.

**The port was held to a pin rather than to judgement** (`hdr_pin.integration.test.ts`). Neither half could be verified by "the tests still pass": the argv carries colour signalling whose loss is invisible until a browser declines to treat a file as HDR, and the grade's failure modes look like ordinary pictures. So the TypeScript's output was recorded first - 192 argv rows across the variant/medium/size/edge matrix, and the graded samples for five cases - and the Rust was required to match. It did: **the argv identical across all 192 rows, and the graded samples bit-identical on all five cases**, every one of ~29.6M `u16` samples. The variant dimension has since gone with the SDR reference, leaving 60 rows; the surviving ones were unchanged by that removal.

Worth recording how nearly that pin was useless. Perturbing the BT.2390 knee changed nothing, because `eetf` returns early when the frame already fits the display: at 1000 nits the fixture never reaches the roll-off, so the pin covered none of the subtlest arithmetic in the grade. Two `peakNits=203` cases fixed it, and a 0.5 → 0.501 shift then fails. A pin nobody tries to break is a pin that proves nothing.

**Encode.** Both media are **libaom in all-intra mode**, 10-bit, diverging in container and in whether their chroma is negotiable: the video is 4:2:0 because nothing else decodes, and the still is 4:2:0 by default with a setting to raise it.

**The PQ transfer is applied once, on this side, for both** (`tone::encode_pq`). It used to be applied wherever the encode happened - by libavif's caller for the still, by a `zscale` call in ffmpeg for the video - which is the same curve computed twice and, worse, left the two encoders holding frames in *different domains* between the grade and the encode. Nothing that belongs in between could then be written once, which is what the output sharpen (§10.9) needs. With the frame already PQ, `zscale` is told `tin=smpte2084` and does no transfer work at all; what is left there is the YCbCr matrix, the range and the depth.

It cost nothing to move and settled a question the differential had been living with. Measured on a 45MP CR3 at 3840, the video is SSIM 0.980264 against a near-lossless reference where it was 0.980266, and the still is byte-identical. And `avif_still.integration.test.ts` now finds the two still routes **byte-identical at 4:4:4** - both handed the same PQ samples, both applying the same matrix - where they used to sit ~60dB apart on the intermediate quantisation. 4:2:0 still parts company, zscale and libavif subsampling chroma their own ways. That took the differential's own guard with it: "not infinite" was how it proved its two arms had really taken different routes, so the route is now reported out of the library and asserted directly.

**The still is encoded in this process, by libavif** (`avif.rs`). `avifenc` is a thin wrapper around that library, and what it was adding over ffmpeg is the nclx `colr` box - which is what Chrome reads to decide a still is HDR, and which ffmpeg's avif muxer does not write. libavif writes it just as well when called directly, so the binary bought nothing the library does not, and cost three moves of the whole frame: the graded samples written to ffmpeg's stdin, converted, written again as y4m, and read back by avifenc. That is 56MB at 3840 and ~366MB at native resolution, moved three times, for a picture neither process wanted kept. Linked, it is a pointer.

What ffmpeg was doing on that path was `zscale`, and it is two things already here: the PQ transfer, which is `tone::pq` - the same curve the roll-off is computed in - and the Rec.2020 matrix with its limited-range quantisation, which is libavif's own `avifImageRGBToYUV`. Nothing was reimplemented that one side or the other did not already own.

**It costs memory, and that is the trade rather than a footnote.** What the child processes used to hold in their own address spaces and free on exit, this process now holds itself. Multiply the whole of it by `processing_concurrency`.

Measured as peak RSS - `VmHWM`, not arithmetic - building a native-resolution HDR still from the 24MP fixture, where one frame of 16-bit RGB is 145MB:

| | peak RSS |
|---|---|
| every stage allocating its own output | 1227MB |
| grade and transfer in place | 1092MB |
| + decode released once the grade has copied out of it | 1090MB |
| + all four | **954MB** |

Four buffers went, in every case because nothing else was reading them:

- **The grade** allocated its output. It is sample-for-sample at the same index, and by the time it runs the frame is one this side allocated - the warp's output, or the resize's - so `tone::grade` writes into that.
- **The transfer** allocated another. Same argument, and there is no longer a caveat: it runs once in the graded buffer before either encoder is handed anything, so the pair reads one PQ frame rather than the still copying it to avoid transferring the samples out from under its twin. `encode_still` keeps its `Cow` for the other half of the argument - an owned frame goes into libavif and is dropped as soon as the YUV conversion has read it.
- **The decode** stayed resident until JavaScript dropped the handle, which is after the encode - the longest stage of the job. It is owned in Rust now, and the last reader is handed it outright rather than lending it (`hdr::Decode::Owned`), so it is dropped the moment the grade has copied out and before the encode allocates anything. The 8-bit side needs nothing special: the base is built in a scope, and the decode goes when that scope ends.
- **The interleaved RGB** was held across `avifEncoderWrite`, though libavif stops reading it once `avifImageRGBToYUV` has filled the planes. It is dropped there instead, which matters because of what allocates next.

**What is left is libaom, and it is most of it.** Probed inside `write_avif` on the same frame: entering the encode is 239MB, the YUV planes add 138MB, dropping the RGB gives that back, and `avifEncoderWrite` alone then takes the peak to ~950MB. So roughly **700MB is libaom's own working set** for a 24MP 10-bit 4:4:4 all-intra frame, against ~145MB of ours. Two things follow. Copy elimination is close to done - the only frame this side still holds through the encode is the YUV planes libaom is reading. And that working set is *not* a threading trade: measured under `taskset`, two cores against eight moved the peak by under 30MB, so it is per-frame state and there is nothing to buy back by capping `maxThreads` or the tile count. Going lower means a different encoder, or an API that encodes in tiles, and libavif exposes neither.

**The still is 4:2:0, and that is a memory decision rather than a quality one** (`hdr_still_full_chroma` turns it back to 4:4:4). Dropping the still's chroma to a quarter of its samples halves what libaom has to carry, and libaom is the peak. On the 24MP fixture, everything else held - same decode, same fit, same grade, same speed:

| | wall | CPU | peak RSS | bytes | SSIM |
|---|---|---|---|---|---|
| 4:4:4, `full` at 3840 | 456ms | 1.90s | 457MB | 1.09MB | 0.9793 |
| 4:2:0, same quantizer | 330ms | 1.45s | 420MB | 0.41MB | 0.9681 |
| 4:2:0, quantizer matched to that SSIM | 339ms | 1.71s | 420MB | 1.64MB | 0.9791 |
| 4:4:4, `max` native | 1181ms | 4.03s | 960MB | 3.40MB | |
| 4:2:0, `max` native | 805ms | 3.07s | **586MB** | 1.76MB | |

Read the first two rows together and 4:2:0 looks free - a third off the clock and 62% off the file - but they are not the same picture. Held to the same combined SSIM it needs 51% more bytes.

**That combined figure oversells the damage, though, and the per-plane split is the honest version.** 4:2:0 leaves luma untouched by construction, so at a matched quantizer the Y plane is identical and the whole cost lands in chroma:

| | Y | U | V | All | bytes |
|---|---|---|---|---|---|
| 4:4:4 crf 20 | 0.9747 | 0.9779 | 0.9853 | 0.9793 | 1.09MB |
| 4:2:0 crf 20 | 0.9747 | 0.9516 | 0.9781 | 0.9681 | 0.41MB |
| 4:2:0 crf 12 | 0.9898 | 0.9655 | 0.9821 | 0.9791 | 1.64MB |

So at equal bytes 4:2:0 does not lose - it *reallocates*, spending on luma what it saves on chroma, which is the trade every photographic delivery format already makes and roughly the one human vision asks for. A combined SSIM weights the three planes near enough equally and vision does not, so "51% more bytes at equal SSIM" measures the metric as much as the picture. The earlier draft of this section read that number as a straight quality loss; it is not.

What is unambiguous is time and memory: ~26% off the wall clock even at matched quality, and at native resolution the peak goes from 960MB to 586MB.

So the setting is offered as what it is - spend memory and time to hold chroma detail on saturated edges - rather than as a quality slider. Off is the default because the encoder's working set is the constraint that actually bites, and a library that would rather spend the RAM can say so.

Three things follow the setting and all three have to agree, which is why the argv pin carries chroma as a dimension: zscale's output pixel format, avifenc's `--yuv`, and whether `target_size` forces even dimensions. That last one is not cosmetic - 4:2:0 has no odd dimensions, and only a native-resolution frame can arrive odd, since the masked-border crop takes asymmetric insets off it. Passing `--yuv 444` while feeding a 4:2:0 y4m silently encodes 4:2:0 anyway, which is how the subsampling went unnoticed once, so `avif_still.integration.test.ts` now runs its differential at both settings.

The video does not follow it. 4:4:4 video is AV1 Profile 1, which Chromium refuses outright and no hardware decodes, so the twin is 4:2:0 whatever this says.

Note where the peak lands once it is on: at 4:2:0 the encode falls to 420MB, which is exactly the decode's transient, so the binding constraint moves off libaom and onto LibRaw (§10.4) and further encoder tuning stops paying.

Removing three transfers of a frame across a process boundary and keeping the rest in the server is the shape of the deal.

**Budget off the rendition, not off the sensor.** The native-resolution export above is the on-demand `max` path, one photo at a time. What runs `processing_concurrency` deep is the import, and that builds `full` - so the numbers to plan a machine around are these, measured the same way:

| | peak RSS |
|---|---|
| `full` at 3840, still only | 455MB |
| `full` at 3840, still + video twin | 510MB |
| `max` at native resolution | 954MB |

**The twin's 55MB was one graded frame, and it is gone.** It was the one case that could not PQ-encode in place; with the transfer applied once for both (above) there is nothing to copy, and the two rows now peak identically - re-measured on a 24MP frame at 3840, both 338MB, on a machine where the rows above were recorded elsewhere. The absolute figures are left as they were taken; what the re-measurement establishes is the difference between them, which is now none. **The denoise and the sharpen do not move this**, which took work rather than luck: they run in horizontal strips precisely so their scratch does not scale with the frame (§10.9). ffmpeg's own process still sits on top of all of these.

**A larger sensor does not cost more here**, which is worth writing down because it reads backwards. Both terms that scale are driven by the *output*: the graded frame is the rendition's size, and libaom's working set runs about 25MB per megapixel of it. The decode is the only term the sensor drives, and the bigger sensor is the one that gets halved - a 61MP frame at 3840 halves to 15MP, where a 24MP frame at 3840 does not halve at all and so decodes *larger*. Measured on the 24MP fixture, asking for an edge low enough to trigger the halving takes the decode's transient from 420MB to 178MB. A 61MP `full` therefore lands within noise of the same ~455MB, and only `max` - where the output *is* the sensor - grows with it.

**Held to the binary rather than argued about** (`avif_still.integration.test.ts`). `BOWERBIRD_AVIFENC=1` puts the encode back on the two child processes, and the two are required to agree on everything a browser reads: dimensions, pixel format, range, and the CICP triple. They used to sit **59.7dB PSNR** apart, about one code value at 10 bits, because the linked path quantised to 16-bit PQ before libavif took it to 10-bit YCbCr where zscale went straight there. Both are handed the same PQ samples now, so at 4:4:4 they are **byte-identical** and only 4:2:0 differs, on the chroma subsampling. The `colr` box comes out byte-for-byte identical either way, which is the part that decides whether the file is HDR at all.

The video still goes out through ffmpeg, because what it needs there is the MP4 muxing rather than the encode, and libavformat is a much larger swallow than libavif was.

**`allintra` is the whole of it.** The video was SVT-AV1, on the measured claim that it is 2.4x faster than libaom. That is true of libaom driven the way ffmpeg drives it by default, and beside the point: SVT-AV1 is built for sequences and cannot use the inter-frame parallelism its threading is designed around when it is handed a single frame. `-usage allintra` is what avifenc had been doing to libaom for the still all along. Measured at 3840 on a 24MP frame, at matched quality (SSIM 0.97998 against 0.97986) and the same file size, **233ms against 1175ms**. Two flags travel with it and are not incidental: `-b:v 0`, without which `-crf` is a cap on a bitrate target rather than the quality knob it reads as, and `-tiles 2x2`, because libaom parallelises across tiles and idles its threads without them. The still gets the same treatment through `--autotiling`.

**The CRF scales were never the same, and that was invisible.** `hdr_crf` fed avifenc's `--max`, which is libaom's quantizer, *and* SVT-AV1's `-crf`, which is its own - so one setting meant two different qualities, and measured on a 4:2:0 frame the offset was about 0.62: SVT crf 20 lands where libaom crf 12 does, SVT 8 where libaom 5 does. Nothing depended on the video's value having been tuned, because it never was; it inherited the still's number.

**And moving both media to libaom did not fix it, which took a year and an HDR display to notice.** The still was handed to libavif as the quantizer *pair* `--min 0 --max N` - the shape avifenc uses - and **libavif quantises on the midpoint of that pair**, so every AVIF this app has ever written encoded at half the number the setting named, while the video's `-crf` was read by libaom literally. One setting, still two qualities, and the second version of this section claimed otherwise as confidently as the first.

It is visible where a still and its twin sit side by side. Measured on a 45MP CR3 at 3840, `hdr_crf` 20 on the old scale, both against a near-lossless reference encode of the same graded frame:

| | SSIM | bytes |
|---|---|---|
| AVIF still | 0.9802 | 1.53MB |
| AV1 video twin | 0.9529 | 0.46MB |
| AV1 video twin at half the setting | 0.9803 | 1.45MB |

Which is what a user reported as blocking, noise and chroma loss in Firefox against a clean AVIF in Chrome, on one library with one set of settings.

So the encoder is given **both ends of the pair**, and every quantizer default is halved to match - `hdr_crf` 20 to 10, the two rendition quantizers 26 to 13, the two lossless ones 16 and 8 to 8 and 4. That is a rescale rather than a quality change: verified on the same frame, the still comes out **byte-identical** either way, and the video joins it. A tuned value already in the settings table is halved by a migration, stamped in `PRAGMA user_version` because a value the user chose is indistinguishable from one already rescaled and halving twice would double every rendition.

The quantizers in the tables above are on the old scale, being measurements taken under it; halve them to read them as the setting now means.

The lesson is the same one §10.7 keeps earning: the claim "both media are libaom now, so the setting means one thing" was **inferred from the encoder, not measured through it**. Two encoders sharing a codec do not share an API, and the API is where this was lost.

**A correction worth keeping, now four times over.** This section once said both media were libaom at 4:4:4 and that SVT-AV1 "cannot be used here at all"; that was corrected to describe the SVT-AV1 video actually shipping; then back to both being libaom, for a different reason than it was first written, with the chroma half still wrong. It said the still is 4:4:4 "because it is a photograph". It is 4:2:0 by default now, and the sentence it replaced was not so much wrong as unmeasured - the per-plane numbers above say 4:2:0 reallocates detail rather than losing it, which nobody had checked while the claim was being repeated.

Both media are Profile 0 unless a setting says otherwise, and the video has no setting: 4:4:4 video was tried and reverted, being AV1 Profile 1, which Chromium refuses outright, Safari cannot hardware-decode, and Firefox/Windows played while rendering washed out - PQ code values shown with no transfer applied, which is what a decode that never reaches the HDR compositor looks like.

The lesson the fourth rewrite earns is narrower than "check the code": every version of this paragraph was written from a plausible principle about photographs, and each one survived until somebody measured it. A claim here about what an encoder setting is *worth* wants a number beside it or it should not be stated.

**4:4:4 is not a setting, it is an AV1 profile**, and that decides the encoder. Profile 0 is 4:2:0, Profile 1 is 4:4:4, Profile 2 is 4:2:2. SVT-AV1 implements Profile 0 only and *converts silently* - asking it for 4:4:4 or 4:2:2 yields 4:2:0 with no error - which is why it could never have served the still, and why the libheif path had to name its encoder rather than leave the choice to plugin priority. libaom and rav1e implement all three; libaom is what both media use. Measured decoder support:

| | 4:2:0 | 4:2:2 | 4:4:4 |
|---|---|---|---|
| AVIF still, Chrome and Firefox | yes | yes | yes |
| AV1 video, Chrome | yes | no | no |
| AV1 video, Firefox | yes | yes | yes |

Chrome refuses Profile 1 and 2 video outright (`MEDIA_ERR_SRC_NOT_SUPPORTED`), and `canPlayType` in Firefox reports `"no"` for them while playing them anyway - dav1d decodes every profile in software. Since the video exists only for Firefox, Chrome's refusal costs nothing: Chrome is served by the still. Not VP9, whose colour signalling does not survive this ffmpeg build and which has no metadata bitstream filter to put it back; not HEVC, which Firefox would not play at 4:4:4 at all.

**The 8704-row cap went with SVT-AV1, and it was its constraint alone.** SVT-AV1 caps height at 8704 and does not cap width - measured, not read off a spec: 16384x4096 and 12288x4096 both encode, 6336x9504 does not, and the encoder says why in its own words, `Source Height must be less than or equal to 8704`. Only the full-resolution video was large enough to meet it, and it was squashed to that height, losing the last 9% of a portrait frame. libaom takes either orientation - the same 6336x9504 encodes in 721ms - so the cap is gone, the native-resolution video has its full height back, and the one case where a still and its twin could come out different sizes is gone with it. That case was the only one that needed the frame grading twice, so `encode_pair` no longer has a second-grade path at all.

The **mastering-display and content-light metadata** went with SVT-AV1 too, reaching it through `-svtav1-params`, for which libaom has no equivalent. No loss anything reads: those are tone-mapping hints, and Firefox 153 - the only browser the video exists for - does none. The load-bearing signalling is the CICP, which survives on both media.

**The y4m goes down a pipe, not through a file** - on the reference path, which is all that still uses it. Writing 56MB out only to read it straight back is a round trip through the page cache, or the disk on a machine short of it, for bytes neither process wants kept. `avifenc --stdin` takes it directly; the flag has to precede the output path and forbids an input one beside it. The production path does not write it at all.

**The rule holds again.** §10.4 states it as *pixels cross only on their way into an HTTP response* - and the encoders were the standing exception, three full-frame transfers across two process boundaries on every HDR still. With libavif linked, the still obeys it. The video does not yet, and that is the one place left where a frame leaves this process for anything but a socket.

**One decode serves the still and its twin.** They are two ways of writing down the same photograph and share everything up to the grade, so they are one worker job with one decode and one graded frame between them (§10.8.1).

### 10.7.1 Grading scene-linear to display-referred

The decode is scene-referred, and scene-referred data carries no exposure: LibRaw scales sensor saturation to full range whatever was metered. Tying linear 1.0 straight to the display peak therefore made brightness a function of the exposure rather than of the subject - measured over eight bodies, a 9.3x spread in mean brightness, with every clipped frame flat against the peak. `native/rawshim/src/tone.rs` grades the samples before they reach ffmpeg, and the same eight frames come out within 2.5x with nothing clipping.

Two ITU standards do the work, so no look had to be invented:

- **ITU-R BT.2408** puts diffuse white at **203 nits** (`HDR_REFERENCE_WHITE_NITS`), the value that makes HDR read at the same brightness as the SDR beside it.
- **ITU-R BT.2390** §5.4.1 supplies the **EETF**, a Hermite roll-off applied in PQ space that compresses everything above the display's peak into it rather than clipping.

Neither standard says *which* sample is diffuse white, because a camera takes that from the metered exposure and a raw file has no rendering intent. `HDR_WHITE_QUANTILE` (default 0.90) picks it from a histogram - the same heuristic dcraw's auto-bright uses - and is the knob to reach for if a library renders consistently dark or hot.

**A lower quantile renders brighter**, which is the opposite of the obvious reading: it places diffuse white further down the histogram, so everything above it scales up. The default was 0.99 and it was too high for landscape work. On a daylight frame that is half sky, the brightest 1% *is* sky and specular cloud edges rather than a lit white surface, so the anchor sat where the headroom should have started: peak 470 nits, greenery at 40. Measured on that frame, only **0.002% of pixels** are within a whisker of sensor saturation - a genuine specular tail of ~4,600 out of 60M - while p99 sits a full 1.21 stops below it. At 0.90 the same frame peaks at 823 with its greenery at 70.

The alternative would be normalising the brightest sample to the display peak, and that is precisely what the grade exists to avoid: it makes a photo's brightness depend on whether one glint happened to clip, which is what produced the 9.3x spread in the first place. Place diffuse white correctly and the tail lands wherever the scene actually put it.

The **peak is read off the frame, not off sensor saturation**, and that is what makes the grade exposure-invariant: both the white level and the peak scale with exposure, so their ratio, and therefore how much roll-off the highlights get, is a property of the scene. Anchoring the peak at sensor clip instead would give a frame shot two stops down four times the compression for the same subject.

**Both ends are quantiles, and the top one had to become one.** The peak was the frame's brightest sample, over a strided subsample - which makes it a property of *one pixel* and of how many pixels happened to be read, rather than of the scene. Two consequences, both measured on the 24MP fixture across a full decode, a half-size one and a box-resized one of the same frame:

| top-end statistic | spread across the three |
|---|---|
| maximum | **22.7%** |
| p99.999 | 0.73% |
| **p99.99** (`PEAK_QUANTILE`) | **0.29%** |

A maximum over a subsample also inherits the subsample's size: a full decode read 1.51M pixels and a halved one 379K, and the smaller read came back 0.76% *higher* because the two errors ran in opposite directions and happened to cancel. So the reading is now a fixed **1M samples at proportional positions**, and the top end is the 0.9999 quantile of them - the top ~105 samples, enough to estimate, where p99.999 is the top ten and measured less stable for being nearly a maximum again.

It clips what sits above it. That is not new - the matched arm already clamped to whatever its subsample found - but it is now explicit and repeatable rather than a function of the decode's size. Measured against the previous grade on the fixture: **SSIM 0.998**, with the per-channel means unchanged to four figures on four of the five pinned cases. The fifth is the low-peak roll-off case, which comes out 3.5% brighter, because a peak that no longer chases one specular sample asks the EETF to compress less of the picture to accommodate it - the same argument the white quantile makes at the other end.

**Renditions of one photo should agree, and now nearly do; they never will exactly.** A half-size decode is its own demosaic rather than a downscale of the full one, so resampling both to the fit grid gives slightly different planes however the statistics are read - about 0.5% on the fitted colour matrix. The goal is that nothing makes the gap *larger* than that for no reason, which is what the maximum was doing.

The curve is baked into a 65536-entry lookup table, because a 60MP frame is 180M samples and `pow()` that many times is not free. It runs **once per job**, not once per output: the still and its video twin are the same grade at the same size, so they share one graded buffer and differ only in what the encoder does with it.

`HDR_PEAK_NITS` (default 1000) is now only the declared mastering peak and the roll-off target - no longer the exposure control - so it sets how much headroom sits above diffuse white. It is not interpreted the same everywhere: Chromium renders HDR stills relative to SDR white and caps headroom at 4 stops, while Firefox 153 does no tone mapping at all, so it is a knob to set against a display rather than a value that transfers.

Three traps, all silent:

- **The encoder discards the primaries and transfer** however the `-color_*` options are set, producing a file that reports `color_primaries=unknown`. Measured on SVT-AV1 and still true of libaom, which is why the `av1_metadata` bitstream filter writes them back into the sequence header on whichever encoder is in use. Without it the encode succeeds and the result is not HDR, which is why a unit test pins the exact CICP numbers and an integration test reads them back with `ffprobe`.
- **Frames are fitted to the rendition's own longest edge**, in linear light before the transfer is applied - resizing after it would average PQ code values and darken the result. The fit is done by `box_resize_u16` before the grade rather than by `zscale` after it, since grading 61MP to produce a 3840px rendition threw away fifteen sixteenths of the most expensive stage (§10.8.1).
- **The renditions outlast a request.** `Bun.serve` idles a connection out after 10s by default and the client sees a closed socket rather than an error, which reads as a crash. `idleTimeout` is raised to Bun's 255s maximum; the lossless render (§10.5) was already close to the old limit on a large frame.

**Confirmed on a real HDR Android display**, Chrome: both the AVIF still and the one-frame video render visibly brighter than their SDR references, so both paths work. Two things worth keeping from that run. `dynamic-range` reported `high` while `video-dynamic-range` reported `standard`, and the video was plainly HDR regardless: the video-plane query describes bi-plane devices like TVs, cannot be answered without knowing whether a given frame reaches a hardware overlay, and is not something to gate on. And the video looked sharper than the still until `image-rendering: pixelated` was applied to both, at which point they matched. That is Chrome's scaler, not the encode: measured against the frame both were encoded from, the still scores *better* (SSIM 0.9932 against 0.9923) at twice the bitrate. The `<img>` path filters a downscale properly; the video plane scales more cheaply and the resulting aliasing reads as detail.

**A blank video row is usually the codec, not the tagging.** Firefox on Android ships `media.av1.enabled` off for battery, and Safari has no software AV1 decoder at all; it plays AV1 only where the hardware does, so Intel Macs, M1/M2 Macs and iPhones before the 15 Pro cannot, however current their Safari. Both failed all three videos identically, SDR included, which was the tell: an HDR problem would have spared the SDR reference. Neither gap is worth working around, because both of those browsers decode the AVIF stills, which is the path that matters on their platforms; if an Apple video path were ever wanted it would be HEVC 10-bit, hardware-decoded on every Apple device.

### 10.8 Matching the camera's own rendering (`fit.rs`)

A render carries none of what the camera would have done to the same frame: not the maker's colour science, and not the picture profile the photographer chose on the body. Buying that normally means sourcing, storing and hosting a lens profile and a colour profile per body, which is tedious where it is possible and impossible where a maker never published one - and it still cannot honour a per-shot setting. Everything needed is already inside the RAW, in the JPEG the camera put there. `MATCH_EMBEDDED_JPEG` fits the transform that takes a render to that JPEG, and applies it to every rendition built from a render - SDR here, and HDR through §10.8.1, which reuses this section's geometry and falloff as fitted and refits only the colour.

**Geometry first, colour second, and the order is not negotiable.** A colour transform is fitted from pixel pairs, and a pair means nothing unless both pixels show the same point in the scene. On a frame whose JPEG is distortion-corrected, fitting colour first plateaus at ΔE76 16 however much capacity the colour model is given - per-channel curves, curves plus a 3×3 matrix, and a 33³ 3D LUT all land within 1.5 of each other - because no tone curve can map a pixel onto a different pixel's colour. Correcting geometry first takes that same frame to 1.51. The corollary is that the geometry stage cannot use colour as its matching signal.

**Geometry is read where the camera recorded it.** Sony writes a distortion spline at `IFD0` → SubIFD (`0x014a`) → tag `0x7037`: an `SSHORT` array whose first element is the knot count, the knots evenly spaced from frame centre to corner, in units of 1/16384 of the half-diagonal and anchored at zero in the centre. Plain TIFF parsing reaches all of it; none of Sony's enciphered `0x94xx` blocks are involved. Validated against an independent fit of the render against the JPEG - at 28mm the spline says −2.83% at the corner and the fit says −2.78% - and the values track focal length per shot rather than coming from a table, the 28-75 zoom crossing zero near 32mm and reaching +4.5% at 75mm. Three things do not generalise and must not be assumed: the **knot count is per body and per tag** (ILCE-7CR 16, ILCE-6300 11, and within one RX100M3 file the vignetting tag uses a different count from the distortion one), **a body may record nothing at all** (of 1000 frames sampled across the catalogue every Sony frame carries a spline and only the Canons go without, which is what the lensfun tier below exists to serve), and the **vignetting tag `0x7032` must not be applied** - it describes a corner gain of +50% where the measured scene-linear ratio between the corrected render and the JPEG is flat, so applying it would inject a ~35% corner error.

**The body also says whether it used the correction, and that is worth asking before searching for one.** The SubIFD is written as flag/params pairs - `0x7031`/`0x7032` vignetting, `0x7034`/`0x7035` chromatic aberration, `0x7036`/`0x7037` distortion - and `0x7036` is 0 when the camera corrected nothing. The "on" value is not a single constant (1 and 17 both appear), so anything non-zero reads as on rather than matching a list that goes stale on the next body. It predicts perfectly in the direction that matters: across 120 sampled Sony frames every one of the 17 fits that searched and then fell back to no geometry had `0x7036 = 0`, and it never happened on 1 or 17. Taking the camera at its word skips the curve axis, which is most of what a search costs.

**It does not skip the scale, and it used to.** "The body corrected nothing" is a statement about undistortion, not about framing, and the two are separate: an ILCE-6300 with the flag off still lands on `crop≈0.996`, an EOS R8 on `0.995`. A ~0.4-0.5% rescale that survives across bodies with unrelated optics reads as a difference between LibRaw's visible area and the camera's own framing rather than as a lens (same family as §10.4), and dropping it cost a median ΔE76 of +0.21 on the frames the gate fired on. The scale is now fitted there too - one crop axis, no curve - which put the DSC02981 fixture from ΔE 0.6500 to 0.5634.

**Where the body recorded nothing, the lensfun database is asked before the geometry is fitted** (`native/rawshim/src/lensfun.rs`). It is a system package: ~4MB of XML with ~1300 lenses, LGPL-3 library and CC BY-SA 3.0 data, so it ships in the image rather than being fetched. It answers for 27 of the 32 Canon frames sampled and for every fixed-lens compact, and it is cheaper than fitting from nothing because a known curve needs only a gain scanned against it where an unknown one needs the whole `k1` grid. What it buys is shape: lensfun's curves are mustache, dipping barrel mid-field before turning pincushion at the corner, which a single `k1` cannot express at any coefficient.

**Second, not first, and that was measured.** Over 83 Sony frames carrying both, the body's spline beat lensfun 31 times to 4 with 48 ties, by a mean 0.034 ΔE76 and up to 0.86. The reason is in the numbers: a spline is recorded per shot, so one FE 40mm prime ranges from −0.69% to −3.09% at the corner across a session as focus distance moves it, while lensfun has one profile per lens and answers −2.10% every time. Where an entry is simply wrong the gap is larger - lensfun has the Tamron 28-75 at +0.64% where the body says +4.7%, and the body wins by 0.55.

**The database's search is scored, not exact, and the guard matters more than the match.** `FindLenses` returns everything that scored above zero, ordered, so a 16mm prime is a candidate for a 150mm frame; the first entry whose focal and aperture ranges the file does not contradict is taken. That is the only part of a match checkable against the file rather than trusted. Exact matching is not an option worth having: of the 8 lens strings in one Canon library, **zero** match a database name byte-for-byte - the body writes `RF24-105mm F4 L IS USM` where lensfun has `Canon RF 24-105mm F4L IS USM`. The scored search resolves all 8 on the first hit.

**Knots are sampled out of a modifier, not evaluated from the stored polynomial.** lensfun's coefficients live in its own normalised coordinates, that normalisation appears nowhere in the header, it has changed between releases, and the ACM model uses another one again. Sixteen 1×1 calls read the mapping the library actually produces, cannot drift from it, and cost ~0.7ms - against which a resolution cache is bookkeeping. The cache is in memory and holds negatives, which is the half that earns it: without them every frame from an unlisted lens pays the full search to be told no again.

**The spline carries no overall rescale**, being anchored at the centre, while the camera also crops and rescales to keep the frame full. That one scalar is fitted, but only over the crops that *do* fill: tightest-fill is the loosest candidate and the search runs downward from it, because for barrel the camera is more conservative than tightest-fill. Nothing looser is a picture a camera could have produced, and the residual cannot be trusted to say so - a black margin is skipped by the pair gate, so a crop that leaves one scores exactly as well as the crop that fills and can win on noise. It did: across 32 EOS R8 frames, 26 were shipping a corner ratio above 1 - up to 1.0102 on a +1.73% lensfun profile, with visible black wedges where the correction had pulled the picture in.

**A known curve is applied at a fitted strength, not at face value.** Every search is now one shape - a one-parameter family of curves against slack below that family's fill crop (`fit_family`) - and the tiers differ only in what the parameter means: a gain on the knots where a curve is known, `k1` where it has to be found, and nothing at all where the body says there is no curve. Expressing crop as slack rather than an absolute scale is what makes the joint search behave, since a step along the curve carries its own fill crop with it instead of trading against it.

The gain earns its axis, because a database profile is one average of every copy of a lens and measurably not what a given body did. Over 32 EOS R8 frames the ones lensfun calls barrel wanted **more** than it states - gains of 1.3 to 3.0 - while the pincushion ones wanted about **0.4** of it. Gain 0 is in the grid deliberately: it is the rescale-with-no-curve candidate, so a curve losing no longer takes the scale down with it, which is what left IMG_0622 shipping no geometry at all when the scale alone was worth 0.22 ΔE76. Measured over those 32 frames plus both fixtures, mean ΔE76 **2.1648 → 2.0752**, best case −0.45, one regression of +0.06 where the wider grid lands the coarse scan in a different valley. Fits are ~1.7x slower.

**The output resamples through a cubic; the fit resamples through a bilinear.** They want different things from a filter and it is worth spending the taps in only one of them. Bilinear's softening is *radial*, which is what made it visible: the warp holds the frame centre fixed, so near the centre it lands on whole pixels and returns them untouched, while at the edge the displacement is ~23px at 3840 with an effectively arbitrary fractional part - and bilinear at half a pixel is a two-tap box blur. Sharp middle, soft edges, against a camera JPEG that is sharp to the corner. Catmull-Rom (B=0, C=½, four taps per axis) recovers a mean **+25%** of the edge gradient across six frames, +19% to +28%, and costs nothing measurable because the output warp moved from the fit's serial `warp` to the parallel `warp_planar` in the same change. The fit keeps bilinear on purpose: both its images are blurred at σ3 before anything is compared, so there is no detail left at the scale a sharper filter would preserve, and it is the inner loop of a scan over tens of candidates.

Note this is *not* the stretch itself. Measured across 32 frames the local magnification at the edge is 2-10% on all but one (a 24mm barrel correction reaching 1.44 radially), which is far too little to explain what was visible. The filter was the whole of it.

**Lateral chromatic aberration is corrected in the same resample** (`native/rawshim/src/tca.rs`). The lens images red and blue at slightly different magnifications, so a highlight lands at a different radius in each channel - zero at the centre by construction, growing with radius, magenta on the outward side and green on the inward. On a 16mm f/2.8 frame it measures **5.05px at the corner**. Since it is one radial scale per channel, it composes with the distortion warp rather than needing a pass of its own: `warp_planar` multiplies its ratio by the channel's scale, and the frames that need no correction keep a shared-ratio fast path that costs exactly what it did before.

**Finding it took three wrong answers, and the wrong ones are the instructive part.** An edge metric that asked how far red and blue depart from green across an edge said we were 6-10x the camera - but a genuinely coloured edge does that legitimately, and our full-resolution chroma against the camera preview's 4:2:0 produces that ratio with no defect present at all. Star centroids over 55,000 point sources said 0.03px - because saturated stars were excluded as having no centroid worth taking, and those are precisely the ones whose fringe is visible. Two wrong measurements agreeing is not confirmation. What worked was the *halo split*: magenta outward minus inward around bright stars, which grows 1.67 → 6.26 → 51.30 from centre to corner where the camera's stays flat at 0.7. A point source has no shape of its own to confuse with the lens's, and the outward/inward split keys on the one thing lateral CA does.

**Three sources, tried in this order, because they are not equally trustworthy.** The curve the body recorded for this shot (`tca::supplied_curve`); failing that, the fringe nulled around the frame's own point sources (`tca::measure`); failing that, a least-squares slope off the green gradient (`tca::estimate`). Every one of them then passes the same verification, which is what makes trusting any source safe rather than a leap. The rest of this section is those three in order, and the regression is last because it is the one that has been wrong.

**The regression is a slope, not a search.** A channel displaced by `d` leaves `R - G = -d.grad G`, and for a radial scale `d` is `(scale - 1)` times the offset from the centre - so the scale is a least-squares slope, one pass, no objective to get wrong. Three search-based estimators had answered ~0 on the frame carrying 5px, because their objective was dominated by the scene's own colour and by chroma noise. The regression is immune to both: neither aligns with the radial projection, so they add variance rather than bias.

**Measured honestly, it removes 64% of the fringe** on the worst frame (halo split +51.30 → +18.67), against 88% for the same warp driven by scales read off that frame's star halos. The gap is attenuation: the regressor is the green gradient and that carries noise, which biases a least-squares slope towards zero. Reading the frame averaged down 4x4 first recovers most of it - full size answered 0.08px of the 5.05 - but the estimate never plateaus, so there is no converged value to calibrate against and no honest way to claim the remaining 24%. **That was once claimed to be a safety property - always towards zero, so it could only under-correct - and it is false in both directions.** Measured against star halos over 36 astro frames, of the 9 it fired on 6 carried no fringe at all and were given 0.76 to 1.21px anyway, every frame with a large genuine fringe was declined outright, and where it does fire it overshoots by 2-3x. The repo's own synthetic fixture recovers 109%, 110% and 88% of three injections.

**So the shape is taken from a calibrated source where one exists.** `Lens::tca` carries a knot curve per channel, the same representation the distortion uses, so a supplied curve and a measured one are the same object downstream. A supplied curve was gain-fitted before it was applied, for the same reason §10.5 does it to a supplied distortion spline - the mechanism that caught lensfun's distortion being ~0.4x wrong on the pincushion half of this library had no obvious reason to be trusted less here. Measured, that was backwards, and the strength fit is gone with the code that did it (below). Two sources were tried.

**lensfun's TCA was measured and rejected.** Its `LF_MODIFY_TCA` sampled through `lf_modifier_apply_subpixel_distortion` covers 3 of the 5 test frames and never wins on any of them. Taken at face value it makes the worst frame *worse* rather than better - halo split +41.18, where the regression leaves +18.67 and doing nothing leaves the +51.30 above. Strength-fitted, which was the fair comparison while that path existed, it reaches +21.74. Its red curve asks for -0.07px at the corner where the frame carries +5.05px, so the fit has almost nothing to scale and correctly declines to invent it. Database TCA averages over a lens; the defect is per-copy and per-focal-length, and 3/5 coverage on top of that leaves nothing worth the tier.

**Sony's own 0x7035 was decoded and kept.** The tag beside the distortion spline in the SubIFD already walked: a count prefix of 32, then 16 red knots and 16 blue. **The values are knots of a multiplicative radial factor, `1 + c/2^21`, and are not anchored at zero.** Sony documents none of it; the constant comes from a decompile of Imaging Edge Desktop, cross-checked against darktable's shipping implementation (`cor_rgb[0][i] *= ca_r[i] * 2^-21 + 1`, knots read as `posc[i+1]` and `posc[nc+i+1]`). `spline_at` already divides by `SPLINE_UNIT` = 2^14, so what remains is 2^7. The knots are evenly spaced in radius from centre to corner, which is what `spline_at` assumes, and green carries the distortion factor alone while red and blue multiply theirs on top.

**Two readings of the same bytes were wrong before this, and both are instructive.** The first correlated the tag's raw corner value against the aberration measured off the same frames, got +0.85 and +0.78, and justified nothing: consecutive frames of one shoot carry byte-identical tags while the measured aberration on them ranges +1.69 to -0.79, so a near-constant regressor was being credited with tracking a varying target. The second rebased each block against its own first knot, reasoning that a lateral aberration vanishes on axis. It does - but these are *magnifications*, not displacements, and a channel imaged larger is larger everywhere. Rebasing discarded that uniform term and left the curve a factor of the radius out, which showed up as a measured displacement flat with radius where the model wanted one growing with it. Nothing in the pipeline objected to either: the strength fit was a signed least-squares slope and would happily scale a wrong-shaped curve, so the tier stayed plausible while making frames worse.

**The tag is applied as recorded, shape and magnitude both.** It was strength-fitted before, on the reasoning that no supplied curve deserves trust; measured over 43 frames across two lenses that was backwards, because the fit contributed the regression's own faults to a number the body already knew:

| | mean split | removed |
|---|---|---|
| no correction | 18.25 | |
| the tag's shape, magnitude refitted | 16.30 | 11% |
| **as recorded, verified** | **10.23** | **44%** |

A per-shot curve from the body that took the picture is better evidence than a slope measured off one frame. It is still verified, which is what makes trusting a source safe rather than a leap - and the verification has to evaluate the curve **at each sample's own radius**. Taking one scale off the corner and applying it everywhere over-corrects every point inside the corner, so a curve that grows with radius scores as harmful when it is the yardstick that is wrong: measured, that rejected 34 of 43 corrections that were helping.

**44% is not the ~97% the body itself achieves, and the residual looks like it is not lens aberration at all.** Chasing it turned up the following, in order of how much they are worth trusting.

The magnitude is right. Swept as a pure gain on the curve, the fringe removed peaks at **exactly gain 1.0** - 0.5 leaves 26%, 1.0 leaves 43%, 1.5 leaves 39%, 2.0 leaves 23% - so the documented unit is confirmed by an interior optimum rather than by taking the decompile's word for it.

Two mapping variants were tested and rejected. Stretching the radius so the frame corner sits inside the tag's range scored better and better on the aggregate metric, up to 60% at a factor of two, and it is an artifact: measured per radius bin, that variant *degrades* the outer frame on near-clean frames, turning a residual of -0.02 into -2.74. **The aggregate metric cannot see that**, which is why the per-bin residual exists. A half-step knot offset, the other candidate, is within noise of no change. Imaging Edge's disputed max-subtraction was dropped on inspection rather than measurement: it is a factor common to all three channels, so it cancels exactly in red-minus-green and cannot affect channel registration at all.

What the tag actually says about the lens the residual is largest on is the interesting part. Its red knots read `[3, 2, 2, 2, 1, 2, 2, 1, 1, 1, 1, 1, 0, 0, 0, -1]`, which is a displacement of 0.12px at r=0.3, 0.18px at r=0.7 and **0.00px at the corner** - Sony is saying this lens has essentially no lateral aberration, and the correction doing nothing in the outermost bin is it being obeyed, not ignored.

Meanwhile the frames carry a real displacement that is **flat with radius**, and a lens aberration cannot be - it has to vanish on axis. Pooled over 33 frames of that lens the profile is +0.31, +0.40, +0.40, +0.30px across the field: a flat term of **+0.36px** and a radial slope of **-0.02**, which is to say no radial component at all. The same three Canon frames shot in daylight give the opposite decomposition - a flat term of -0.09 and a slope of **+1.54px per radius**, which is textbook lateral CA, zero on axis and growing outward. So the tier's model is right and works; these particular frames just carry something else on top of it.

**What that something is remains open, but three explanations have been tested and refuted.** It is not the demosaic: that would be identical on every frame LibRaw touches, and the daylight frames show none of it. It is not a bias in the measurement: the same nulling run over synthetic registered stars reads 0.000px at every brightness and noise level tried, so the metric has no floor to speak of. And it is not per-frame noise, which is what a single frame's profile looked like - two frames of the same lens minutes apart gave slopes of +0.43 and +0.04, which is why the number above is pooled over 33. What it does track is **astro frames specifically**, on both bodies: the one Canon astro frame carries a flat +0.33 alongside its radial +1.34, where the Canon daylight frames carry none.

The practical consequence is that the 44% is measured on the shoot least able to show the correction off. Most of what these frames carry at the corner is not lateral CA and no radial model can remove it, which caps the score whatever the curve says. The daylight frames are where the model's own domain is, and there the aberration it targets is the whole of what is there.

**Both sources still overcorrect on three of the six**, turning a +3.27 split into -11.44, and the regression does the same there. That is the estimator's problem rather than the tag's and it is not fixed: on those frames the halo metric is reading aurora structure rather than point sources, so it is not yet established whether the correction or the measurement is at fault. Related: the `MIN_SHIFT` gate declines most of the high-fringe run in that shoot outright.

**Nothing is applied without being checked first, and that check is what makes the tier safe** (`tca::improves`). The estimate is not self-checking and has been wrong in both directions: measured against star halos it fires on frames carrying no fringe and overshoots by 2-3x on those it does read. So the frame's own point sources are measured before and after, and a curve that does not measurably reduce the fringe is dropped. It costs no resample - a corrected pixel at `q` is the raw frame's red at `q * s` and its green at `q`, so evaluating a candidate is the same arithmetic with the sample positions moved.

Measured over 75 frames across five lenses, scored as the mean absolute halo split:

| | mean split |
|---|---|
| no correction at all | 22.84 |
| every candidate applied | **26.75** |
| verified | **20.14** |

**Applying every candidate is worse than applying none**, by 17%, which is what the tier did before this. Verified it is 12% better than none. Only 11 of the 75 candidates survive, and that is the correct verdict rather than an over-tight threshold - on the ILCE-7CM2 set 38 of 39 are rejected because the estimate fires on frames with no aberration to remove.

A frame with no point sources - a portrait, a flat wall - passes unverified rather than being dropped: absence of evidence is not evidence of harm, and refusing them all would disable the correction almost everywhere it is wanted. The offset the split is read at is 2px, measured rather than picked: swept from 1.5 to 10 the signal peaks at 1.5-2 and is gone by 5-6 while the standard error stays flat. It is also read at 5px, because a correction far too large pushes the channel out of the near window and the split there collapses to nothing, which reads as a perfect result - a 6x overshoot was waved through before that second reading existed.

**Where there is no recorded curve, the aberration is measured rather than regressed** (`tca::measure`). The regression above reads a slope off the whole frame at a quarter resolution, which is where point sources go to die, so it ends up fitting scene edges that carry no radial signal - it fires on frames with no aberration and declines frames with plenty. This finds the features a lateral aberration is legible on, displaces one channel until the fringe around them cancels, and reads off how far that was. The nulling is unbiased where the regression is not: over synthetic registered stars it reports 0.000px at every brightness and noise level tried, so a frame with nothing wrong measures nothing.

**The search is over a frame-wide scale first, and then refined per radius bin - and that ordering is load-bearing.** Swept independently, each bin's split *aliases*: displace a bin's points far enough and neighbouring point sources come back into the sampling window, scoring as well as the truth. Measured on a synthetic 1600×1200 field the period is 7px, and the outer bin answered a 3px injection as **5.71px**. Widening the search does not help - it makes more aliases reachable, which is exactly what widening it from 2.5px to 6px did. Searched as one scale over every point source at once, an alias needs `true + period` at *every* radius, so it sits at a different scale for each and reinforces nowhere while the truth lines up in every bin. Bins are still refined individually, because a real lens is not exactly proportional to radius, but only within half a period so the refinement cannot reach one. Injections of 3px and 5px at the corner now come back at 98% and 89%.

It fits an intercept and keeps only the slope. Forcing the line through the origin does not reject a flat term, it launders one - 0.6px at every radius comes out as a 0.93px correction at the corner, because a line through zero has nowhere else to put it. A lateral aberration is a magnification difference and must vanish on axis, so the flat part is given somewhere to go and then discarded. That discard is also the whole of the shortfall above: the innermost bin reads slightly high, the line charges it to the flat term, and about a tenth of a genuine injection goes with it. Costs 11ms on an ordinary 24MP frame and 78ms on a 32MP astro frame dense with stars.

**Longitudinal aberration is the other half, and no warp reaches it** (`image::defringe`, `raw_defringe`). Lateral CA is a magnification difference and comes out in the resample. This is the lens focusing red, green and blue at different distances: at a hard edge one channel is sharp and another is not, the channels are registered, and the rim goes purple or green. There is no geometry to undo, because nothing has moved - one channel is simply blurrier than the others.

**Which is exactly what it is corrected as.** With `σ_R = σ_G + δ` and the heat equation `∂g/∂σ = σ∇²g`, an achromatic edge imaged through the two channels comes out as

```
R − G  =  L ⊛ (g_σR − g_σG)  ≈  δσ · ∇²G
```

so the fringe is **the Laplacian of luma times one coefficient per frame**. That is not a convenient approximation, it is the defect's actual shape, and it predicts what is seen: ∇² of a sigmoid is odd, which is why a fringe reads magenta on one side of an edge and green on the other and vanishes on the flats. `measure_defocus` fits that coefficient by least squares over the whole frame before any strip is filtered, exactly as the noise estimate is measured, and `defringe` subtracts `k·∇²(luma)` from each colour-difference plane.

**The consequence is that the stage knows when it is done.** A frame with the channels in focus fits `k = 0` and comes back bit-identical - no threshold tells it to stop, the measurement simply reads nothing. A genuine coloured object contributes a *step* rather than a curvature, and objects appear at every edge polarity across a frame, so they add variance to the regression rather than slope. This is the same argument `tca::estimate` rests on, with the same failure mode: a frame *dominated* by one coloured object can still bias it.

Three guards, and the second is only correct because of the third. The coefficient is bounded, because half a pixel squared of blur difference is not a lens. Opposite signs are declined: green is the channel autofocus works on, so red and blue are both softer than it, while a red object raises `R − luma` and lowers `B − luma` at the very same curvature - so a disagreement means the scene is being read as the lens. But that veto **needs a noise band**, and shipping it without one made the stage do nothing on the frame this section cites as its worst. IMG_8408 measures blue at +0.148 and red at −0.011; the second is a fourteenth of the first and indistinguishable from zero, and vetoing on the bare product threw away a frame carrying 98.48 of fringe. A channel with nothing to say does not get to silence one that has, which is the lesson `tca::measure` learned about discarding a good channel. Third: a channel measured *sharper* than green is clamped to no correction rather than sharpened, since subtracting a negative coefficient would invent an edge rather than remove one.

**Measured on the frames this project already knew were bad.** IMG_8408 is backlit foliage against a blown sky, the textbook purple-fringing case: rendered at 0 and at full strength, the violet cast on the twigs visibly lifts and the leaves come back green, and mean ΔE76 against the body's own JPEG over the pixels it moved goes 8.615 → 8.408. IMG_0116, the 16mm f/2.8 astro frame, goes **4.731 → 3.533**. Both fit blue as much the softer channel - +0.148 and +0.234 - which is what a lens does and what no edge mask could have told you.

**What this replaced, and why it had to go.** The stage used to pull colour towards a box mean wherever the dilated luma gradient was steep, capped at 85%. That has no model of the defect at all: it asks "is there a hard edge, and is this pixel's colour unlike its neighbours'?" and a thin saturated object answers yes to both, which is why it greyed out street lamps and washed the red outlines off a flame-print shirt. It also had nothing to measure, so `raw_defringe` was not a gain on an estimate - it was the only thing bounding the correction, globally, for every frame.

That is visible in the sweep it forced. Scored against each body's own JPEG over 214 frames from 104 shoots - the camera being the only reference that penalises *both* leaving a rim magenta and greying a lamp - the old stage's per-frame optimum came out **bimodal**: 57 frames wanted 0 and 61 wanted full strength, with the middle thinly spread. That is two populations, frames whose hard edges are aberration and frames whose hard edges are objects, and no global constant serves both. The best available compromise was 0.6, realising 71% of the benefit while visibly harming nothing - and even there the frames it hurt were a *kind of picture* rather than a body or a lens, costume and studio shoots with saturated props.

**Re-swept over the same corpus, the compromise is gone.** 215 frames, the setting scaling the measured coefficient rather than setting an amount:

| strength | visibly better | visibly worse | worst frame | best frame |
|---|---|---|---|---|
| 0.25 | 2 | 0 | +0.18 | −1.35 |
| 0.5 | 5 | 0 | +0.18 | −2.55 |
| 0.75 | 9 | 0 | +0.22 | −3.53 |
| **1.0** | **9** | **0** | **+0.33** | **−4.19** |

Nothing is visibly harmed at any strength, full included - the worst single frame moves a third of a JND, where the old stage at full damaged seven frames and the worst moved +1.77. So 1.0 is the default, and the 0.6 compromise was an artefact of a stage that could not tell what it was looking at. The mean improvement is monotone to 1.0 with no interior minimum, which is the evidence that **the estimator does not overshoot** and needs no ceiling below 1.

**What the corpus turns out to carry** is the part no edge mask could have reported. Of 215 frames the estimate fires on 143 and declines 72 outright, and on 34 of those it fires on it clamps red to nothing:

|  | median | p90 | max | zero on |
|---|---|---|---|---|
| red | 0.026 | 0.091 | 0.260 | 34 |
| blue | 0.167 | 0.315 | 0.474 | 1 |

**Blue is the softer channel on 133 of 143.** That is a fact about the glass, recovered per frame with nothing told to it, and it is the strongest evidence that the regression reads the lens rather than the scene - the scene's colour has no reason to prefer blue. The old stage corrected all 215 frames identically and knew none of this.

Two things the re-sweep does not settle. The per-frame argmin is still split, 68 frames at 0.0 and 70 at 1.0, but it now means something milder: the 0.0 group is mostly frames whose coefficient is near zero, so both ends differ by almost nothing and the objective is flat rather than two populations pulling apart - which the tail confirms, p95 harm 0.13 at full against the old stage's 0.53. And the 18 Canon frames are flat, mean −0.004 at full with nothing helped or hurt beyond a JND; they are two shoots, so that is not a body-level finding, only a note that the stage does nothing measurable for them.

The mask went with it: no `DEFRINGE_EDGE`, no dilation, no box mean. The stage now reads a five-point Laplacian and nothing else, so its strip halo went from **10 pixels to 1**.

`raw_defringe` survives as a ceiling on a measurement rather than the amount itself, the way `raw_sharpen` blends a computed deconvolution rather than scaling a guess, and defaults to 1.
**Two defects in the estimator, found by review and reproduced. Both are now fixed, and both are pinned by tests that fail if the fix is removed.**

*Per-channel noise had a positive bias with a closed form, and it is now subtracted.* The regressor and the response are built from the same pixels: the stencil's `-4c` term and the response's `-luma(c)` share one, so their noise is correlated by construction, and green's enters the two with opposite signs. The residue was positive for **both** channels, which cleared the sign veto (that veto exists to catch things which flip sign), and being a ratio of variances it did not shrink as the noise did. A flat frame with independent per-channel grain fitted (0.124, 0.175), the blue figure *larger* than the 0.148 measured on IMG_8408, the worst real frame in the library.

For a five-point stencil the noise's contribution to both sums is computable from the per-channel sigmas: `E[curv.resp_red] = 4.v_luma - 4.w_R.v_R` and `E[curv^2] = 20.v_luma`. Both now come off, and the absolute curvature gate went with them, since gating conditioned the sample set and made the subtraction inexact. Measured after: the noise-only frame returns nothing, and a real 0.12 defocus reads **0.0926 clean against 0.0928 with the same grain on top** - noise-invariant rather than noise-driven.

Every fixture meant to catch this added the *same* grain to all three channels, which cancels in `R - luma` identically. `tca.rs` gets this right and `image.rs` did not; that is the whole reason it shipped unseen.

*Lateral aberration read as longitudinal, and the fit is now split by radius.* A channel displaced by `d` expands as `G + d.grad G + (d^2/2).lap G`, and that second-order term is the very basis this fit regresses on. It carries `d^2`, so it is positive for red and blue whichever way each channel is displaced - again exactly what the sign veto cannot see. A pure lateral aberration, achromatic source, nothing out of focus anywhere, fitted (0.054, 0.053); the coefficient was then applied at every radius including the centre, where a magnification difference displaces nothing at all. The pipeline ordering compounded it, since the defringe runs first, removes the even `d^2` term, and leaves the lateral tier measuring a half-eaten fringe.

The discriminator is that `d` grows with `r`, so a lateral confound's apparent coefficient grows with **`r^2`** where a real focus difference is flat across the field. The fit is now taken per radial bin - six, uniform in `r^2`, each needing `DEFOCUS_MIN_PER_BIN` samples - and the per-bin coefficients are regressed against `r^2` into a constant plus a slope, of which only the constant is kept. The same move `tca::measure` makes in reverse: give the part you cannot explain somewhere to go, then discard it. Residue lands at 0.008, under `DEFOCUS_NOISE`, so the floor declines it outright.

Measured: the lateral-only frame now returns nothing, a real 0.12 defocus is unchanged at (0.093, 0.091), and a defocus with a lateral aberration laid on top still reads (0.102, 0.105) - so the split is not simply rejecting everything radial. `a_pure_lateral_aberration_is_not_read_as_a_focus_difference` and `a_focus_difference_survives_a_lateral_one_on_top_of_it` pin both directions, and both fail if the `r^2` term is dropped.

One thing given up deliberately: field curvature means real longitudinal CA is not perfectly flat in radius either, so discarding the slope discards a little genuine correction. That is the conservative direction.

**What it costs and buys, over 215 frames from 104 shoots**, scored as deltaE76 against each camera's own JPEG over the pixels the stage moves:

| strength | mean d | visibly better | visibly worse | worst frame | best frame |
|---|---|---|---|---|---|
| 0.5 | -0.051 | 2 | 0 | +0.26 | -1.93 |
| 1.0 | -0.071 | 4 | 0 | +0.26 | -2.83 |

Nothing is harmed by more than a JND at any strength, the mean improvement is 40% larger at 1 than at 0.5, and the large wins appear only at 1 - so `raw_defringe` defaults to **1**.

The number worth carrying, though, is that **it fires on 37 of 215 frames**. The version before the split fired on 143. Those extra 106 were the confounds: noisy frames and frames with lateral CA, corrected for a defect they did not have. Blue is the softer channel on 30 of the 37, which is what a lens does and what no mask-based stage could have reported.

**Together they reach the body's own JPEG.** Measured over 38 frames across five lenses, as the fringe left around the frame's own point sources:

| | mean fringe |
|---|---|
| uncorrected | 34.20 |
| geometry alone | 24.80 |
| **geometry and defringe** | **5.34** |
| the camera's JPEG | 2.58 |

Geometry alone closes 30% of the gap to the JPEG; with the defringe it is **91%**.

**The metric fault below is unchanged, and it is why this section leans on the corpus sweep rather than on this number.** The failure itself belonged to the box-mean stage, which is gone - the measured stage leaves saturated objects alone, because it has a model of the defect rather than a gradient threshold. On a frame of orange street lights the old one turned them white: a small bright object is entirely beside a steep edge, so every pixel of it is pulled towards a surround that is mostly background. The fringe metric scored that as a triumph, because it only ever rewards removing colour near an edge and has no way to tell a fringe from a lamp. The stage wants a discriminator between a rim and an object - a fringe is confined to the slope of an edge where a coloured object has a core that persists past it - and until it has one, the number above is a measure of the metric as much as of the picture. The split is worth reading: on the Sony prime the geometry moves 15.65 to 15.12 and the defringe takes it to 3.45, because that lens has almost no lateral aberration and the tag says so. On the Tamron zoom the geometry does most of the work, 96.97 to 53.87, and the defringe finishes it at 8.29. Neither stage is redundant and neither is sufficient.

**The correction costs 5-7%.** Repeated A/B on a 24MP frame at native resolution: the warp is 242-253ms with a shared ratio and 258-265ms per-channel, both medians of five. The finder is 5.2-6.7ms on top, and a frame that estimates nothing keeps the shared-ratio path and pays neither.

**Candidate warps are scored by the residual they leave behind.** This is what makes the search robust: a wrong warp cannot be rescued by any tone curve, so a good score means genuine correspondence, and the number being minimised *is* the criterion the stage decides on. It needs no band selection, no subpixel interpolation and no outlier rejection. Feature matching was tried first, in four variants, and every one produced a *confident* wrong answer - three of them independently reporting "no distortion" for a frame that has 4.4% of it. The general lesson is worth more than the specific bug: **a radial error and a radial model will always find each other**, so a null result from a detector means nothing until the detector is shown to recover a synthetic injection of the effect it is looking for. An integration test does exactly that, and it earned its place immediately by catching that only the crop was being refined and never `k1`, so a 3% injection came back as 4%.

**That residual is luma, and the stage reads no colour at all.** Every question here is about correspondence - which warp aligns the two frames, and whether the best of them beats leaving the frame alone - and none of them needs to know what colour a pixel is. One luma tone curve answers as well as three curves plus a 3×3: measured over 204 frames from two libraries, an injected distortion comes back with a mean error of 0.0119 against ΔE76's 0.0134 and an identical median of 0.0075, and the held-out ΔE76 the fit finally reports lands at 1.884 against 1.889. It is much cheaper - one curve instead of three, no 3×3 solve, six fewer `cbrt` per pair - taking a mean fit from **1106ms to 613ms, 45% off**. The score is scaled by 100/255 into L\*-sized units, so `REFINE_MARGIN` and `REFINE_FLOOR` mean what they meant when this was measured in ΔE76.

**Luma is also the better-behaved signal, which was not the expected result.** A ranking has to be smooth in the geometry, and ΔE76 here is not: the 3×3 is solved unregularised, so on a low-chroma frame the channels are near enough collinear that `solve3` returns a bad row rather than refusing. On `DSC06592` the green row's sum drops from 0.966 to 0.756 between two candidates 0.5% apart in `k1`, taking the residual from 3.66 to 10.24 while the curves and the pair count barely move - a spike at the geometry that is actually correct. The luma residual over the same candidates falls smoothly into its minimum there. One frame of the 204 does come out worse under luma: `DSC06592` settles on no geometry, and the colour fit that follows then misses the acceptance gate, so it ships unmatched. The cause sits in that solve rather than in this stage, and the stage is not the place to compensate for it.

**Colour is per-channel curves plus a 3×3 matrix, not a 3D LUT.** 777 coefficients beat a 17³ LUT and tie a 33³ one at 107k, because the vendor transform is close enough to separable that the extra dimensions only fit noise in the cells one frame never populates. Curves are binned means, gap-interpolated, extended at the end slope rather than flattened (which would crush every highlight the frame happened not to sample) and forced monotone so a thin bin cannot invert them. Clipped and high-gradient pixels are excluded: the first are not invertible, and on the second a fraction of a pixel of misregistration swamps the colour difference being measured.

**Falloff is a third stage, between the geometry and the colour.** Curves and a 3×3 are position-independent and the camera's peripheral illumination correction is not, so no amount of capacity in the colour model can express it - which is why it read as an unexplainable floor for as long as the model had only those two stages. It is modelled as `1 + a r² + b r⁴` in linear light, the shape falloff actually has, so two coefficients carry it and a thin radius bin cannot bend it on its own. Fitting runs backwards rather than by search: invert the colour transform to say what render level would have produced this JPEG pixel, and the ratio of that to the level actually there is the gain. One pass accumulates both sides into 12 radius bins and a weighted least squares puts the two coefficients through them; a search over candidate gains would be one pass each. It is a ratio of summed luma per bin, never a mean of per-pair ratios, so a bright pixel weighs what it should where a pair-by-pair ratio would let a near-black one carry as much as the sky. That alternates with the colour fit three times, because the first round's curves were fitted with the falloff still in them and partly absorb it - an injected 0.65 corner comes back as 0.78 after one round and lands within 0.1 after three. Kept only where it beats the frame without one **on the pairs the round was not fitted on**, since extra free parameters can only ever look better on their own.

**It is achromatic, and that is a choice rather than an oversight.** One scalar for all three channels, fitted from luma. Real falloff carries a slight cast, which two coefficients on a luma ratio cannot express; what the 3×3 absorbs of it globally it absorbs, and the rest stays in the residual. The gain is also bounded to [0.25, 4.0], because a degenerate solve should distort the corners rather than black them out - no lens falls off by four stops and none gains.

Measured over 32 Canon frames from one EOS R8 library: median ΔE76 **1.92 → 1.61**, worst **5.01 → 3.22**, and not one frame worse. It costs **+7%** of a fit (13.99s → 14.98s over those 32 frames plus the Sony fixture, ~30ms a photo). Most of what it could have cost is bought back by keeping the stage off the geometry search - candidates only have to be ranked against each other, and a falloff common to all of them does not change that, so it runs once on the winner rather than tens of times. What the search does pay is the wider pair record, 6 bytes to 7; the gain itself is an `Option` the search leaves at None, so the lookup is a branch rather than an identity table read per channel per pair.

What corroborates it is where it declines to fire. 30 of the 32 fit a corner gain of 1.03-2.33 and the two that do not are Tamron glass on an EF adapter, which the body has no illumination profile for and therefore leaves alone - the fit reaches that from the pixels, knowing nothing about mounts.

**Sony is not excluded, it simply has nothing to correct**, and that is the same finding the `0x7032` paragraph above reaches from the other direction: the body writes a vignetting tag claiming a +50% corner and does not apply it to the preview, so a stage that measures the ratio rather than reading the tag measures it flat. Over 30 frames across two bodies and three lenses - one native FE prime and two Tamron zooms - 25 fit no gain at all and the other five land within ±7% of the identity, against 1.03-2.33 on the Canon set.

**The residual floor is content, not model.** After geometry and falloff, ΔE lands around 1 where content is smooth and 2.5-3 in fine detail, and per-tile fits show why: on one frame the smooth tiles score 0.81-1.07 while dense-detail tiles score 2.79-3.07. It is the camera's noise reduction and sharpening against LibRaw's demosaic, which no colour transform should try to reproduce - and note that blurring both images does not remove it, because NR is edge-preserving and nonlinear, so the two are not a linear filter apart. Adding model capacity for it is wasted: a 33³ LUT scores *worse* than curves plus a matrix at every blur level.

**One fit per photo, and nothing is stored.** The fit is on the job rather than the target, so the grid tile and the full view cannot disagree about colour. Across jobs - the max-resolution export is built on demand, long after the import - the fit is deterministic, so refitting lands on the same transform rather than a second opinion, which is why no profile is persisted. A test pins that determinism, because it is the only thing standing between "no storage needed" and two differently-graded copies of one photo.

**Applied after the resize, not before.** The distortion model is in normalised radii and the colour transform is a per-pixel lookup, so the order is immaterial to the result - and warping a 60MP decode to produce an 800px tile costs seconds per rendition. Measured: 59-75ms at 800px and ~0.6s at 3840px, against 1.2-2.9s at full resolution. A test pins the equivalence.

**One decode serves the fit and every rendition.** This was the single biggest cost and it was pure waste: `writeSdr` decoded per target, so a `render` import demosaiced the same 60MP frame twice for the grid tile and the full view, and the fit decoded a third time for an identical result. Sharing one lazy decode across the job took the fit on a 60MP frame from 3.8s to 1.9s and the unmatched baseline from 4.8s to 2.9s, so it is a win whether or not matching is on. Lazy because an embedded-source job may never need a decode at all, and the fit is skipped outright unless some SDR target actually demosaics - an embedded grid already carries the camera's look.

**An HDR job fits off the scene-linear decode, and takes no 8-bit one.** All it wants from this section is the geometry - the colour is refitted in the grade's own domain (§10.8.1) - and the search resizes whatever it is handed down to a 640px grid before it looks at anything. So where nothing in the job renders SDR, the render is derived from the 16-bit decode already in hand: normalised by the frame's own peak, Rec.2020 to sRGB primaries, sRGB transfer, 8-bit. That is the same shape as LibRaw's sRGB path, with `levels.peak` standing in for auto-brightening, which clips its top 0.01% where this clips none. It removes a whole LibRaw decode from every HDR photo, ~8% of one end to end.

It is checked rather than assumed, because the two renders genuinely differ in tone and the geometry search scores candidates by the residual they leave. Measured on both fixtures the tier and the knots come out **identical** and the crop within **0.06%**, which is ~1.4px at the corner of a 3840px frame - under the bilinear resample that follows it, and well under the median ΔE76 +0.21 the uncorrected-flag gate above already accepts. A test pins it on a lensfun-tier body and an uncorrected one.

So a photo can have two geometry sources: HDR fits off the linear decode, SDR off the 8-bit one, since the SDR path needs the 8-bit render for its colour whatever happens. **Pixel-exact agreement between an HDR rendition and its SDR counterpart is not a goal and never has been.** They are different pictures built for different purposes, no job builds both at once - a renditions job carries a single `full` target, HDR or SDR - and the viewer serves one or the other, so the two only ever meet if the library's setting is toggled and the stored copies compared. What each has to be is correct on its own terms; landing in the same place is worth having where it is free and is not worth buying.

It is mostly free here, and where it is not the gap is in the decision rather than the arithmetic. On IMG_5360 lensfun's curve beats correcting nothing by 0.0028 ΔE76, so which side of that the two fits land on is decided by noise: the 8-bit fit keeps the curve, the linear one declines it, and the results differ by ~11px at the corner of a 3840px frame while matching the camera equally well. The test pins the match rather than the tier for exactly that reason - on a margin that thin, pinning the tier pins the coin rather than the call.

**On by default**, because a render that does not look like the camera's own JPEG is the wrong picture, and what is left costs a fraction of the decode it rides along with. On a 61MP ILCE-7CR frame, building the grid tile and the full view goes from 2.9s to 5.3s, the added 2.4s being a ~1.9s fit paid once per photo plus ~0.4s of transform across the two renditions. Where the geometry has to be searched rather than read the fit is roughly twice that. `MATCH_EMBEDDED_JPEG=false` turns it off for an import where throughput matters more.

The lever if that ever matters is caching geometry by (lens, focal length) rather than per photo - the three 28mm frames measured agree to ~10%, so geometry pools even though colour does not - but that needs storage and is not built. Only Sony is verified; Canon records an equivalent but no CR2 or CR3 has been tested, so those fall through to the fitted path.

### 10.8.1 The same look in HDR (`hdr_fit.rs`)

The colour half does not lift to HDR, and the reasons are structural rather than approximate. The SDR curves are indexed by an 8-bit render level and answer with an 8-bit JPEG level, so their **domain stops at display white** - which is the whole of what HDR adds - and 8 bits of output is coarser than the shadows of a PQ signal, so applying them would band. **The geometry does lift**, being a property of the lens and not of a colour space, and it is the expensive half: it is reused as fitted, and only the colour is refitted in the domain the grade works in, Rec.2020 linear normalised so diffuse white is 1.0. That normalisation is what makes the curve extrapolable, which is what lets the camera's rendering stop at diffuse white and BT.2390 take over above it (§10.7.1).

**The falloff lifts too, and unlike the colour it lifts unchanged.** It is a multiplication in linear light, so it means the same thing in any linear domain - where the curves are indexed by an 8-bit level and stop at display white, two coefficients on a radius are not indexed by anything. So the SDR fit's `(a, b)` are reused as fitted, exactly as the geometry is, and `apply_lens` runs the warp and then the falloff on the 16-bit decode before the grade. Refitting it here was the alternative and would have meant inverting a transform that carries a saturation scalar as well as curves and a matrix, to recover a number the SDR fit already has.

Order matters twice over: the falloff runs *after* the warp at grade time because that is where it was measured - its radius means a position in the corrected frame - and it is applied to the render *before* the colour is fitted here, or the curves would be fitted against corners the falloff has not lifted and then asked at grade time for levels they never saw.

Measured over the same 32 Canon frames, on this section's own held-out ΔE76: median **1.96 → 1.39**, and every frame that fitted a falloff improved. The two that fit none are unchanged to two decimals, which is the check that the term is inert where it should be. Brightening corners does clip a little more of the top of a 16-bit buffer, and that is measured rather than waved at: on the worst frame in the set a 2.33× corner takes the clipped fraction from 0.089% to 0.124%.

One number no longer means the same thing on both routes. §10.8 gates on a residual measured *with* the falloff, and `hdr.rs` takes only the geometry and the coefficients from that profile, never its ΔE. The two ΔEs are not comparable and were never both about the same picture.

**Never its ΔE, but it used to inherit its verdict.** `MAX_ACCEPTABLE_DELTA_E` decides whether an *SDR render* should wear a colour transform; refused, §10.8 returns no profile at all. `fit_all` asked that same call for geometry and gave up when there was none - so on the one route an HDR rendition takes, a refused SDR colour refused the HDR match too, and the frame graded with no camera colour rather than with the fit that was never attempted. It is reachable rather than observed: the worst SDR fit across the 35-frame set is 4.1 against a limit of 6. It was reached by accident, feeding the geometry fit a cheaper preview, which took one frame's SDR fit to 10.4 and silently cost it its colour. `fit_from_preview` is the same fit without that verdict, and geometry keeps its own test - a candidate still has to beat the undistorted baseline.

**One preview decode serves both halves, and how far it was DCT-shrunk matters more than that it is shared.** Each used to decode the same 5-14MB preview - the colour fit through `thumbnail`, the geometry fit in full, both landing at 640. Sharing was tried at 640 and rejected: `thumbnail` shrinks in the DCT before it builds a pixel, so at that size it arrives barely filtered and the geometry fit is measurably worse off, costing the 35-frame set **1.654 → 1.774** mean ΔE.

That is a fact about the shrink factor, not about sharing. The colour fit now wants twice the grid (§10.8.3), so a 6000×4000 preview is DCT-shrunk only to 1500 and brought to 1280 by a real reduce - and the geometry fit resizing *that* to its own 640 is a properly filtered resize rather than a DCT approximation of one. Shared, the set moves **4.605 → 4.622** mean chroma ΔE, 0.36%, against ~90ms saved off a ~1s fit. Measured interleaved: an earlier sitting-to-sitting comparison of this same question read the share as 34ms *slower* when the same build measured 1666ms and 1739ms in two sittings, so a difference that size was never there to read.

**Which route a photo takes is not a detail, and the measurements have to take the product's.** A library with HDR on asks for one rendition target - full, HDR, from the render - so `renders_sdr` is false, no SDR profile exists, and `fit_hdr_for` resolves the geometry itself through `fit_all`. The other route, where an SDR rendition has already paid for a profile, is the cheaper one and it is *not* what an HDR rendition gets. It also fits better: measured over the 35-frame set, the profile route lands at mean ΔE 1.60 against `fit_all`'s 1.65, because the geometry it reuses was fitted from a full-resolution 8-bit decode rather than from an 8-bit render of the fit plane. The harness fits the way the product does, so that gap is visible rather than measured around.

**Below diffuse white the camera's per-channel rendering; above it, one shared gain.** Past the ceiling the whole pixel is scaled down until its brightest channel sits at the top of the fit domain, read there, and scaled back up by the same factor - so a bright orange keeps the camera's orange and only gets brighter, and a pixel twice as bright comes out twice as bright. This is the point of the exercise: an 8-bit JPEG turns everything above its clip point to flat white, and the extra range exists precisely to keep those highlights coloured.

Letting each channel run on its own extrapolation instead is what tinted the sky magenta, and it took two fixes because it had two causes. The visible one was free extrapolation, measured at Δa\* +11.8 in the top L\* band. The larger one was the **mask**: a pixel was dropped if *any* channel was near clipping, so in a sky - where blue is the high channel - every sky pixel vanished from red's and green's curves too. Both ran out of data well below the ceiling and were extrapolated from there, tinting the 75-89 L\* band Δa\* +5.2 on pixels sitting *inside* the fit domain. The end slopes tell the story: 0.435 / 0.206 / 0.336 before, 0.390 / 0.411 / 0.336 after gating each curve on its own channel. A per-channel curve needs only its own channel in range; the matrix still wants all three, being cross-channel.

There was a third cause, and it is the one that turned DSC05469's sky green: **where a channel's pairs run out is close to arbitrary, and each channel was extrapolating from wherever that happened to be.** That frame is bimodal, and measuring the mask's own decisions says why. 114K of its pairs sit below render 0.2. Its sky sits above 0.9 and is blown in the JPEG, so it is dropped - for all three channels alike, the earlier per-channel gating notwithstanding. The stretch between the two holds a few hundred pairs per tenth of the domain, most of them rejected for lying on a gradient, so whether a channel's last filled bin lands at 0.18 or at 0.66 comes down to which side of `MIN_BIN_SAMPLES` a hundred-odd survivors fall: red kept 113 pairs in the 0.6-0.7 band where green kept 13. Three straight lines drawn from three arbitrary places diverge - by diffuse white the curves read 2.19 / 1.15 / 0.79, a 2.8× spread on pixels well *inside* the trusted domain, and the held-out ΔE never saw it because that is measured only where all three channels have data. So a channel no longer extrapolates alone. **The channel whose pairs reached furthest carries the shape the others borrow above their own ends**, at the gain the two ran at where both had pairs - the channels agree on shape wherever they overlap, within about 5% across the domain on the fixture, so what a short channel lacks is reach, not a rendering of its own. Only above its own last bin: a channel keeps every pair it measured, and the borrowed part is the part that was a straight-line guess before.

That gain is read over the last 16 overlapping bins rather than at the join itself, which is the least trustworthy sample the channel has: it is the bin that only just cleared `MIN_BIN_SAMPLES`, so it is the thinnest average in the curve, and a ratio taken there is carried over the whole tail. Replayed against a channel truncated at render 0.18, the window lands the extension within 1.9-2.1% of that channel's own curve where the join bin alone gives 3.2-4.0%, and self-extrapolation gives 33-38%.

**And the gain fades out across the tail, so by the top of the domain every channel ends on one level.** A frame's brightest region is where the fit has least to go on, and on DSC05469 what it does have is unambiguous: the sky is clipped in the *sensor* to exactly (1.000, 1.000, 1.000) and the camera renders it exactly (1.000, 1.000, 1.000). Neutral in, neutral out - which three curves holding three different gains up there cannot deliver. Converged, a neutral render value maps to one number whatever channel it arrived in, and that sky reads U/V 511.9 / 512.0 against a neutral 512, at a mean saturation of 0.12.

**That shared level has to sit at or above every channel's held extension, and it is worth knowing why.** Let it sit below one, and that channel has to *fall* to reach it - so `make_monotone`, which the measured part of the curve needs because a thin bin can dip, clamps the fall flat and leaves the channel at its own level with the others at the reference's. That is the per-channel gain this exists to remove, reintroduced by the guard against a dip, and it is invisible until the two disagree about which channel reached furthest: converging on the reference's own top, DSC05469's sky read neutral off a full decode and 13% red off a bounded one (U/V 510.0 / 518.1, saturation 6.10 against 0.13). Converging on the highest held extension instead, no channel is ever asked to fall, and the same frame measures 0.14 / 0.22 / 0.12 at decodes of 2400, 3600 and native - which is the cross-size agreement §10.8 asks of a fit, rather than a number that depended on the size it was measured at.

This is not desaturation, and the distinction is the whole point: what carries a highlight's colour is the pixel, not the curve. IMG_8584's twilight sky is genuinely blue (U 524.8, V 502.3 at a saturation of 20.6) because its channels differ *in the render*, and it comes through this intact. What is given up is the fit's licence to invent a per-channel gain at a level where it measured none - and where a camera really does apply one, that is a real cost, since every channel converges on the *hottest* of the three: on the synthetic chart, built with per-channel gains of 1.06 and 0.94, the cool channel reads +2.5% at render 0.4 and +6.6% at 0.6.

**The three curves are held to one shape and a gain each - where the frame supports it, and not where it does not.** Fitted freely, the ratios between the channels wander with level, and a ratio that wanders with level is a hue that changes with brightness: on IMG_8789 green ran 15% above red through the mid-tones and came back level at both ends, so a white bird bath was neutral where the sun hit it and mint green down its shaded side, the same green on the shaded fur and on the lit edge of a brick. That wander is not the camera - measured on that frame's own greys, this body holds green to red within 1% at every level - it is our fit, each curve estimated from whatever the frame holds at each level, which at a garden's mid-tones is foliage pulling green up where nothing pulls red. The grey balance cannot see it, since the hump averages out against the ends: the neutral axis reads correct while every neutral at the wrong level is green.

But it is a claim about the camera, and not every frame supports it. IMG_9808 does not - held to one shape its channels collapse to within 2% of each other, the sky's blue lift is pushed into the matrix where it applies to every pixel including the hillside, and that frame's ΔE goes 1.99 → 4.06 with its warm hues at 9.7 against grey's 1.2. So the model is fitted both ways and the frame is asked. **Asked about drift, not ΔE**: what the constraint buys is consistency across level and a mean ΔE averages exactly that away, so scored on ΔE the constraint loses on every frame in the set including the ones whose green it removed. Drift is measured per hue as the spread, across brightness levels, of the transform's log ratio to the camera against green - per hue so that a frame merely containing dark blue and bright yellow does not read as drift, against green so that a difference in exposure drops out, and over every pixel the camera did not clip rather than over the fitted pairs, since the fit's mask also drops everything above `TRUST_CEILING` and that is where free curves go furthest wrong.

**Whichever measures less, with no margin favouring the constraint** - and the margin that was there is worth recording, because the reasoning for it was sound and the answer was still wrong. The constraint describes something this camera really does, so it looked like it should survive a near-tie, and IMG_8789 is a near-tie at 0.130 free against 0.134 held. But held, that frame renders a deep blue pot violet: green cut to a 0.151 share of the pixel against the camera's 0.284, a 36° hue error on a saturated object, by the same mechanism that costs IMG_9808 its hillside. Measured region by region against the camera - bird bath, brick, pale fur, pot - the free fit is closer on three and level on the fourth, the fur the margin was protecting differing by 0.0008 either way. The whole-frame drift the margin was justified by is dominated by lawn. Across 35 frames the mean ΔE against the unmatched-curve baseline goes 2.03 → 1.60.

The choice invites the question §10.8 asks of any fit - whether it survives a change of decode size - and it does: over decodes of 2400, 3600 and native, every frame checked keeps its arm, and the ratio between the two measurements moves by a few percent rather than across the point where it would flip.

One shortcut here is worth naming because it looks obviously right and is not: asking the question of the round-one curves alone, rather than building both models in full. Drift is a property of the tone stage - a matrix is linear and a saturation scalar is one number, so neither can make a colour depend on level - but what the constraint *does* to a frame only shows once the matrix has been fitted around it and taken back out of the target. Measured before that, IMG_9808 reads 0.105 held against 0.110 free and keeps the constraint that ruins it. Four of the 35 choose differently.

Nothing rebuilds a rendition on a change like this: a photo is reprocessed when its pixels change or the user asks, so libraries carry HDR renditions made by whatever the fit did the day they were written.

**The case is covered by a chart the test builds rather than a frame it reads.** All three channels of the DSC02981 fixture fill every bin, so both extension paths run empty loops on it and the grade pin is byte-identical either side of this fix - which is also why `the_three_channels_leave_the_fit_domain_at_comparable_levels` never caught the green sky. `warm_chart` synthesises the shape instead: flat patches, since the mask drops anything on a gradient, most of them in the domain all three channels share and the rest warm enough that only red carries pairs past it. Because the chart is rendered by a known curve, the test can hold the fitted result against the rendering the camera *would* have made above the join, which no real frame can supply: the borrowed tail lands within 0.3 / 0.7% of it at render 0.4 / 0.6, where extrapolating per channel is 8.4 / 19.2% hot and climbing. Only that far up: above it the convergence takes over by design, so a chart built with a real per-channel gain in it is the wrong thing to hold the top of the curve against, and what governs there is neutrality instead. The chart's warm patches stop at render 0.45 for a reason worth knowing: rendered, a patch at 0.62 against green's 0.20 leaves the sRGB gamut, and an 8-bit preview cannot hold it.

**The 3×3 is weighted perceptually, and that is not a detail.** Unweighted least squares in linear light is dominated by the brightest pixels - on a frame that is half sky, the sky *is* the fit - and the matrix it lands on oversaturates everything darker, measured at 1.093× the camera's mean chroma. Weighting each sample by d(∛v)/dv, so it counts for its perceptual size rather than its photometric one, takes that to 1.042. The last 4% is a saturation that varies with level, which a 3×3 structurally cannot express, so one fitted scalar blends towards luma.

**It is also weighted by hue, because what a frame is *of* must not decide what the camera is taken to do.** IMG_8789 is a lawn with two brown dogs on it. Minimising over every pair equally lands within ΔE 2.96 of the camera and still renders the dogs olive, because they are a small enough share of the pairs that their error costs the fit almost nothing - and the held-out ΔE cannot see it either, reading 2.961 against 2.995 across settings that move the dogs by three levels. So a pair counts for the reciprocal of how common its hue is, bounded either way so that forty magenta pixels cannot take over from forty thousand green ones. Hue is read off the camera's rendering rather than the render, that being the thing matched, and everything too close to grey to have a hue shares one bucket.

**The damping is chosen by the frame, and vetoed by the frame.** A fixed ridge cannot serve both ends of what arrives: a frame whose colours all sit near the grey axis cannot constrain nine parameters and will fit its own noise without damping, while a frame that *can* constrain them does not get to - IMG_8789's camera scales green by 0.884 on grass and 0.690 on a brown, only the off-diagonals can say that, and damped to near-identity they cannot. So six candidates are tried and scored two ways. Which is *best* is asked hue-balanced, that being the question the balance exists to ask. Which are *allowed* is asked by area, because that question is about the whole picture and a picture is seen by area: on IMG_9808, sky and snow with no colour spread to pin anything down, the least damped candidate returns a row of `[-0.285, -0.334, 1.619]` that reads as an improvement hue-balanced while the hillside renders acid yellow-green and the frame's own ΔE doubles. Any candidate more than 3% worse by area is refused however well it serves a subject. Removing the search entirely costs the set's mean ΔE 1.74 → 1.90, and IMG_8789 3.46 → 4.92.

**The saturation scalar is fitted against ΔE, not solved from a mean chroma ratio.** The ratio is a proxy, and it fails exactly when the stages above leave a residual: one scalar can always be found that makes a mean come out right. On IMG_9808 the one that did came out at 1.153, taking hues already within ΔE 1.3 of the camera and pushing the hillside to 11.6 while the number it was solving for looked perfect. Fitted on the error itself by golden section - the objective is a sum of distances to a point moving linearly in this scalar, so it has the one minimum a search needs - it lands at 0.995 there and leaves frames whose chroma really is short alone. Every pair counts the same for this one, unlike the curves and the matrix: those can act per hue, a single scalar moves the whole picture at once, so balancing it does not protect a minority hue but hands the picture to one. Balanced, IMG_9808 lands at 0.772 and drains its sky - 75k pairs at ΔE 9.4 - to bring 1.2k red ones in.

Together: held-out ΔE 2.26 on the test frame, contrast and saturation both within 0.2% of the camera's.

Two performance traps, both measured on a 61MP frame. **Warping before downscaling** took the fit from 1.6s to 17s, and the SDR path already had the order right: down to twice the fit grid first, so the warp resamples prefiltered pixels rather than aliasing on the way in. And in the grade, **returning tuples per pixel** cost more in collection than all the arithmetic - 180M allocations - so the matched loop is flat and scalar, with a per-channel lookup for the below-ceiling case that covers nearly every pixel of a photograph. Grading with the match is the price of a cross-channel transform - there is no single input level to key a lookup on - which is why the resize below matters so much: at 3840 the whole rendition is 1.7s matched against 0.9s not, where at native resolution it is 8.1s against 2.9s.

**Fitting the model twice and searching two parameters made the measurement itself the cost, and the fix was to stop recomputing what does not change.** The fit measures its own error about a hundred times per photo - every ridge candidate at every round, every step of the saturation search, both arms of the shape question - where it used to do it once, and that took the fit from 119ms to 1058ms on a 24MP frame. Everything below is measured on that frame at six threads, which is what a worker gets when several run at once rather than the whole box, and **every step of it leaves the graded output byte-identical**: the fixture pins and all 35 frames of the comparison set hash the same before and after.

- **A probe only moves one stage, and the stages under it were being redone anyway.** A ridge candidate moves the matrix, so the tone curves above it are the same for all six; a saturation probe moves only the blend, so the matrix under it is the same for all thirty. Keeping each and handing the finished colour to the scorer: **1058 → 476ms**.
- **The camera's target was re-derived on every pass**, three `powf` and three `cbrt` per pair, for a Lab value that never moves; and `rec2020_to_srgb` was being rebuilt *per pixel per pass*. `fit.rs` had already solved half of this for the SDR fit - `linear_table` and `lab_from_levels` exist because "the transfer's pow() is the most expensive arithmetic in the fit" - so the HDR path uses them rather than its own `delta_e76`.
- **Quantising to an 8-bit level is a search, not a transfer.** `(255 · oetf(v)).round()` steps at 255 fixed linear values, so the `powf` becomes a lookup: **476 → 357ms**. Those edges are walked to the first f64 the transfer really sends to each level rather than taken analytically, because the two do not round-trip exactly and a level out by one is a different measurement. Starting from a guess indexed by `√v` instead of bisecting saves a further **83ms** - two dozen unpredictable branches per pair costs more than a square root.
- **Probes that do not depend on each other are asked together.** One at a time, a frame's 47 blocks over six threads leave most of them idle in the last round and the fit reached only 4.2×; batched, the six candidates and the twenty sweep steps keep every core fed, and the three tone curves fit at once. The block size cannot be shrunk to fix that instead - it is part of the summation order, so it is part of the answer.

- **Only the winner's saturation is kept, so only the winner's is fitted.** The search is the fit's most expensive stage and a third of it was going into a model about to be discarded. Deferring it past the arm comparison does move that comparison, which no longer sees the blend - four frames change arm - and all four come out closer to the camera for it, the set's mean ΔE 1.628 → 1.601. That reads as the cleaner question rather than luck: drift is about what the tone stage does *across levels*, and a scalar on chroma is the same number at every level.

**Wall time is not the measure here; CPU is.** Renditions are built several at a time, so work moved onto another core is not saved, and a change that halves wall while doubling CPU is a throughput loss. Measured on the same 24MP frame at one thread, which is what the fit costs a machine: **1590 → 864ms against main's 118ms**, and across a whole rendition **12.4s → 12.9s of CPU, +4%**, for wall within noise of unmatched (3.10s against 3.12s). Running the two arms under `rayon::join` was tried and measures 98ms *worse* even on wall: the batched probes already fill the cores and nesting only costs locality.

What remains is not overhead but the work itself - 84% of the fit's CPU is the probes, 67 passes over a quarter of a million pairs, where main makes one. Cutting that further means cutting probes, and the obvious candidate was measured and rejected: running the ridge veto only on the final round saves 249ms of CPU and costs the set's mean ΔE 1.601 → 1.657, which is a bad trade for 1.8% of a rendition's CPU.

Memory goes 627 → 673MB on a 24MP frame, all of it fixed-size buffers on the 640px fit grid rather than anything that scales with the picture - on a 61MP frame, where the decode sets the peak, it is unchanged.

The blocks are summed in a fixed order rather than reduced, and that is load-bearing: floating point addition is not associative, so a reduction whose tree follows `rayon`'s scheduling gives a different fit run to run, and the graded output is pinned by hash.

A third that was pure bookkeeping: the fit **normalised the whole decode to diffuse white before resampling it**, which is a frame-sized `f64` copy - 1.46GB on a 61MP photo - built only to be box-averaged down to ~1280px on the very next line. The divide belongs inside the resample, where it costs one multiply per sample already being read.

**The pixel stages run across cores.** The resize, the warp and the tone map are all per-output-row independent, and they were the one part of the pipeline still single-threaded while `rayon` sat linked for the SDR geometry search alone. Measured on a 24MP frame, the resize-warp-grade of a 3840px rendition went 270ms to 87ms. `warp` itself is deliberately left sequential: it runs *inside* the fit's candidate scan, which is already parallel.

**A still and its video twin share one grade, and encode at the same time.** Both media run the same resize, warp and tone map, and since the video moved off SVT-AV1 there is no encoder row ceiling to give them different sizes either - so one graded frame serves both, always, and `encode_pair` has no second-grade path at all. They also encode concurrently under one `thread::scope`, both reading that frame and neither writing it: the pair costs about what the slower of the two costs alone. Encoding them as two sequential calls regraded the frame for the second *and* serialised the encoders. The saving is in CPU rather than wall clock, which is why it is worth having and why a stopwatch on one photo will not show it: measured on a 24MP frame at 3840, in-process CPU falls from 649ms to 331ms while wall time barely moves, because the grade parallelises across cores that are otherwise idle and the encoders dominate the clock. An import runs `processing_concurrency` workers at once, so those cores are not idle and that CPU is the thing actually being queued for.

**Resize, then the lens, then grade** - in that order, and each position is load-bearing. The resize comes first because the grade used to run on all 61MP before handing ffmpeg a frame it immediately fitted to 3840, so ~15/16 of the most expensive step was discarded; doing it in linear light here instead is the same picture, and took the full-size rendition from ~7s to 1.7s. The lens stage - the warp, then the falloff - comes next because both models are in normalised radii, so applying them to 61MP to make a 3840px rendition is sixteen times the work for the same result. The grade comes last because the colour was fitted from pairs that only correspond *through* that warp and only carry that falloff.

That reordering used to cost one thing: the levels could not be measured where they were used, because averaging pulls a specular peak in and a downscaled copy then reported a different diffuse white and a different scene peak. That is what reading both ends as quantiles over a fixed sample count fixed (10.7.1) - the anchor no longer moves with the frame's resolution, so it can be measured wherever the frame happens to be, and the decode is free to arrive already fitted.

**The lens and the colour travel as one object**, and that is a fix rather than a preference. They shipped separately at first: the geometry was used to build the fit and then never applied to the output, so an HDR rendition carried the camera's colour on LibRaw's uncorrected shape - a transform applied half, and wrong on its own terms rather than merely different from the SDR copy. `HdrMatch` carries a `Lens` and a colour, so applying one without the other is not expressible.

The falloff repeated the lesson at one remove, which is why the `Lens` exists rather than three parameters. Threaded as `distortion`, `crop` and `falloff` down two call chains, the two routes that build a match each had to remember all three - and the one that fits both halves at once promptly did not, dropping the falloff with every test still green. *Applying* half was unexpressible; *fitting* half was not. One struct closes both.

**`match` is required, not optional, everywhere it is passed.** These option objects are built by spread, TypeScript does not excess-check a spread, and an *optional* field a caller forgets is dropped in silence - which is exactly what happened: `HdrEncodeOptions` never declared it, the worker spread it in, and the product rendered unmatched while a unit test calling `grade` directly went on passing. Written `match: HdrMatch | null`, every call site has to say which it means, and an integration test drives `encodeHdr` rather than `grade` so the wiring itself is covered.

**Verification stops at the signalling.** `ffprobe` confirms BT.2020/PQ/BT.2020-ncl and 10-bit on both media, which `hdr_media.integration.test.ts` does on every run. Whether any of it lights up a panel is not observable from script: the frame goes to the compositor, and anything read back through a canvas has already been tone-mapped. The page that used to put six renditions side by side for looking at on real hardware is gone - it answered that question once, and kept a second encode path alive for years afterwards to keep asking it.

### 10.9 Denoise and sharpen

Four settings - `raw_defringe`, `raw_denoise_luma`, `raw_denoise_chroma` and `raw_sharpen` - each off at 0 and all applied only where the RAW is actually **rendered**. A grid tile made from the camera's embedded JPEG gets none of them: the body has already denoised and sharpened it, and doing either again is doing it twice. The defringe is a lens correction rather than a cleanup and is documented in §10.8, but it runs here, first, as one of the four stages `image::finish` carries.

**The two denoises are separate settings because they answer to different complaints.** Grain in luma reads as a photograph and is worth keeping some of, which is why the luma side is tuned short of what the metric would pick; colour mottle has no such defence and wants all the smoothing it can be given. One number could only ever be set to whichever of the two was more timid. They were a single `raw_denoise` before, so a database carrying it has that value copied onto both and renders exactly what it rendered before.

**On the SDR path the stages straddle the camera match, and which side each falls on is measured rather than chosen.** The denoise and the defringe run on the frame *before* the fit, at the size it will be encoded at; the sharpen runs after the warp, at the end of `render_base`.

The two that go first do so because the fit has to see the frame it will be applied to. Fitted against the raw render instead, the colour transform is calibrated on colour the denoise then removes and nothing puts back - 22% of mean chroma, measured against the match alone - and the lateral tier measures a fringe the defringe also removes, so the two correct it twice. Reversed on IMG_8408 that overshoots from 4.22 to 84.44; fitted on the finished frame the lateral tier finds nothing left and declines by itself, and the fringe lands at 1.17 against 3.53 for the old arrangement.

The sharpen goes last because it is a Richardson-Lucy deconvolution *of the resample's own blur*. Ahead of the warp it inverts a point spread that has not been applied yet and is then softened by the warp that applies it - measured at 17.68 acutance after against 16.38 before.

**Splitting them is also cheaper than one pass**, which is the opposite of what an extra deinterleave suggests. Run together, the sharpen carries the chroma denoise's radius-32 halo through `strip_interior`, which cuts the strips far shorter than the deconvolution alone needs and multiplies the seam work every strip discards. Measured on a 24MP frame, medians of three:

| | wall | CPU | peak RSS |
|---|---|---|---|
| one pass, all three | 4.99s | 32.4s | 316.3MB |
| **split** | **4.43s** | **26.9s** | **316.5MB** |

**The HDR path cannot take the same arrangement, and what it does instead is a compromise.** Its warp happens in scene-linear light before the grade, and every stage here reads a *difference* against a blur - which in linear light follows absolute luminance rather than what the eye reads (below). So there is no display-referred slot ahead of the warp to put them in, and all four run once at the end of `encode_pair`, after the transfer. What was fixed is the half that could be: `hdr::fit_all` finishes the small sRGB render its **geometry** search reads, so the lateral tier sees the fringe the defringe will leave rather than the fringe it will remove, and declines the double correction the same way the SDR path does. The **colour** half still fits against the untouched linear plane. That is tolerable here and was not on the SDR path for one reason: `fit_plane` box-averages the decode down to twice the preview's width, which already removes most of the chroma noise a denoise would have. It is a smaller gap, not no gap.

Four stages, and the order among them is not interchangeable either:

1. **Defringe**, before either denoise, because its regressor is the curvature of luma and its coefficient was fitted against the *raw* luma over the whole frame. Correcting against a cleaned one would apply a coefficient measured in one currency to a curvature denominated in another. The chroma denoise running two stages later is also where any noise a second difference amplifies gets taken back out.
2. **Luma denoise**, a self-guided filter regularised by the frame's own measured noise, scaled by `raw_denoise_luma`.
3. **Chroma denoise**, a guided filter on the colour differences with that cleaned luma as the guide, its radii scaled by `raw_denoise_chroma`. With stage 2 off the guide is the raw luma, which is the guided filter's ordinary case and costs only a noisier edge to follow.
4. **Sharpen**, a Richardson-Lucy deconvolution of the cleaned luma.

Everything runs at the rendition's output size, on display-referred samples - sRGB for a rendition, PQ for the HDR pair (10.7). A difference taken in linear light is proportional to absolute luminance, so it treats a highlight and a shadow completely differently; these all read differences, so they all belong after the transfer.

**A rendition is not bit-identical across machines.** The box mean's vertical pass bands by core count, so its running sum accumulates in a different order on different hardware - measured, 16-27 samples in 300,000 differ by one count between 1 and 16 threads. Nothing in-process depends on it (the AVIF differential compares two routes in one process), but an on-demand `max` export re-rendered on another machine will not hash the same as the one taken at import.

**Two caveats on the constants, both worth knowing before trusting them.** They were tuned on an sRGB rendition, and two of them - the coarse chroma cap and the chroma `eps` - are absolute fractions of full scale, which sRGB and PQ do not share: the HDR pair gets the same numbers and nobody has measured whether they are the right ones there. And the sharpen's point spread is justified by the resample, which the **`max` rendition never had** - it is native resolution, so a deconvolution modelled on a downscale is being applied to a frame that was not downscaled. Neither is a defect anyone has seen; both are claims this section has not earned.

#### The guided filter, which is two of the three

He, Sun and Tang's guided filter fits `q = a·guide + b` over every window, with `a = cov/(var + eps)`. Where the guide varies a lot - an edge - `a` goes to 1 and the output follows the guide; where it barely varies, `a` goes to 0 and the output is the local mean. The smoothing is **steered by structure rather than by distance**, which is what a Gaussian cannot do and a bilateral filter pays dearly for. It runs on box means, so it is **O(1) in the radius**: a radius-6 window costs what a radius-1 one does.

- **Chroma, guided by luma, at two radii.** The filter's canonical application, and it is what lets the radius grow. Luma is preserved *exactly*: red and blue are carried as differences against it and green is solved back out of the luma equation, which is YCbCr's own construction and makes "luma does not move" a property of the arithmetic rather than a hope.
- **Luma, guided by itself.** Windows varying by less than the noise collapse to their mean; windows holding an edge keep it.

**Chroma noise has two scales and needs two passes.** The fine one is per-pixel speckle. The coarse one is low-frequency mottle - patches of green and magenta the size of a window - and a radius that clears the speckle cannot touch it: a 9-pixel window cannot average away a 40-pixel blotch. Radius 4 then 32, which is affordable *only* because the filter is O(1) in the radius. A Gaussian at 32 would be 97 taps a pixel and out of the question; this is most of why the filter underneath is the one it is.

**The luma guide is not enough on its own at that radius, and finding out why is worth recording.** It can only protect an edge it can *see*. A red wall meeting a grey roof is a large step in colour and a small one in luma, so a 65-pixel window spanning both fits one linear model across the pair and pours red onto the roof - which is exactly what it did. Amplitude separates the two cases where the guide cannot: low-frequency chroma noise is a couple of percent, a wall against a roof is tens of percent. So the coarse pass may move a colour by no more than 2% of full scale. It removes a blotch and cannot restructure a picture - the same shape of guard as the deconvolution's anti-ringing clamp below, arrived at the same way. Measured on the roof, blotch-scale chroma energy falls 79% under the fine pass alone, 95% with the coarse pass unbounded and bleeding, and **91% bounded**.

**The luma radius is set by statistics, not by composition** (`LUMA_DENOISE_RADIUS`). The filter blends on `var / (var + eps)`, so it decides "flat or detail" from a variance measured over its window - and a variance from n samples is itself uncertain by about `sqrt(2/n)`. Radius 2 is 25 samples and 29% uncertain, which lands as **patchy smoothing**: neighbouring parts of one roof come out blurred or grainy depending on which way the estimate fell, and that reads worse than the grain being removed. Radius 6 is 169 samples and 11%, and is uniform. A wider window does not blur more; what it cannot do is resolve detail narrower than itself, which is why it is not wider still.

**It was tried for the sharpener too, and that is the instructive failure.** An edge-aware base layer for an unsharp mask is halo-free, which sounds like the answer - and it is halo-free *because* it keeps the edge in the base. What is left in `I − guided(I)` is texture and noise and no edge at all, so sharpening it sharpens everything except the thing that needed sharpening. The unit tests caught it before a picture did.

#### Deconvolution, not an unsharp mask

An unsharp mask has no model of what softened the picture. It adds back a scaled copy of the high frequencies, and the overshoot that leaves either side of an edge **is** the halo. Richardson-Lucy has a model - the point spread the resample applied - and iterates towards the image that, blurred by it, would have produced the one in hand. The edge comes back *steeper* rather than merely higher-contrast. It is what RawTherapee calls capture sharpening.

Three things it needs to be usable here:

- **Early stopping.** RL converges towards inverting the blur exactly, which on a real frame means converging on the noise too. Ten iterations is the regularisation; past about twenty, grain sharpens into speckle.
- **Denoising first.** Not a preference - RL will invert grain as readily as blur, so anything left in luma at this point is what gets sharpened.
- **Anti-ringing.** RL's maximum-likelihood solution rings against a hard edge: measured on a step from 60 to 180, ten iterations undershot to **54**. Each output is clamped to the range its own neighbourhood already spanned, which removes the overshoot and leaves every recovery *within* that range untouched. That is all of the sharpening and none of the halo, and `the_sharpen_does_not_overshoot_the_edge_it_recovers` holds it.

`raw_sharpen` blends the result rather than scaling a correction, so 1.0 is the deconvolution as computed. The iteration count already decides how far the estimate goes; multiplying its output would just re-introduce the overshoot.

#### The noise is measured, not predicted

`image::noise_level` takes a high-pass residual and reads its **median** absolute value. The median is what makes it work on a photograph: edges and texture are a minority of pixels and arbitrarily large, so they drag a mean anywhere, while the median sits in the flat majority where the only signal is noise. It is the estimator wavelet shrinkage has used for thirty years, and it costs one box mean and a histogram.

**This replaced an ISO scaling, and is strictly better.** The ISO was there to solve a real problem - one number for a five-stop library is far too heavy at one end or does nothing at the other - but by the time the denoise runs, the frame has been demosaiced, resampled (which averages some of the noise away) and graded, possibly by several stops. None of that is in the ISO. Asking the pixels needs no reference ISO, no cap, and no special case for a body that records nothing. `the_noise_estimate_lands_where_a_real_frame_puts_it` holds the estimate to the range the filter's constants assume, on both fixtures, because an estimate an order of magnitude out would either do nothing or flatten the picture with nothing in between.

#### What it is worth, per plane

The metric is high-frequency energy - mean squared difference against a σ2 blur of the same crop - taken **separately on luma and chroma**, over two flat regions and one detailed one, on a 24MP EOS R10 frame shot at dusk at ISO 2000. Per-plane matters: an RGB measurement is dominated by luma, which is how an earlier version of this section certified a chroma denoise that had changed nothing visible.

| | flat sky | flat water | detailed roofline |
|---|---|---|---|
| **chroma** | −100% | −100% | −97% |
| **luma** | −99.5% | −25% | +19% |

That is the shape the whole section is trying to reach: noise gone from the flat regions in both planes, and the detailed one *up* despite the denoise having run over it. Decomposed on the roofline, luma HF goes 144 → 121 under the denoise alone and up to 171 once the sharpen runs - past where it started, and made of detail rather than grain.

**The flat-water column is the tuning, and it is deliberately not the best number available.** At `LUMA_DENOISE_SIGMAS` 2 it reads −53% instead of −25%, and a dark roof at 100% has visibly lost its shingle texture. Grain reads as a photograph; smearing reads as a fault. The metric cannot see that difference, which is the whole reason the constant is set by looking and the number is recorded as the cost of doing so.

**This is the ceiling of the approach, and it is worth saying so.** Every artefact chased out of this chain was a local filter deciding "signal or noise" from a local statistic, and being wrong in a spatially varying way: patchy smoothing from an unstable variance, colour bleed from a guide that could not see an iso-luminant edge, ringing from a deconvolution with no noise model. Each has a guard now, and each guard is a constant that was tuned by looking. What remains on a dark roof at 100% is fine grain this class of filter cannot separate from the roof's own texture, because at that scale and amplitude there is nothing local to separate them by - and the settings are deliberately short of the point where it tries to, since the failure on that side is smearing and the failure on this side is grain.

#### What it costs

| | wall |
|---|---|
| neither | 605ms |
| both | 1294ms |

**It runs in horizontal strips, and that is what makes it affordable at all.** Every stage works on `f32` planes and the guided filter needs several live at once, so on whole frames the scratch is a dozen planes of whatever it is handed: 39MB each at a 3840px rendition, 96MB each at 24MP native. Measured, that was 671MB and **1576MB** peak RSS, against a §10.7 budget of 954MB for `max` - and a 61MP body would have been 2.5x worse again.

Every stage here is *local with bounded reach*, so a strip that carries enough context produces exactly what a whole-frame pass would. `strip_interior` picks a row count from a 64MB scratch budget - solved for `interior + 2 * halo`, not for the interior alone, since the halo is fixed in *rows* and budgeting only the interior lets the peak grow linearly in the frame's **width**, measured at 2.7x the budget on a 9504-wide frame. So the peak stops scaling with the frame in either direction:

| | neither | both |
|---|---|---|
| `full` at 3840 | 339MB | **339MB** |
| `max` at native resolution | 540MB | **573MB** |

At the rendition size it no longer costs anything measurable, and at native resolution it costs 33MB rather than a gigabyte. At `raw_denoise_chroma` 3, the schema's maximum, native resolution measures **563MB** - the same, where before the budget was solved properly it gained another ~205MB. The duplicated work at the seams - each strip also computes its halo and throws it away - is **~3%** of wall clock.

One case the budget cannot honour: a very wide frame at a very high strength floors at `3 * halo` rows of planes, because a strip may never be thinner than its own halo. That is enforced in `finish_in_strips` rather than only where the caller picks the height, since a strip below the halo would silently take its context from rows an earlier strip had already written over - measured at an interior of 10, rows wrong by 257 counts with no panic and no seam loud enough for the equivalence test to notice.

**The halo is the whole correctness argument, and it is bigger than it looks.** A guided filter of radius r reaches *2r*, not r: it box-means the input and then box-means the fit. The chroma path composes three of them - guided by a luma that was itself filtered, then filtered again at the coarse radius - so the reaches add, giving `2 * (6 + 4 + 32) = 84` rows at the default. Richardson-Lucy adds its point spread twice per iteration, 40 rows over ten, plus the anti-ringing window.

Two things follow that are not obvious. The **noise estimate has to stay global** - it is accumulated into one histogram strip by strip, because a per-strip estimate would have each strip denoise by a different amount and seam. And the rows a strip writes are the *next* strip's context, so the originals of the last `halo` of them are kept back before the write; without that, every strip after the first reads its neighbour's output as if it were the input.

**Two tests, because the obvious one is not enough.** `strips_produce_what_a_whole_frame_would_have` drives one frame both ways and requires agreement within a single count - not bit-for-bit, because a plane of a different height splits into different bands and a running sum accumulates in a different order, which moves the last bit of an f32.

That test is a seam check and **not** the halo's guard, which is worth stating because it reads like one and is not: measured under mutation, it still passes with the halo cut to a sixth of what it should be. The coarse chroma pass supplies 64 of the 84 rows and is capped at 2% of full scale, so however wrong its context is, the output barely moves. `the_halo_covers_how_far_the_filters_actually_reach` is the real guard: it moves a single pixel at `halo + 1` rows and requires the top row not to change, which measures the *dependency* rather than the difference it happens to make. That one fails as soon as the halo is short by a few rows, and it also pins the direction that matters - influence attenuates long before it ends, so a pixel already inside the deconvolution's reach can fail to shift the top row by a whole count while the dependency is still there.

**~690ms for the pair, roughly doubling the job**, and the honest reading is that this is expensive - though it is time rather than memory, which the strips took care of. Two earlier versions were cheaper and worse: LibRaw's wavelet denoise cost ~400ms on its own and was invisible or waxy with nothing in between, and a chroma-only Gaussian with an unsharp mask cost ~200ms and left the luma grain that is most of what the eye objects to. The settings exist so a library that would rather have the throughput can say so.

**Where the next win is, if it is ever wanted.** [GALOSH](https://arxiv.org/abs/2607.03768) (2026) is training-free and fits a Poisson-Gaussian noise model per image. It is the class of method that does not have the ceiling above, because it decides signal from noise against a fitted noise model rather than against a local variance. Its own reported figures put it ~8dB PSNR above CBM3D on SIDD sRGB and within about half a dB of trained networks on raw, at **2.5s CPU for a 15.8MP frame** - so roughly 1.6s for a 10MP rendition, two to three times this whole stage, for a stage that is already most of the job. Those are the paper's numbers rather than ones measured here, which is the standard the rest of this section is held to and this paragraph is not; it would need reproducing before anything was built on it. It would fit the on-demand `max` path far better than an import.

---

## 11. Metadata Extraction (`metadata.ts`)

Used during sync to populate photo records and compute file hashes.

### 11.1 Implementation

Metadata is read via the same per-format dispatch as decoding (§10): sniff the header, route to the format's reader. libvips is **not** used for RAW metadata, as it has no RAW loader and, when coaxed to open an ARW as a generic TIFF, report the embedded preview's dimensions rather than the full-res sensor values.

For every supported format, metadata comes from **LibRaw's header parse**: `libraw_init` then `libraw_open_file` populates `imgdata.sizes` (dimensions and `flip` orientation), `imgdata.other` (capture `timestamp`, parsed GPS), and `imgdata.color` (color space), followed by `libraw_adjust_sizes_info_only` to flip-adjust `sizes.iwidth`/`iheight` (see below), all **without** calling `libraw_unpack`/`libraw_dcraw_process`, so no pixel data is decoded. This is the fast path used per file during scan. `colorSpace` is the constant `sRGB` output space: LibRaw exposes no stable accessor for the camera's source color-space EXIF tag, and the decode pipeline always outputs sRGB, so this field is fixed (informational + a stable, non-varying hash input) rather than read per file. (`imgdata.color` holds calibration/profile data, not a simple source-space identifier.) The EXIF capture time is naive (the tag carries no zone). LibRaw exposes it only as a pre-computed `time_t` in `imgdata.other.timestamp` (derived by interpreting the naive `DateTimeOriginal` as the process's local timezone), with no accessor for the EXIF `OffsetTimeOriginal` tag. It therefore reads that `time_t` back through the same local zone `mktime` used and re-encodes those components as a `Z` UTC ISO string (§4), which stores the camera's wall clock verbatim whatever the server's zone is; taking the `time_t` as an instant instead would slide every capture date by the server's offset. The stored value is a wall clock rather than an instant, so the client formats it in UTC (`captureDateTime`) rather than in the viewer's zone, which would slide it a second time. The zone itself comes from a second, direct read of the file: `exif_zone.ts` walks IFD0 into the Exif IFD and returns `OffsetTimeOriginal` (0x9011), falling back to `OffsetTime` (0x9010), into the `date_taken_offset` column. An ARW *is* a TIFF, so that walk starts at byte zero. A CR3 is an ISO base-media file, so the box tree is walked first - `moov` into the `uuid` box, to `CMT2`, which holds the Exif IFD as a complete little TIFF of its own - and the same IFD reader takes it from there. Bounded to the first 256KB, so it costs a page or two rather than a read of a 25MB file, and null when a pointer leads past that window. The tags arrived in EXIF 2.31 (2016), so older bodies record nothing and the column stays NULL: a Sony ILCE-7CR and a Canon EOS R8 both write `+11:00`, an ILCE-6300 writes no offset at all. Blank and malformed values ("      ", `+1100`) are read as absent rather than as UTC. It is deliberately not a hash input (§9.2), for the same reason `dateTaken` is not: the hash is a change detector for a file the scan has already decided to open, which only happens once mtime or size differs (§9.1), and mtime is itself hashed. Descriptive metadata therefore adds no detection the hash does not already have. Rewriting the zone tag in place while preserving mtime and size defeats the quick-check before a hash is ever computed, so hashing it would not catch that case either. `date_taken` stays the wall clock either way, so ordering and the date filters are unaffected by whether a body recorded a zone; the offset is what the viewer shows beside the time and what a true instant would be derived from. The reader also `stat`s the file to fill `mtime`/`fileSize`, so the scan-time result carries them all the way to Phase 3 apply (§9.4) without a second `stat` inside the transaction.

**A parsed GPS block is not the same as a fix.** Canon sets `gpsparsed` on every frame and leaves the degree triples at zero when the body had no fix, so trusting the flag alone put a whole catalogue at 0,0 - which is not a null, it is a point in the Gulf of Guinea, and it maps. An all-zero latitude *and* longitude therefore reads as "not recorded".

`width`/`height` are the **display (upright) dimensions**, i.e. after the orientation flip is applied. At `open_file` time LibRaw's `sizes.iwidth`/`iheight` are still in **sensor orientation** (the 90°/270° swap is applied only by `dcraw_process` or by an explicit `libraw_adjust_sizes_info_only()` call), so the reader must call `libraw_adjust_sizes_info_only()` after `open_file` and then read the now flip-adjusted `iwidth`/`iheight`. This is deliberate: the generated renditions are baked upright (§10.4), so storing upright dimensions means `width`/`height` always match the served rendition's aspect. `orientation` is retained separately (as the LibRaw flip orientation code) only as informational metadata and as a file-hash input (§9.2); **clients must not apply it to the served renditions, which are already upright** (doing so would double-rotate).

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

**Sensor crop.** Some bodies (the ILCE-7CR among them) report masked border columns as part of LibRaw's "visible" area, `sizes.width`/`height` equal `raw_width`/`raw_height` with zero margins, while the file separately states the real picture in `sizes.raw_inset_crops[0]`. Decoding the visible area verbatim then bakes black bars down two edges of every rendition. Both the header read and the decode therefore crop to that inset when the file states a usable one (an origin of `65535` means "not stated", and a crop that does not fit the raw frame means the struct layout drifted; either way, no crop). `dcraw_process` emits an upright image, so the sensor-space margins are rotated by the same flip before being applied. The two paths must agree: the stored `width`/`height` describe the picture the rendition shows.

**The inset is measured against what LibRaw already trims, not against the sensor.** The emitted frame starts at `left_margin`/`top_margin` and is `width`x`height`; only the part of the camera's crop falling outside *that* window is still ours to remove. Subtracting the crop from the raw frame instead double-applies it on every body where `left_margin` is already the crop origin - which is every Canon. An EOS R8 lost a further 168 columns and 108 rows, and because the excess came off two sides rather than four the result was not a smaller picture but a differently framed one: 5811x3879 where the camera's own JPEG is 6000x4000, shifted up and left. It also cost the JPEG match (§10.5), which models an overall rescale but has no term for a translation: acceptance across 27 EOS R8 frames was 15/27 before and 27/27 after, median deltaE 4.11 to 1.89, against 27/27 and 1.35 for a Sony set of the same size. Three Sony geometries were over-cropped by 8-32 columns on the right edge by the same arithmetic, which is why this is not a Canon special case.

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

1. **Keep the renditions.** They are *not* removed. The Bin is a view the user browses to find something to restore, and it is useless if every frame in it is a grey placeholder. The two AVIFs are roughly 1% of the size of the RAW the Bin is already retaining, so deleting them saves almost nothing and costs the feature. They are removed only when a photo is permanently purged.

2. **Move RAW file to Bin:**
   - Determine the bin path, where `<bin>` is the library's `bin_name` (§12.3): `<library_root>/<bin>/<folder the photo was in>/<original_filename>`. A photo at `A/B/c.arw` bins to `<bin>/A/B/c.arw`; one in the root bins to `<bin>/c.arw`.
   - If a file with the same name already exists in the Bin, append a numeric suffix (e.g. `IMG_0001_1.ARW`, `IMG_0001_2.ARW`).
   - Move (rename) the file. Do **not** copy-and-delete.

3. **Update DB record:**
   - Set `is_deleted = 1`.
   - Clear both pending flags.
   - Do **not** delete the record.

### 12.2 Restore

`POST /api/photos/restore` is the undo of a soft-delete. Delete records the pre-Bin `file_path` in `deleted_from_path`, and restore moves the RAW back to exactly that path, clears `is_deleted` and blanks the column.

**An undo names the bin, not its photographs.** Delete also stamps every row it takes with a `deleted_batch` the *client* generates, and the undo posts that batch back (`PhotoTargetSchema`, §14). The ids never travel: a bin of a million would be a 36MB response and a 36MB request to reverse it, and the selection those photos came from resolves to different ones the moment they leave the collection (§18.3.3). Client-generated so the undo survives an answer that never arrives - the delete may outlive the socket, and it is exactly then that being able to reverse it matters.

**Everything that is not per-file is done per batch.** Both `delete` and `restore` read their rows in one query rather than a detail payload each, resolve the library and take its sync lock once, create each Bin directory once, and commit a chunk of flags at a time. Per photo - which is what these were - it was a join plus a second query for album membership neither reads, a lock acquire, and its own transaction: **2.231ms per photo before a byte moved on disk**, or 34 minutes to bin a million. Batched, and now measured *including* the renames, it is **0.14ms per photo**.

The chunk is what bounds the exposure the per-photo commit used to bound: the files move, then the flags commit, so a crash in between leaves at most one chunk of RAWs in a Bin the scanner does not look at. A DB failure rolls its chunk's moves back, exactly as the per-photo path did.

- Shoot and album membership need no restoring: soft-delete never touches `shoot_id` or `album_photos`, so both survive the round trip.
- If something else occupies the original path by then, the move takes a numeric suffix rather than overwriting a live photo.
- A row predating the column restores to the library root; the next sync reconciles its shoot from the path.
- Restore is what the client's undo toast calls, so binning is always reversible from the UI.

### 12.3 Bin Folder

**One bin per library, at `<library_root>/<bin_name>/`, laid out inside itself like the library around it.** A photo binned from `A/B/c.arw` goes to `<bin_name>/A/B/c.arw`; one binned from the root goes to `<bin_name>/c.arw`. `bin_name` is `Bin` unless the library was created with another (§4.1), and every bin path comes from `getBinPath` (§6) rather than being spelled anywhere else.

The mirror is what makes one bin possible. Flat, a bin is a heap in which `IMG_0001.ARW` from three shoots are three files distinguished only by the numeric suffix the collision handling adds - fine for the catalogue, which knows, and useless to anyone reading the folder. Mirrored, the bin is browsable on its own terms: where a file came from is written in the path, so it can be recovered by hand if the catalogue is ever lost. Bins inside each shoot folder bought the same legibility, but scattered: one library's deleted photographs in as many places as it has folders, each needing its own skip rule, and none of it visible in one place.

**Never under `data_path`.** A Bin holds originals, and the data directory is the one tree the system deletes wholesale (§6, §10.6); a bin inside it would mean removing a library, or clearing `.bowerbird/` by hand, silently destroying every photograph the user had binned. The bin therefore sits beside the photographs it came from, where the only thing that can remove it is the user.

The scanner skips `<root>/<bin_name>` and everything under it, so soft-deleted files are never re-imported. That is a rule about the root, not about the name: see §9.1.

**A binned photo's folder is `deleted_from_path`, not `file_path`.** Its file is in the bin, so `file_path` points there and no longer shares a prefix with the folder it was taken from - which every folder-scoped operation is keyed on. `listUnderFolder` therefore matches live rows on `file_path` and deleted ones on `deleted_from_path`, and a folder rename (§9.4.1) rewrites `file_path` for the live rows and `deleted_from_path` for the deleted ones. The binned file itself does not move on a rename: it is in the bin, not in the folder that moved, and only where it restores *to* has changed.

Removing a folder from the library (§4.7) takes the deleted rows with the live ones, since what leaves is the catalogue's record of that folder. No file is touched either way - the live ones stay in the folder and the binned ones stay in the bin, both now out of scope, so the next sync re-imports neither.

**Which is why the name is asked for at creation and refused if taken.** The bin is created lazily on the first delete, and the scan skips whatever is at `<root>/<bin_name>` sight unseen - so a root that already keeps its own `Bin` would have had it adopted as one, and every photograph inside it dropped from the import with nothing on screen saying so. `POST /api/libraries` refuses that root outright and the Add-library dialog marks the field against the folder listing it already has, which turns a silent gap into a choice made before the library exists. It is not offered by `PATCH`: the name is what the scan skips, so changing it afterwards leaves the old bin's RAWs in a folder the next sync walks back in and re-imports as new photographs.

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
| `POST` | `/api/libraries` | Create a library. 400 if the root already holds a folder named by `bin_name` (§12.3) |
| `GET` | `/api/libraries` | List all libraries |
| `GET` | `/api/libraries/:id` | Get a library |
| `PATCH` | `/api/libraries/:id` | Update a library (name, default ordering, rendition settings, `include_subfolders`, `mirror_shoots`) |
| `DELETE` | `/api/libraries/:id` | Delete a library |
| `POST` | `/api/libraries/:id/sync` | Trigger sync for a library |
| `DELETE` | `/api/libraries/:id/sync` | Stop the library's current sync (§9.10) |
| `GET` | `/api/libraries/:id/sync/status` | Get sync/processing status |
| `GET` | `/api/libraries/:id/browse` | Folders inside this library at `?path=` (root-relative, `''` is the root), for expanding a folder the Shoots page cannot derive (§18.3.4). Refuses a path outside the root. |
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
| `POST` | `/api/photos/delete` | Soft-delete photos; answers `{ photo_ids }` with what it binned, which is what an undo restores |
| `POST` | `/api/photos/restore` | Restore soft-deleted photos to where they were deleted from (§12.2) |
| `POST` | `/api/photos/rebuild-tiles` | Rebuild the grid tiles of a selection, and nothing else (§10.3) |
| `POST` | `/api/photos/refresh-metadata` | Re-read the RAW headers for a selection |

**Every bulk route takes the same two body shapes** (`PhotoTargetSchema`): `{ photo_ids: string[] }`, capped at a thousand, or `{ selection }`; a collection, the filters it was viewed under, and runs of positions in it (§18.3.3). The second exists because a client holds only a window of a large collection and can never have the ids for the rest: the server reads them off the same filtered, collection-ordered listing the grid was built from, so acting on a hundred thousand photos is one small request. A selection states no ordering; the collection owns that (§18.3.1), and a client naming one could describe an order the selection was never made in.

**The whole selection resolves in one pass**, numbering the rows once (`ROW_NUMBER() OVER (ORDER BY …)`, bounded by the last run's end) and reading every run out of that numbering. The obvious shape - one `LIMIT/OFFSET` query per run - is quadratic in disguise: a run costs the same whatever its length, but each query re-sorts the collection, so five hundred scattered picks meant five hundred sorts. Measured at a million photos: **433 seconds for five hundred single-photo runs, against 0.28 seconds** for the same request resolved in one pass. `ranges` is capped at ten thousand entries, which bounds the body; it is this that bounds the work.
| `POST` | `/api/photos/:id/lossless` | Build the full-resolution lossless render (§10.5) |

Query parameters for listing (`PhotoListQuerySchema`, §5.3):
- `offset` (int, default 0)
- `limit` (int, default 100, max 500)
- `is_missing` (boolean, optional filter)
- `needs_tile` (boolean, optional filter: photos with no grid tile yet)
- `include_deleted` (boolean, default false)
- `is_deleted` (boolean, optional filter)
- `rated` (boolean, optional: `true` = at least one star, `false` = unrated)
- `triage` (optional, comma-separated verdicts to include, e.g. `triage=untriaged,picked` for the default gallery view that hides rejects)
- `ordering` (optional, overrides the collection's stored ordering for this request only, so a client sort control does not edit the library)
- `q` (optional, case-insensitive substring of `file_path`)
- `taken_from` / `taken_to` (optional `YYYY-MM-DD`, inclusive bounds)
- `match` (optional, `all` (default) or `any`)
- `expand_stacks` (boolean, default false: list every photograph of a stack as a row of its own rather than the stack as one, §19.5.4)

The same schema serves the library, shoot and album listings, so a filter behaves identically wherever the user is.

`rated` is a "has any rating" test rather than an equality one, because the question during a cull is "what have I not judged yet".

`match` selects how `rated`, `triage`, `is_missing` and `needs_tile` combine. `all` intersects them; `any` unions them, which is what a "show me anything still needing attention" filter means; as an intersection, "picks and unrated and missing" is almost always empty. It applies only to those four: scope (soft-delete, `q`, the date range) always intersects, so narrowing by filename or date still narrows a union.

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
| `GET` | `/image/:photoId/renditions/:rendition` | Stream one rendition: `grid`, `full` or `max` (§10.1) |
| `GET` | `/image/:photoId/renditions/:rendition/video` | The one-frame AV1 twin of an HDR rendition (§10.7) |
| `GET` | `/image/:photoId/embedded.jpg` | The camera's own JPEG, lifted out of the RAW unchanged |
| `GET` | `/image/:photoId/download/:form` | As an attachment: `original` (the RAW), `embedded`, `full` or `max` |

**Dynamic range is not in the URL.** The library decides it, so a client naming `full-hdr` would be guessing at a file that may never have been built; the route resolves it from `rendition_hdr` instead, and `PhotoDetail.renditions` tells the client what it is looking at.

**One download route rather than four**, because the menu offering them is one list and only the bytes differ: the RAW streams from disk, the camera's JPEG is lifted out of it, and `full` / `max` come from the stored AVIF. Nothing here is stored - extraction is a header read plus a copy, a download is occasional, and a JPEG per rendition on disk would cost more than either does.

**The rendered forms are transcoded to JPEG only where the library is SDR.** JPEG cannot carry PQ, so transcoding an HDR rendition would hand back an SDR tone-map of the picture that was on screen and name it the same render - the one thing a download of what you are looking at must not do. An HDR library's `full` / `max` therefore stream the AVIF itself, which is the format the viewer displayed and the only one here that carries HDR (§10.1). `full` and `max` must already be built: building one is the viewer's own request (`POST /api/photos/:id/renditions/:r`), and a download that silently took minutes would look like a hung browser, so the client builds first and then navigates.

The RAW download goes through the same file path as the renditions rather than being buffered, so a client can seek inside a 25MB original (`Accept-Ranges`, 206 partial content).

**Caching.** Renditions are rebuilt in place under a stable URL, so every image response carries an `ETag` (file size + mtime) and `Cache-Control: no-cache`. Without a validator the browser caches heuristically with nothing to revalidate against, and keeps showing the pre-rebuild picture; `no-cache` still caches, it just always asks first, which is a 304 in the common case. `If-None-Match` is answered directly.

That covers everything that *asks*, which is every fresh page load. But an `<img>` whose `src` attribute has not changed never asks at all, so a rebuild is invisible to the copy already decoded in a live page; and a fresh element with the same `src` is handed that copy without revalidating, so remounting does not ask either. Every image URL therefore carries a version (§18.6): the stamp of whatever produces its bytes - `tile_built_at` for the grid, `renditions_built_at` for the viewer's two, `date_updated` for the camera's JPEG, which is lifted out of the RAW per request. Stamped by whatever wrote the file and delivered on the row, so it is right from the first render, identical in every client, stable across reloads, and moves only when its own file did. Two URLs, two cache entries; the ETag then keeps each of them honest.

These endpoints:
- Resolve the file path from the photo record and library configuration.
- Stream the file directly from disk using Bun's file streaming (no buffering into memory).
- Set appropriate `Content-Type` headers (`image/avif` or `image/x-sony-arw`).
- Set `Content-Length` from file stats.
- Return 404 if the file does not exist on disk. Soft-deleted photos **are** served: the row and both files still exist, and the Bin view depends on being able to render them (§12.1).
- Support `Range` requests for partial content (HTTP 206), enabling seeking for large files. `Bun.serve` answers these against a `BunFile` body (including `Content-Range` and a 416 for an unsatisfiable range) but does not advertise the capability, so the handler sets `Accept-Ranges: bytes` itself.

The served renditions are already rotated to display orientation (baked in during processing, §10.4), and the `width`/`height` in photo responses are the matching upright dimensions. Clients render them as-is and must **not** apply the photo's `orientation` value to them.

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
| `GET` | `/api/browse` | Directories inside `?path=`, or the home directory when it is omitted, for the folder picker that adds a library. Absolute paths, and unfenced: a library root can be on any mount, and `POST /api/libraries` already accepts any absolute path. The per-library form (§13.1) is fenced, because there a folder outside the root is wrong rather than merely unhelpful. |

Two scopes, not three: the `libraries` row holds what belongs to one catalogue (the rendition source and HDR, §10.2), and `settings` holds everything app-wide - the viewer's `viewer_rendition_mode` and the rendition `remember` remembers, alongside the server's own tuning (§15). A key/value table rather than a column per setting because they are read one at a time and never queried across, and adding one should not need a migration; values are stored as text, and the default's type says what to read one back as. A value the build no longer understands reads as its default rather than failing the request: a bad row must not stop the viewer opening or the server booting.

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

Three environment variables, and only three: what has to be known before the
catalogue can be opened.

| Variable | Default | Description |
|---|---|---|
| `HOST` | `0.0.0.0` | HTTP server bind address |
| `PORT` | random | HTTP server port, printed on startup; `-p <port>` overrides it |
| `DB_PATH` | `./bowerbird.db` | SQLite database file path |

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
| `raw_denoise_luma` | `0.5` | Strength of the self-guided luma denoise on a rendered RAW, regularised by the frame's own measured noise. Half of what the metric tunes to, because at 1 fur and foliage lose the fine structure that makes them read as photographs; 0 is off (§10.9) |
| `raw_denoise_chroma` | `1` | Radius scale for the luma-guided chroma denoise on a rendered RAW. Not halved alongside the luma side: that judgement was about brightness detail, which this filter never touches; 0 is off (§10.9) |
| `raw_defringe` | `1` | Ceiling on the measured focus difference between channels, which is what a colour fringe at a hard edge is. The amount is fitted per frame, so a frame with the channels in focus is left untouched at any setting (§10.8) |
| `raw_sharpen` | `0.6` | How much of a Richardson-Lucy deconvolution to blend in, once the render is at size; 0 is off, 1 is all of it (§10.9) |
| `grid_rendition_size` | `800` | Longest edge in pixels for the grid rendition |
| `grid_rendition_quantizer` | `13` | libaom quantizer for the grid rendition, 0-63; lower is better (§10.1) |
| `full_rendition_size` | `3840` | Longest edge in pixels for the full rendition |
| `full_rendition_quantizer` | `13` | libaom quantizer for the full rendition, 0-63; lower is better (§10.1) |
| `lossless_sdr_quantizer` | `8` | libaom quantizer for the SDR full-resolution export (§10.5) |
| `sdr_full_chroma` | `false` | 4:4:4 rather than 4:2:0 for the SDR renditions. Roughly twice the encode time and three times the size, for chroma detail on saturated edges (§10.1) |
| `lossless_quantizer` | `4` | libaom quantizer for the HDR full-resolution export; lower is better (§10.5) |
| `hdr_peak_nits` | `1000` | Display peak the BT.2390 roll-off targets, and the declared mastering peak (§10.7.1) |
| `hdr_reference_white_nits` | `203` | ITU-R BT.2408 HDR Reference White; what diffuse white is graded to (§10.7.1) |
| `hdr_white_quantile` | `0.90` | Quantile of the frame taken as diffuse white (§10.7.1) |
| `hdr_crf` | `10` | libaom quantizer for both HDR media, 0-63; lower is better (§10.7) |
| `hdr_preset` | `8` | Encoder speed; libaom `-cpu-used` 0-8 and avifenc `--speed` 0-10, both clamped (§10.7) |
| `hdr_still_full_chroma` | `false` | 4:4:4 rather than 4:2:0 for the HDR still. Holds chroma detail, roughly double the encoder's memory (§10.7). The video has no say |
| `watch_enabled` | `true` | Auto-sync a library when its files change on disk (§9.8) |
| `watch_debounce_ms` | `2000` | Debounce window for coalescing filesystem events (§9.8) |
| `full_sync_at` | `03:00` | Local `HH:MM` for the daily full reconcile; `""` disables (§9.8) |
| `prune_every_days` | `7` | Interval for the orphaned-file sweep; `0` disables (§10.6) |

Two shapes of consumer, and they take a setting differently:

- **Read per use.** Processing asks `SettingsRepository` for the size, quality
  and grade of every job it builds, so an edit lands on the next photo without
  anything being told about it.
- **Configured, then re-configured.** The watcher, the daily reconcile, the
  orphan sweep and the log level are established once at startup and re-applied
  from `settingsRepo.onChange`. A `configure()` on each restarts only what
  actually moved, so a knob on the Settings page never means "after the next
  restart".

`LOG_LEVEL` remains as an environment override, and wins where it is set:
logging starts before the database is open, a server that will not boot cannot
be turned up from its own settings page, and the test scripts use it to stay
quiet.

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
- Files in the library's bin are excluded, and a folder of the user's own further down sharing its name is not (§12.3)
- Non-ARW files are ignored
- Reappearance: a previously-missing file back at its original path clears `is_missing` (§9.4 step 4)
- Move into a known shoot folder sets `shoot_id`; move out to root clears it (§9.4 step 1)
- mtime change (e.g. in-place edit) marks a file MODIFIED and re-processes it (§9.2)
- Sync lock: a second concurrent sync of the *same* library throws `SYNC_IN_PROGRESS`; two *different* libraries sync concurrently; a stale lock (dead PID) is reclaimed (§9.7)
- Concurrency vs. a user mutation mid-scan: an in-flight move's hardlink pair (link+unlink) is collapsed by inode so no duplicate row is inserted; a library deleted mid-scan aborts `NOT_FOUND` (no FK crash); a stale sync generation's detached processing tail doesn't stomp a newer sync's status
- Stopping (§9.10): a stopped rescan applies nothing and marks nothing missing, opens no further files and returns an idle status; a stopped *first* scan keeps the photos it reached (nothing to be absent from) and adds no missing rows; mid-processing the run ends rather than waiting itself out, leaving the unreached photos pending; a batch a later sync coalesced into is still what a stop reaches

**Photo deletion:**
- Renditions are kept, so the Bin can be browsed
- RAW file is moved into the library's one bin, under the folder it came from (`A/B/c.arw` → `<bin>/A/B/c.arw`, root → `<bin>/c.arw`)
- DB record is marked `is_deleted = 1`, not removed
- Filename collision in Bin (numeric suffix), which the mirror leaves for two files of one name in one folder rather than one name anywhere in the library

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
8. **Metadata extraction**: `metadata.ts` (per-format header parse; LibRaw for ARW and CR3).
9. **Photos service + API**: CRUD, listing, filtering.
10. **Processing service**: Worker-based rendition generation (reuses the RAW decoder).
11. **Sync service**: Full sync algorithm with move detection, reappearance handling, shoot-membership reconciliation, and the per-library sync lock (§9.7). Depends on the processing service (§8.4), which it calls to trigger rendition generation (§9.5).
12. **Shoots service + API**: CRUD, photo assignment with file moves.
13. **Albums service + API**: CRUD, photo assignment.
14. **Image streaming API**: Static-path file streaming endpoints.
15. **Deletion flow**: Soft-delete with Bin and rendition cleanup.
16. **Integration wiring**: `index.ts` — dependency injection, Hono app setup, server start.

---

## 18. Web Client (`web/`)

A separate Vite + React app with its own `package.json`, dev server and build. It is a pure API consumer: it holds no photo logic of its own and talks to the server over HTTP.

Every request it makes is same-origin. The web server proxies `/api` and `/image` (and the API's own `/quality-check` page) through to the API, so the browser never needs a route to the API host, only the web server is exposed, and the API stays internal. `VITE_API_URL`, or `VITE_API_PORT` for the common case of another port on the same host, tells the proxy where to send them; nothing in the bundle carries an API address. The API still carries CORS (§15) for other consumers, but the web client no longer relies on it. `VITE_ALLOWED_HOSTS` (comma-separated) lists the domains the dev server will answer to when it is served over one.

### 18.1 Stack

| Concern | Choice |
|---|---|
| Build / dev server | Vite 5 (random port, bound to `0.0.0.0`) |
| UI | React 18 |
| State | MobX 6 with standard (TC39) decorators |
| Routing | React Router 6 |
| Components | Base UI (unstyled primitives), wrapped once in `src/ui/`, a module per control plus the types and metrics they share |
| Icons | lucide-react |
| Calendar | react-day-picker, restyled through its CSS variables |
| E2E | Playwright, driving the real API and a temp library |

Every control on screen comes from `src/ui/`, one module per control with no barrel, and each variant list is short on purpose: four button variants, four text roles, two heading levels. Uniformity is enforced in code rather than by discipline; every interactive element in the app carries the same `.ui-btn` class - `Button`, the segmented filter chips, `Select`, `TextField`, the menu triggers - so height, type size and icon size cannot drift between a filter and a toolbar button. A new fifth colour or a fifth text style should mean rethinking the screen, not adding a variant.

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

`/settings` (add / remove libraries, per-library name, renditions and sync, and the app's own settings), `/libraries/:id` (grid, filters, selection, bulk actions), `/libraries/:id/shoots` (tree + create), `/libraries/:id/bin`, `/shoots/:id`, `/albums`, `/albums/:id`, and the viewer and triage session nested under whichever of those grids they were opened from: `<collection>/photos/:id` and `<collection>/stacks/:id/triage`, where `<collection>` is `/libraries/:id`, `/libraries/:id/bin`, `/shoots/:id` or `/albums/:id`.

**The viewer is nested rather than flat** because a photograph is in a shoot or an album as much as it is in a library, and one `/photos/:id` cannot say which of them the reader is in. Held only in the store, that fact did not survive a reload: a photo opened from a shoot came back as a photo in the library, so the way out was the wrong grid and prev/next stepped through the wrong run. Triage is nested for the same reason - a session ends by returning to a photograph. `collectionPath` builds these paths and `sourceOfPath` reads them back. Bare `/photos/:id` and `/stacks/:id/triage` remain as deep links, and fall back to the photo's own library.

Every registered library is listed permanently in the rail, and the active one expands to its sections. There is no "choose a library" screen: adding one is a setup step that belongs in Settings, not a gate you pass through on each visit. Syncing lives in Settings for the same reason: it is maintenance on the library, and the gallery is for looking at photos. Settings and the shortcut sheet sit together at the foot of the rail, apart from the catalogue links, because they are about the app rather than the photographs.

Adding a library is one button and a dialog, holding everything the library needs before it exists: the folder, a name, and the ordering its gallery starts in. The folder is walked with a picker over `/api/browse` as well as typed, because the path is read on the server, which may not be the machine the page is open on, so a path that exists in this browser's world is not necessarily one the server can open.

Adding a library also decides how much of the folder tree it is and whether those folders are shoots (§4.1). Both belong in the dialog rather than in Settings afterwards, because the answers change what the first sync imports, and a library that has already spent an hour building renditions for a folder of decade-old rejects has answered the question the expensive way. They remain editable per library in Settings, where turning subfolders off disables the shoots controls and says why.

Adding a shoot is **not** a dialog with a folder picker any more, for the reason the picker existed: a shoot is a folder, and the Shoots page is now a view of the folders themselves (§18.3.4), so the folder is chosen by pointing at it rather than by re-walking the tree inside a modal. What survives as a dialog is the part a folder cannot answer - a name for a folder that does not exist yet, and the shoot's own ordering.

The rest of Settings is ordered by how often a decision is made rather than by which subsystem owns it. What a library builds and how photos open sit at the top; the encoder sizes, qualities, HDR grade and server knobs are numbers tuned once, so they live in one collapsed **Advanced settings** disclosure. The HDR settings are disabled, with the reason as their tooltip, while no library builds HDR renditions: nothing reads them until one does.

There is no title bar. It only ever restated the library the rail already highlights, and the vertical space is worth more to the photographs.

Only `/libraries/*` names the library in the URL. Shoot and photo routes resolve it from the loaded entity so the rail keeps its context on a deep link, instead of blanking out. The photo route resolves it through a `@computed`, and the detail is not cleared while the next one loads, so stepping between photos in one library re-renders nothing in the shell.

### 18.3.1 Gallery controls

Five named views (Active, Untriaged, Picks, Rejects, All) answer the questions asked constantly and cost one click. Everything rarer lives behind a **Custom** menu of checkboxes that sends `match=any`, so ticking several means "any of these" rather than an empty intersection. A calendar range, a filename search, a sort and a rendition-size slider complete the row.

There is no "clear filters" button and no "default order" entry: All is the clear, and the sort always shows the concrete ordering in effect.

**The sort belongs to the collection, and there is exactly one copy of it.** It lives in `libraries.ordering` / `shoots.ordering` / `albums.ordering`, which every list read already falls back to. So the client sends no `ordering` at all: it asks for a page, and the response states the ordering it was built in (`PhotoListResponse.ordering`), which is what the control renders from. Sorting a gallery `PATCH`es the collection and re-reads, rather than setting a local value and hoping the write landed.

That is why the store starts at `null` rather than at a default: a value invented client-side would be a second answer to a question the collection already answers, and the two diverge the moment either moves - which is what a per-browser sort did. Opening the same shoot on a phone found it sorted differently to the desktop, and the rendition queue, which is built server-side in the collection's order (§10.2), could not follow a preference it was unable to see. The control renders once the first page has landed; there is no frame in which it shows a guess.

The bin and the missing view sort by their library's ordering, since they are slices of it rather than collections owning one.

Presets are named points in the same space as Custom, so selecting one shows its constituents already ticked there rather than leaving the menu looking untouched.

Three view modes share the same tiles: **grid** crops nothing but gives every photo a uniform cell so rows line up, **masonry** lets each keep its own shape in rows that read across before they read down (flex lines grown from each photo's stored aspect, so no DOM measurement, and no column that a paged list would have to fill to the bottom), **list** trades density for filename and date. The zoom slider runs from many-across to a single photo filling the width.

Filter, tile size and view mode are remembered per collection in `localStorage`: those are about the machine you are sitting at, and a tile size chosen for a 32" display is wrong on a phone. The sort is not among them, for the reason above. The filename search and the date range are not remembered either, being questions asked in the moment rather than preferences.

Rating and verdict sit on every tile, always visible and clickable, because a cull is mostly those two decisions and routing them through the detail view is what turns a ten-minute pass into an hour. Clicking the verdict a photo already has, or the star it already sits on, clears it.

A verdict or rating can move a photo out of the slice being viewed, so a change re-reads the collection (§18.3.2) when a triage or rating filter is active. Filtering locally instead would mean a second copy of the server's filter logic, free to drift.

**A click selects; a double-click opens.** Choosing photographs is what a grid is mostly for and opening one is a gesture used once per photo, so the frame belongs to the selection: a plain click selects that photo *alone*, cmd-click toggles, shift-click extends, and the second click of a double-click opens the photo view. That is what takes the tick box off every tile: a control per tile existed only to leave the frame free to navigate. A **stack** is the exception in the other direction - its tile opens its band on the *first* click, alongside selecting it, because the band is how you see what you just selected and the tile stands for the whole stack rather than for a photo to open (§19.6).

**The selection and the keyboard cursor are one thing, with one ring.** They were two - glass for the selection, satin for the cursor - which was defensible while a selection was something you assembled deliberately and rare otherwise. Once a click selects, every gesture makes one, and two rings on the same tile only ever raised "why is this one different". So an arrow key *selects* the photo it lands on, a click moves the cursor to what it selected, and dropping the selection (`Escape`, or Clear) takes the cursor with it. Building a set from the keyboard is `Space`, which toggles without moving.

**The ring is drawn off the selection alone**, not off "selected or the cursor". Both were tried; the cursor half is wrong because cmd-clicking a selected photo moves the cursor onto the very photo it deselects, which left a ring on a photo nothing was about to act on. Keeping them in step is therefore the job of the gestures, and of one rule afterwards: an action that has consumed a selection leaves **the cursor, selected** - so a cull that bins the photo it is on carries on from the row that took its place, with the ring saying which row that is rather than `Del` acting on a photo nothing marks. The exception is a collection whose positions now hold something else (a filter change): there the positions go and the cursor stays bare, because until the next block lands it may name a row this collection does not have.

The surviving ring is the **house blue** (`--satin`), which no band colour is allowed to be (§19.6), and its weight and corner are one token each (`--ring`, `--radius`) shared with the ring on an open stack's tile and the outline round that stack's band - three parts of one thing, drawn three ways until they were pulled together. A tile carries the same corner as the ring on it, so the ring follows its edge. And a selected tile whose stack is open draws *only* the band's ring: the band colour is the only thing pairing a tile with the rows it opened (§19.6), so a selection ring over the top of it would break the pair.

`Enter` is the double-click for the keyboard, and it has to `preventDefault`, since the frame under the cursor is a button and its own click would otherwise fire behind the navigation and cut the selection down to that one photo. It is the one cull key that is *not* global: every other button, link, menu item and dialog owns its own `Enter`. So that it is not dead for a reader who arrived by clicking the rail link, **an arrow key hands the focus to the scroller** - arrowing the cursor is the reader taking the grid over, and the tab order should follow them there.

**Shift-click extends from the anchor**, which is the last photo toggled on its own, falling back to the keyboard cursor when nothing has been - arrowing to a photo and shift-clicking another is the same gesture as in a file manager, and a first shift-click has nothing else to reach for. Extending moves the cursor itself rather than leaving that to the caller, which would have to know to focus *after* extending: with focus as the fallback anchor, focusing first makes every range start and end on the photo just clicked.

The bulk action bar is the **header's second row**, directly under the filters and where the selection was made rather than at the foot of a grid the user has scrolled away from. Its actions include rebuilding renditions for the selection from either source (§10.3).

Its own row holds only what the selection *becomes* - **Stack**, **Unstack**, where it is added, what it is removed from - and the three maintenance actions (**Rebuild thumbnails**, **Refresh metadata**, **Move to Bin**) sit behind a `⋯` overflow, reached deliberately. Stack and Unstack are the two that come and go rather than grey out, because they are not "this action, once you have a selection" but statements about what the selection *is*: two photos to fuse, or one stack to break. Greyed out, they read as actions the reader has failed to reach.

**The bar is always drawn, with its actions disabled until there is something to act on.** Rendered only when a selection existed, it appeared and disappeared under the reader - and since a click selects, that moved every tile down by a bar's height *between the two clicks of a double-click*, so the second click landed on a different photo and opened nothing; reliably in list mode, whose rows are shorter than the bar. Being permanent also means nothing else takes its menus away, so the shoot and album menus have to close on select themselves - as one-shot actions rather than boxes to tick, they should anyway, and left open the popup's backdrop swallowed every click after. The count and Clear appear only past **one** photo: below that the ring says everything the count would, and "1 selected" beside it is noise.

Selected state is announced on the frame's own accessible name ("selected, photo …") rather than by `aria-selected`, which a `listitem` cannot carry - and the tiles hold buttons of their own (rating, verdict), so the grid cannot be the `listbox` whose `option`s could.

Rebuilt renditions change behind a URL that does not, so the client appends a version to image URLs once a rebuild has happened in the session. The server's `ETag` covers a fresh page load; this covers an image already decoded in the current one.

### 18.3.2 One scroll over the whole collection

There are no pages. A gallery is a single scroll the length of the collection, and the client holds only what is near the viewport: a library of two hundred thousand photos scrolls as one list, in a page that mounts a few dozen tiles and caches a few thousand rows.

**Rows are held sparsely, by position.** `PhotosStore.rows` is a `Map` from a photo's index in the collection to its row, filled a **block** of 100 at a time - the same 100 one list request covers. The presenter asks for the blocks the viewport (and the photo the viewer is on) needs, and drops the least recently needed once more than 24 are held. A position whose row has been dropped, or is still in flight, keeps its cell as an empty tile rather than letting the ones after it close the gap, so nothing shifts under the reader when the block lands.

Everything is therefore expressed in absolute indices: the keyboard cursor, shift-click ranges, the viewer's prev/next. A row only knows its own id, so the store keeps one `indexById` to answer the other direction.

**Nothing measures the DOM to decide what to render.** The scroller writes width and height into the store from a `ResizeObserver` and its scroll position from its own handler, and every layout question is a computed over those, which is what keeps §18.2's rule against layout reads in hot paths. That `scrollTop` is the one read left in the grid's hot path, because no event carries the scroll position; it is taken in the handler, where the scroll has already been committed so nothing is invalidated and no layout is forced, and written straight to the store everything else reads from.

Masonry is the exception, twice, and both times because its packing is a function of the photographs' shapes rather than of a row model: a block reports the height it laid out to (below), and a tile whose band is joined to it reports where the line put it (§19.6). Both are read in a `ResizeObserver` callback, where layout is already settled, and both are per-block or per-line rather than per-tile.

**A scroll re-renders per row crossed, not per scroll event.** Which rows are on screen changes only when the viewport crosses a row boundary, so `visibleSpan` is its own `computed.struct`: comparing the *value* rather than its inputs means the sections, the tiles and the blocks to fetch are invalidated per row crossed rather than per event. What moves in between is the native scroll, not React - the mounted windows are placed against the anchor (below), which does not move on an ordinary scroll, so their transforms are unchanged for the whole run of frames between one row and the next. Chromium and Firefox both dispatch at most one scroll event per animation frame (measured), so per-event and per-frame are the same thing in practice, and the figures below hold either way.

Three honest limits on that. The span's two edges cross their boundaries at different offsets unless the viewport is an exact multiple of the row pitch, so the real figure at a normal window height is **two** renders per row rather than one. A frame that covers more than a row renders anyway: measured in grid mode on a 100k-photo library at 823px of viewport, a 480px/s scroll renders 6 times in 60 frames and a 1200px/s scroll 14 times, but a 7200px/s fling renders 54 and a 12000px/s one all 60. Masonry is far cheaper (a block pitch is 3,400px, so 0-5 renders across the same range) and list far dearer (65px rows: 14 and 37). And the scrollbar re-renders on every event by design, since drawing the position is its whole job - it is two elements, kept out of `GridScroller` precisely so the thumb moving does not take the mounted tiles with it.

So this is a slow-and-medium-scroll property; at the top of a fling it buys nothing, and what carries those frames is that the work per render is bounded by the viewport rather than by the collection.

**Grid and list are arithmetic; masonry has to be laid out.** Uniform rows need only a column count and a row height, so those two modes need no measurement and no estimate at any size. Both numbers are handed to CSS, through `--cols` and `--row-h`, rather than each side working them out: a track size the two disagreed on drifts a little on every row, and a hundred thousand photos is enough rows for a little to become a lot.

Masonry packs its lines from each photo's own shape, which is unknowable for a photo the client has never fetched. So it renders one block at a time - each block the same flex container the whole grid used to be - and each block reports the height it settled at through a `ResizeObserver`, which delivers that height in the entry rather than forcing a layout to read it. Blocks not yet laid out are estimated from the average of those that have been, and when a block above the viewport turns out taller than its estimate the difference is handed back to the scroll, so correcting a guess never slides the photos being looked at.

Two costs there, both deliberate: a masonry line breaks at every block boundary, so the right edge is ragged once every hundred photos; and a partly-visible block mounts whole, which is a few hundred tiles rather than a few dozen. The alternative is holding every photo's dimensions for the whole collection, which is the one thing this design exists to avoid.

**A browser will not scroll as far as a collection can reach**, and it truncates silently: Chromium clamps at 33,554,428px and Firefox at roughly half that, with everything past the clamp simply unreachable. That is not a millionth-photo problem - the grid at its highest zoom is one column of thousand-pixel rows, which runs out at **thirty thousand photos**, and list mode at half a million.

So the scroller is not a picture of the collection at all. It is a **rail** of `RAIL_HEIGHT` = 100,000px whatever the collection's length, and `anchorTop` says which content pixel the rail's origin is: the reader's position is `anchorTop + railTop`, exactly, with nothing scaled. A wheel notch therefore covers the same distance at photo 400,000 as at photo 4, and no browser's scroll ceiling is something the grid has to have an opinion about. A collection shorter than the rail *is* the rail, `anchorTop` is pinned at 0, and none of this machinery engages.

**The anchor is what absorbs a correction, not the scroller.** Everything the grid does to keep the reader's place - a band opening above them, a masonry block measuring taller than its estimate, the cursor jumping out of the window - moves `anchorTop`, which is store state, rather than moving the scroller, which fights whatever it is doing. Only what the anchor cannot absorb reaches `railTop`. This matters because writing `scrollTop` mid-fling cancels the fling on macOS: the rail is put back to its middle **only** when the reader comes within two viewports of one of its ends, which at an 823px viewport is 116 viewports of travel apart, and that distance is what buys the smooth scroll.

**`railTop` is the single truth for the scroller's position**, in both directions: the scroll handler samples into it, and everything that moves the reader writes it and lets the view put the element there. Nothing returns a position for a caller to remember to write, which is what made `replaceBands` - a re-read with no path back to the view at all - unable to correct anything.

Two writers put the element where `railTop` says, and both are needed. A **reaction** catches the change in the same animation frame as the anchor change it belongs with, so a correction is never visible as a jump; it runs before React has committed the rail's new height, so a position legal against the collection as it now is can still be clamped by the element as it still is. A **layout effect** after each commit finishes that job, and is the only thing that can: a `scrollTop` write the browser clamps to where the element already sits fires no scroll event, so nothing else would ever correct the store, and the grid would draw a screenful the scroller is not looking at until the reader scrolled by hand. It is also what puts a freshly mounted scroller where the store already is, for a collection that empties and refills without passing through `resetRows`. A reaction rather than an effect for the first, because `railTop` changes on every scroll event and observing it in a render would re-render the grid on every one.

The scroll position is read in the handler rather than deferred to the next frame - cheap there, because a scroll event is dispatched after the scroll is committed, so nothing is invalidated and no layout is forced. Deferred, the store sat up to a frame behind the element, and a correction landing in that window was measured from where the reader had been.

A correction is measured from the anchor as it stood **before** the thing that displaced the reader, because every caller shrinks the collection as it displaces them: read afterwards, `anchorTop` has already been clamped down by a smaller `anchorLimit` and the shift counts that clamp a second time. Note that a collection shorter than the rail has no anchor travel at all, so there every correction moves the scroller - which in a maximised 1512-wide window, whose grid is about 1275px across once the rail and the padding are taken, is a library under 2,915 photos in grid mode, or 1,538 in list. This reduces scroller-fighting rather than eliminating it.

`anchorTop` clamps the stored anchor to a collection that may have shrunk under it, but the stored value has to come down with it rather than merely being read past. Binning most of a library shortens the collection and undoing the bin lengthens it again, and a raw anchor left where it was springs the reader back to a position they were clamped out of a moment before, from an undo they expected to put things back. So the anchor settles onto its own limit whenever that limit moves.

Two costs. **Home and End** have to be handled rather than left to the scroller, which would send them to the ends of the rail - a hundred thousand pixels somewhere mid-collection - so End advanced the reader by a rail's worth and stopped. Page Up/Down are relative and need nothing. And **the scrollbar**: the native thumb now describes the rail rather than the collection, so it is hidden and the grid draws its own from `scrollProgress` and `viewportFraction` - a `role="scrollbar"` whose `aria-valuetext` names the photo the progress works out to (not `visible.from`, which is the first *mounted* index and so two overscan rows or a whole masonry block early).

It is an **overlay**, floating over the grid's right edge rather than sitting beside it in the flow. Not for looks: the scroller's width drives the column count and every row's height, so a bar that took a gutter changed the very content height that decides whether a bar is needed - which at one collection size oscillated.

The bar floats in a **24px gutter** the scroller keeps as `padding-right`, and the thumb is that whole width, so its pointer target meets WCAG 2.5.8 without reaching over anything. The gutter is the one part of this that costs the grid width, and it buys the only arrangement that is all three of: a 24px target, no tile control ever covered, and no feedback loop. A bar in the flow changed the scroller's width, and so the column count, and so the content height that decides whether a bar is needed. An overlay narrow enough to cover nothing gave a 6px target. An overlay 24px wide covered the select box and the outer two rating stars of whichever tile it floated over - and which photo that was changed silently as the reader scrolled, on a grid whose whole purpose is rating and picking. Widening on hover only moved the problem: hover cannot express "within 6px of the edge", because the widened track is what keeps itself hovered, so the 6-24px band became a dead zone that a press *dragged the scroll* from.

Only the thumb takes pointer events. The track spans the grid's full height, and events there would swallow a click, a wheel notch or a touch pan anywhere down that edge - so a press on the track scrolls nothing, which is the one remaining cost, along with a wheel notch over the thumb needing to be forwarded by hand because the bar has no scrollable ancestor of its own.

The scroller itself stays a real scroller, which is what keeps trackpad inertia, rubber-banding, Page Up/Down, find-in-page and a screen reader's own scrolling working without any of it being reimplemented. `overflow-anchor: none` on the rail, because the browser's own scroll anchoring otherwise adjusts `scrollTop` to hold a row still and fights every anchor write.

**What a screen reader is told does not depend on what is mounted.** The scroller is a labelled `list` and a tab stop of its own - it holds content no other tab stop reaches, so Page Up/Down, Home and End would otherwise have nothing to act on - and every tile carries `aria-setsize` and `aria-posinset` against the *collection*, not against the few dozen tiles in the DOM: a reader is told "photo 40,051 of 100,000" rather than "photo 4 of 30". The rail and the window between them are `presentation`, so the items stay the list's own children, and a position still waiting on its block is `aria-busy` rather than absent.

**A mutation re-reads rather than patching positions.** Binning, restoring, a move into a shoot, a verdict under a triage filter - all of them change which photo sits at which index, so they abandon the requests in flight, forget which blocks are held, and ask again for what is on screen. The rows stay up while that lands: `merge` writes the server's fields into the row object already being rendered wherever the same photo is still at the same position, which is what keeps a bin, an undo or a sync poll from blanking the grid.

The keyboard cursor is the exception to all that clearing. A filter is a narrower view of the same photographs and a cull works through them by keyboard, so switching to Rejects keeps the cursor and lets the next block clamp it into range; only opening a different collection takes it away.

**The view follows the cursor whenever the layout moves under it, not only when the cursor moves.** A zoom, a mode change and a resize all re-lay the grid out around a cursor that has not moved, and the verdict keys go on acting on it wherever it has landed, so a zoom used to leave the reader rating a photograph off screen. In masonry the store can only go as far as the cursor's *block*, since the packing is not arithmetic; inside one, the focused tile is the only thing that knows where it ended up, so it scrolls itself the last of the way.

### 18.3.3 Selection is runs of positions

The selection is not bounded by what is loaded. `SelectionRanges` holds it as sorted, non-overlapping, non-touching runs of positions - `{start, end}` pairs - so **selecting a library of two hundred thousand photos is one pair of numbers**, not two hundred thousand entries. Runs that come to touch coalesce, or a range built a photo at a time would fragment into one entry each and never recover. A scattered pick degrades to a run per photo, which is the worst case and no worse than the set of ids it replaces.

Positions rather than ids, because positions are the only thing a client holding a window of the collection has for the rest of it (§18.3.2). The value is immutable and the store holds it by reference, so a selection change is one notification rather than one per photo. Every mounted tile re-renders on it, which is affordable precisely because what is mounted is now bounded by the viewport rather than by the collection.

**Select all** is therefore offered whatever the library's size, beside **Select visible** for the narrower gesture of acting on the run currently on screen. The bulk bar says "all 1200 selected" rather than the bare count when the selection is the whole collection: at five figures the number alone does not tell you whether you got everything.

Both sit at the **left end of the bulk bar**, ahead of the count and the Clear beside it, which appear only once more than one photograph is selected. They are how a selection is *made*, so they must not move when one starts: a control that shifts under the pointer between one click and the next is the fault the always-mounted bar exists to avoid (§18.3.1), reintroduced by the bar's own contents.

"Visible" is the one question the store cannot answer, so it is the one place the grid measures. What the store knows is what is *mounted*, which is deliberately more: two overscan rows either side of the viewport, and in masonry a whole hundred-photo block, whose tiles are packed from their own shapes and have no arithmetic position to test at all. Read off the DOM on a click, "Select visible" acted on up to a hundred photographs the reader could not see. It is a click, so the forced layout costs nothing, and §18.2's rule stands everywhere it is about: nothing in a render, a reaction or a scroll frame measures anything.

**No ids are ever read back to act on it.** A bulk request carries the selection itself - the collection, the filters, the runs - and the server resolves the ids off the same filtered, collection-ordered listing the grid was built from (`PhotoTargetSchema`, §14). Beside the runs it carries `members`: photographs the reader picked out of an open stack, which a collapsed listing gives no position to number them by (§19.6.1). They are the one thing named by id going *in*, bounded like any id list, and the server takes the union of the two - a run naming a stack's row already resolves to every member of it, so nothing is acted on twice. A selection needs at least one of the two, and a members-only selection is as legitimate as a runs-only one. So binning a hundred thousand photos is one small request, and nothing is fetched to *make* a selection at all. The one path still named by id is the undo of a bin: the delete answers with what it took, because the selection it came from resolves to different photographs once those have left the collection.

#### Positions move, so the selection is rebased rather than dropped

A scan inserting rows under an open gallery renumbers everything after the insertion point, and the selection, the keyboard cursor and the shift-click anchor are all positions. Dropping them on every poll tick would mean a library could not be indexed and culled at the same time, which is exactly when a photographer is doing both.

So each re-read is diffed. The client snapshots where every row it can name sat, re-reads the blocks on screen **plus the blocks the selection covers that it still holds**, and compares: a photo that moved gives one sample, and consecutive samples that moved by the same amount collapse into one step. `rebase` then maps each selected run through those steps.

That falls out exactly right in both directions. An insertion steps the shift **up**, which splits a run so the photo that appeared inside it is not selected - three selected and one inserted after the first leaves `{1} ∪ {3,4}`, not a run of four. A removal steps it **down**, which drops the photo that went and closes the run over the gap.

**It only speaks for what it re-read.** The domain is the blocks the client both held rows for and read back; outside it, positions are dropped from the selection rather than carried by the nearest observed shift. There is no honest alternative: a selected photo sitting *below* every sample may not have moved at all, and a gap between two re-read blocks hides an unknown number of arrivals, so either guess quietly renames photographs the reader chose. Losing part of a selection is visible on screen; acting on the wrong photographs is not. A block whose request failed is not part of the domain either - its old rows are still sitting where they were, and reading them would report a move of zero that never happened.

Three things escape that rule, all because they need no samples. A selection that was the *whole* collection stays the whole collection: "everything" is the one selection whose meaning is not a position. When nothing observed moved at all - every sample at shift zero, which is what a poll finding no new photos looks like - the selection is returned untouched rather than narrowed to the domain. And a re-read with **nothing to compare** leaves it alone as well: no row this client could name going in, or no block it both held and read back, means it observed no photograph at all, which is not the same thing as finding that nothing recognisable came back. That distinction was free while a non-empty selection implied held rows; it stopped being free when the collapse became something the reader can switch off under themselves (§19.5.4), which leaves the rows cleared and the selection carried across for a round trip - and a sync poll landing in that gap wiped it.

**Re-reads are serialised.** Two of them overlap routinely, a sync poll ticking while a verdict is being set, and each would rebase against a snapshot the other had already moved - applying the same shift twice and walking the selection off its photographs by exactly the number of rows inserted.

Opening a different collection, changing the filter or changing the sort still clears it outright: those are different listings, not the same one renumbered.

### 18.3.4 The Shoots page

The page shows **the library's folders**, with the shoots among them, rather than only the shoots. An empty Shoots list beside a library full of subfolders was the catalogue lying by omission: the photos had imported, the folders were right there on disk, and nothing on screen said so or offered to do anything about it. A folder that is not a shoot is drawn greyed, and every row carries a `+` menu, so the page answers "what have I got" and "make that a shoot" in the same place.

A permanent **Library root** row sits at the top, undeletable, carrying the count of photos in no shoot. It is where the `+` menu goes for a top-level shoot, and it is the direct answer to the case that started all this - one photo at the root and one in a subfolder now reads as two rows with a count each, rather than as an empty page.

Three views, because a folder tree and a list of shoots are both legitimate readings of the same thing:

| View | Rows | Subtitle |
|---|---|---|
| **Flat** | Shoots only, unnested | the full `folder_path` |
| **Tree (simple)** | Shoots only, nested under the nearest ancestor **shoot** | the path from that ancestor, so folders skipped on the way are named there |
| **Tree (full)** | Every folder, shoots and untracked alike | the folder's own name, and only when the shoot's label differs from it |

Tree (simple) is what a photographer wants from a deep tree: a shoot buried at `2024/Q3/September/Smith` under nothing else tracked appears as one row, with `2024/Q3/September/` in its subtitle rather than as four rows of scaffolding. Tree (full) is the file manager's answer, and is mostly interesting with mirroring off, where the untracked rows are the point.

**The hierarchy is derived on the client from the shoots' `folder_path`s**, so every ancestor row is known without asking the server for anything. Only folders holding no photos are invisible that way, and those are exactly what expanding a row goes and fetches from `/api/libraries/:id/browse` - the endpoint the deleted picker already used, kept for the one job it is still needed for.

**There is a keyboard cursor**, for the reason virtualising the list created: a row scrolled out of the window is unmounted, so anything focused inside it fell to the document body and the next Tab restarted at the top of the page. The cursor is a value in the store, so it survives that, and where the scroll has to go to show it is computed from the row's index rather than from its element - which may never have been mounted, so there is nothing to call `scrollIntoView` on.

It is keyed by **folder path, not by row index**, which is where it differs from the grid's (§18.3.2). Rows here are renumbered by every expand, collapse and view change, so an index would point at a different folder afterwards; the grid keys on an index because a position is all a sparse collection has. The cursor therefore follows its folder across a view change, and simply reports no row when the folder stops being listed.

`↑`/`↓` walk the list, `→`/`←` open and close a folder (stepping out to the nearest ancestor *that is a row*, since the reading may skip the folder in between), `Home`/`End` reach the ends. A menu or a rename field that has focus keeps the arrows, which is the widget doing its job.

**The cursor moves on a pointer, never on focus.** Focus arrives at a row for reasons that are not the reader choosing it: tabbing forward after a scroll has unmounted the row they were in lands on whichever row happens to be mounted, and moving the cursor there would throw away the place they were keeping. Clicking is a choice, so that moves it.

**A row that unmounts under the focus hands it back to the list.** Removing a focused element drops focus on the document body, and the next Tab then restarts at the top of the page - which is the whole complaint virtualising the list created. The row's layout-effect cleanup is the last moment it is still in the document to be asked whether it holds the focus, so that is where the scroller takes it back. Deliberately without scrolling: yanking the list back to the cursor while the reader is scrolling away from it would be worse than what it fixes. Exactly one row is in the tab order at a time - the cursor - so while it is on screen, tabbing into the list lands on it.

**Anything that removes rows settles the cursor** onto the row that took its place, held at the index rather than reset to the top: a collapse, a delete, a sync tick. The cursor is only ever set to a folder that is actually a row, so it always has a ring, always puts a row in the tab order, and never sends the next arrow key somewhere the reader did not come from.

**The rows scroll virtually**, on the same `visibleRows` the gallery uses (§18.3.2). Mirroring is what makes that necessary: a library with a shoot per folder has as many rows here as it has folders, and every rename re-reads and re-renders the list. The rows are uniform, so this is the easy half of what the gallery does - one row height, no blocks to fetch, no masonry to measure, and short enough that it needs none of the rail the gallery scrolls over. The **Library root** row sits outside the scroller, so the thing the page is anchored on never scrolls away. `aria-posinset` and `aria-setsize` count against the whole tree rather than the few rows mounted, as they do in the grid.

The `+` menu on a row is where shoots come from:

- **Add as shoot** (untracked rows only) adopts the folder as it stands, photos and all (§8.5).
- **Create shoot in subfolder** (every row) opens the surviving dialog for a name and an ordering, and makes the folder.

Deleting a shoot asks what happens to the photographs rather than assuming, since one answer is reversible and the other is not: keep them in the library, or remove them from it. The second states plainly that the files stay on disk, that ratings and verdicts go, and how many photos it is about to be true of.

**That number comes from the server**, and the irreversible button waits for it. What `remove` takes is every row under the folder, which is not the set the page can see: a photo in a subfolder kept `plain` belongs to no shoot and is counted by nobody, and binned photos are excluded from every count on screen - yet both are deleted. A count derived on the client from `photo_count` was smaller than the truth in exactly the cases that matter.

### 18.4 Culling

Rating a shoot is the daily job, so it must not require opening each frame. The grid holds a keyboard cursor, which is the selection (§18.3.1), and binds:

| Key | Action |
|---|---|
| `← → ↑ ↓` | Move the cursor, selecting what it lands on |
| `0`–`5` | Set rating |
| `Z` | Undecided |
| `C` | Pick (again to clear) |
| `X` | Reject (again to clear) |
| `Del` | Move to Bin |
| `Space` | Add to the selection |
| `Enter` | Open the photo, or the stack's band |
| `F` | Fullscreen, in the photo view |
| `I` / `O` | The camera's JPEG / the render, in the photo view (§10.1) |
| `Esc` | Clear the selection, or leave the photo for the collection it was opened from (§18.5) |
| `?` | Shortcut overlay |

`Z`, `X` and `C` are deliberately adjacent, in that order left to right, matching the Undecided / Reject / Pick order of the control: the left hand rests on them while the right drives the arrows. Each button shows its key, so the shortcut is learned from the control rather than from a help sheet. They work in the photo view as well as the grid, because that is where a close look leads to a verdict. `X` for reject also matches the convention photographers already have from Lightroom. Both keys toggle, so the same key that sets a verdict clears it.

Rejecting is not deleting. A reject stays in the catalogue and leaves the default "Active" view (untriaged + picked), which is what makes it useful during a pass; binning is the separate, undoable action on `Del`.

### 18.5 The photo view

The metadata panels sit beside a portrait frame and beneath a landscape one, so the image always gets the axis it needs. The page is a flex column filling the viewport and the stage takes every pixel the chrome is not already using. The stage supports fit/zoom (click, the magnifier button, or the wheel), drag-to-pan while zoomed, and a fullscreen mode whose only chrome is a bar that fades in on pointer movement.

**The zoom and fullscreen controls sit in the viewer's own bar, not over the photograph.** A control drawn on the frame covers the corner it is over, which is a corner of the thing being judged. The stage still renders them, into a slot the page passes down (`toolsInto`); a stage given no slot keeps the overlay, which is what stack triage's split mode needs, since two stages side by side have no single bar to share. A portal rather than lifting the state: the readout changes on every frame of a wheel zoom, so handing it upwards would redraw the bar and the page around it at that rate, where this leaves the per-frame work inside the stage that was already doing it.

**The zoom control is three stops - fitted, twice fitted, then the frame's own pixels - and the readout is in native scale.** 100% means one image pixel per CSS pixel, not "the size it opened at": the question a cull asks of a render is whether it holds up at 1:1, and a percentage of the fitted size cannot answer it. The stops are sorted rather than listed, because a render smaller than the stage is already past 1:1 when fitted, and the ceiling is `max(8 × fitted, 1:1)` - a flat multiple of the fitted size was the ceiling before, so a 3840px render in a 430px stage topped out at 86% and 1:1 was unreachable. The fitted scale needs the viewport's size, which is observed rather than measured on demand: the readout renders on every frame of a wheel zoom, and a `getBoundingClientRect` there is a layout read in the hottest path the stage has.

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

**Both facts it needs are on the row, and neither is read off the detail.** `defaultRendition` reads `rendition_source` from the **library**, found through the row's `library_id`, rather than the `default_rendition` the server puts on the detail: the server derives that from exactly the same library setting (§13.2), so this is the same answer a round trip earlier - and it is per photo, which matters in an album spanning two libraries, where the detail on hand belongs to a photo from the other one. `preferredRendition` reads `viewer_rendition` from the row for the same reason, which is what lets "last used per photo" answer on the first frame; on the detail alone, that mode painted the library's default and swapped to the reader's own choice a moment later - the original complaint, in the one mode that still had it.

**The page is a layout and seven observers, not one.** The nav, the frame, and each panel read only what they show - the notes box holds its own draft, the triage panel reads the verdict and rating off the row, the camera panel reads the camera fields, the rendition panel is the only one that hears a frame decode. As one component they all re-rendered on anything any of them watched: a keystroke in the notes box redrew the stage, and a star redrew the camera settings.

Splitting the components is only half of it, because **`loadedDetail` is deep-observed and written into rather than replaced.** A fresh object notifies everyone reading any part of it, which is what `reconcile` already avoids for grid rows; `patch` therefore assigns the changed fields into the detail the panels are holding, minus `renditions` and `album_ids` - a patch cannot change those, but they arrive as new objects every time and would read as a change to the two components that watch them. A rating click now re-renders the triage panel and nothing else.

A "Rendition details" panel reports what is actually being displayed (its source, pixel dimensions, format, colour space and encode quality) separately from the original RAW's size and dimensions, because the two are easy to confuse and only one of them is what you are judging sharpness on.

Every metadata panel shows its two most important rows and hides the rest behind a same-size toggle, so each costs the same three lines however much a camera recorded. Download (RAW or JPEG), the rebuild actions and Bin live in the page header beside the prev/next controls, which keeps every action on the photo in one place rather than buried at the bottom of a panel column.

Landing straight on `/photos/:id` used to leave prev/next dead: the neighbours come from the loaded collection, and a deep link has none. Opening the detail with no collection loaded now opens the photo's library as well.

**The way out is the grid the reader came in by**, on the button and on `Esc` alike: a photo opened from a shoot, an album or the Bin returns there rather than to the whole library, and the button is named for where it goes. `PhotosStore.source` answers it while the tab lives - opening a photo does not change which collection is loaded - but a reload has no store to read, so the collection is in the route the viewer is nested under (§18.3) and the detail page opens it alongside the photo. A bare `/photos/:id` still inherits the library it loads behind itself.

**And it returns to the photo, not to the top.** Two things had to change for that. The grid page opens its collection on mount, which for the collection the reader never left is now a re-read in place rather than a reset: the rows, the scroll position and the open bands are all still describing the same listing, and dropping them landed a reader a thousand photos into a gallery back at its first row. Then leaving the viewer puts the keyboard cursor on the photo that was on screen, which the grid already scrolls to (`focusContentTop`) - so a reader who stepped forward a thousand frames comes back to the thousandth. Only the cursor moves: someone who selected a set and opened one of them with `Enter` has not asked for that set to be cut down to wherever they stepped to.

Destructive actions split by reversibility. Binning is undoable, so it just happens and reports with an undo toast wired to `POST /api/photos/restore`. Deleting a library, shoot or album is not undoable, so each asks first via a native `confirm()` that names the specific consequence (removing a library keeps the RAW files but destroys every rating, note, pick and membership).

### 18.6 Renditions and the sync strip

Renditions are generated asynchronously, so a tile's first request can 404 while processing is still writing the file, and nothing in the page can know when that changes. **The server says so**: `ProcessingService` announces each photo whose renditions it has just written, and `GET /api/events` streams those announcements to every connected client as `event: rendition` (`EventsApi`).

**The version is a column, and it travels on the row.** `photos.tile_built_at` and `photos.renditions_built_at` each mean "when was this file last written", which is exactly what a URL has to name; both are on `PhotoSummary`, so every view that renders a photo is already holding them. Appending it is the only thing that makes a rebuilt file visible to an `<img>` that has already decoded the old one (§13.5). Remounting the element is not an alternative: three fresh `<img>`s with the same `src` produce one network request between them, because the browser hands the later ones the copy already in its in-memory resource cache without revalidating. The URL itself has to differ.

Everything else follows from it being the server's value rather than something a client made up. It is there on the first render, so there is no plain-URL window to be stale in. It survives a reload, so revisiting a catalogue still revalidates rather than re-downloading. Two browsers agree. And the viewer's warmed neighbours are painted at the URL they were warmed at, because both readings come off the same row - which is the invariant a client-side version could not hold, since whatever held it was keyed by the view rather than by the photo.

**The announcement carries the new value**, not just the fact of a change, so learning about a rebuild costs nothing beyond the event: `PhotosPresenter.renditionsRebuilt` writes it into the row already on screen, and mobx notifies the one tile whose field moved. Nothing is re-fetched to find out what the version became.

Per photo rather than per rendition because a reprocess rewrites or drops all of them together (`dropStaleRenditions`), so a rendition-level version would be three copies of one fact.

**Stamping the row and announcing it are the same act, and both happen wherever a rendition is written.** There are three such places. The import's rendition pass, at the end of which `markDone` already stamped the row (`markProcessed`). The import's *tile* pass, which is the point of splitting the two (§10.2): the tile is on disk a second and a half before its render, and a grid already on screen should fill at that pace rather than the render's, so the tile announces itself and stamps the row to match (`tileWritten`). And `runOneOff`, which serves the viewer's on-demand build (`POST /photos/:id/renditions/:r`, including the force rebuild that deliberately rewrites a file behind an unchanged URL) and the grid tile repaired on a detail read (§13.2); that path wrote files without touching the row at all, so it stamps one too.

The stamp is what makes each of those announceable rather than merely true: a client builds its URLs out of these columns (§13.5), so telling it about a file the row does not know about yet would have the next list read walk that URL back to the copy the browser already holds.

**One stamp per stage, not one per photo.** A photo announces twice during an import of a rendering library, and the two announcements move different URLs: the tile pass moves `tile_built_at` and with it the gallery's, the rendition pass moves `renditions_built_at` and with it the viewer's. Shared, the second announcement moved the tile's URL too - and a moved URL is a different cache key rather than something to revalidate, so every tile on the page was downloaded again in full (~15KB each) for bytes that had not changed. Which stamp a URL reads is the rendition it is asking for: `grid` from the tile's, `full` and `max` from the renditions', and the camera's JPEG from `date_updated`, since that one is lifted out of the RAW per request rather than built and changes exactly when the RAW does.

**Being told is the only path.** Nothing polls behind the announcement. A tile that 404s stays blank until it is announced, rebuilt from the bulk bar, or the page is reloaded - a missed announcement therefore costs a reload, and that is the cheaper failure: the backoff this replaced (`RETRY_DELAYS_MS`, shared with the viewer) meant that a library whose tiles all 404 - one wrong path, one cleared data directory - re-requested every tile on screen for as long as the page was open, and turned a bug into a load test against the same 404.

Which puts the whole weight on the announcement being *acted* on, and the stage had one way of dropping it. A frame whose decode fails is unmounted, so the element the promotion effect reaches through a ref becomes null; the rebuilt version then arrives, the effect runs against nothing and returns, and clearing the failure remounts the element without changing any of that effect's other dependencies. Nothing asked the new bytes to decode. They were fetched - 200, in milliseconds - and the viewer sat on them for the life of the page, which is the one outcome the announcement exists to prevent. `failed` is a dependency of that effect for this reason.

The version is told rather than guessed, and that is the whole point. What it replaced was a pair of global flags: `reloadToken`, bumped on every completed list fetch, so the grid re-requested *all* of its renditions whenever anything refetched the list and re-rendered every tile to do it, at a poll a second for the length of an import, which is exactly when the grid is largest and the least of it has changed. The other was `rebuiltAt`, a session timestamp that made every *subsequent* photo in the viewer miss the browser cache once because one photo had been rebuilt.

The stream carries an `id:` per event and keeps the last few hundred in a ring buffer, so a browser reconnecting after a blip replays what it missed through `Last-Event-ID` rather than losing it. An id from a previous run of the server (one at or beyond the current counter) replays nothing rather than the whole buffer; a restart mid-import is therefore a gap in the announcements, and a reload is what closes it. A heartbeat every 20s keeps the connection from being idled out (`idleTimeout`, §index.ts), and waits on the disconnect as well as the timer, so a departed client is dropped at once rather than at the next beat.

The sync status bar renders one cell per item the run's current phase is counting through, filling as it climbs: the files while the library is scanning, then the photos queued for rendition building (§9.6). One bar for two phases rather than one per phase, because they are consecutive and only ever one is live; which one it is names itself in the label, so an import reads `scanning · 1204/50000 files` and then `processing · 32/50000 renditions`. The tallies beside it (added, moved, missing) are what the *scan* concluded, so they are shown only once it has. It stops polling as soon as the library reports idle, and while a run is in flight the row's Sync button becomes Stop (§9.10) - starting a second one is not on offer anyway, so the slot is worth more as the control that ends the first.

**The poll runs alongside the triggering request, not after it.** `POST /sync` only answers once the scan has finished, which on a library's first import is minutes of opening and hashing every file - and for the whole of it the run is already under way and the status endpoint has been reporting it. Awaiting the request first meant a freshly added library sat at "0 photos, never synced" with the button still offering a sync that was already running, and then jumped to a moving progress bar minutes later, which reads as the click having done nothing and the catalogue having refreshed itself. Until that request answers, an `idle` status report is a run the server has not started recording yet rather than the truth, so it neither paints the strip idle nor stops the poll.

A finished run also re-reads the **library list**, which is where the row's photo count and "synced 3m ago" come from; nothing else re-reads it while the settings page stays open, so a sync completed under the user's eyes would otherwise leave both saying what they said before it started.

**The poll re-reads the grid for rows, not for renditions.** It does so while the *scan* is inserting them and once more on the tick that finds the run finished - not through the processing phase, which is the long one. By then the row set is settled and each rendition announces itself, so a list request per second would answer with the rows the grid already has, filtered and counted over the whole library to say so. The exception is a view filtering on what processing changes ("No rendition"), which a refetch is still the only way to learn.

**A refetch that returns the same rows changes nothing observable.** `merge` writes the server's fields into the row objects already on screen rather than replacing them (§18.3.2); a fresh object invalidates that tile's observable, so during a sync the whole grid would re-render once a second for rows that had not moved. In the same spirit the emptiness checks test `total` before `loading`, so a populated grid short-circuits away its dependency on a flag that toggles for every block a scroll asks for.

### 18.7 Running and testing

```bash
cd web && bun install
bun run dev                       # Vite on a random port, which it prints; --port pins it
bun run test:e2e                  # Playwright; starts its own API + Vite on random ports
```

Every service picks a free port at random rather than a fixed one, so several checkouts (parallel worktrees, an agent per branch) can each run a dev server and an E2E suite without fighting over `:3000`. Each prints the port it got, and takes an override when one has to be pinned: `-p <port>` for the API, `--port <port>` for Vite. The dev server's proxy still has to be told where the API is, so a dev session either pins the API with `-p 3000` or passes the port it was given as `VITE_API_URL`.

`bun run test:e2e` builds a throwaway library under `$TMPDIR/bowerbird-e2e-<checkout hash>` from the ARW fixture and drives the real stack, so it needs LibRaw present. The path is keyed by checkout so two worktrees testing at once do not wipe each other's fixture, and stable across runs of one checkout so the copies are overwritten rather than piling up. `VITE_API_URL` points the dev server's proxy at a non-default API origin.

---

## 19. Photo Stacks

A **stack** groups photographs of one shot: a burst, or several takes of a
scene. It is one entity in the catalogue, shown as one tile, expandable to its
members. A stack is **library-wide** and transcends the shoots and albums its
members sit in, which since shoots mirror folders (§4.1) is the ordinary case
rather than an unusual one: any stack whose photos are in two folders is a stack
across two shoots.

### 19.1 Why not a perceptual hash

The obvious answer is a 64-bit perceptual hash, and it does not work. Measured
against a labelled folder of 231 frames, dHash scores the worst true pair at
0.531 while a hand-verified *different-scene* pair scores 0.641; DCT pHash is
0.406 against 0.594. Both have a **negative** margin - the different scenes
outscore the same ones - so no threshold separates them. They are not merely
weak here; they are unusable.

What a descriptor has to survive, for two frames of one scene, is a different
exposure, a shift or small rotation, people walking through, a different white
balance or colour profile, and a step closer or further back.

### 19.2 Schema

```sql
CREATE TABLE stacks (
  id            TEXT PRIMARY KEY,
  library_id    TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  origin        TEXT NOT NULL CHECK (origin IN ('auto', 'manual')),
  date_created  TEXT NOT NULL
);
```

The `origin` column is load-bearing rather than informational. Detection re-runs
over already-stacked photos so that changing the threshold re-forms stacks
(§19.4.3), and without it that pass would dissolve a manual stack whose members
are not alike - two lenses on one subject, which is the case manual stacking
exists for.

On `photos`: `stack_id`, `descriptor` (a BLOB, §19.3), and `stack_state`, which
is the three answers to "is this photo in a stack?"

| value | meaning | detection may claim it |
|---|---|---|
| `none` | never been in one | yes |
| `stacked` | currently in one | yes, if the stack is `auto` |
| `unstacked` | a human pulled it out | **never** |

`stack_state` is `stacked` exactly when `stack_id` is set. The repository writes
both together rather than a `CHECK` spanning them, because a library delete
cascades `stacks` and `photos` in an order SQLite does not define and such a
constraint would fire mid-cascade.

On `libraries`: `auto_stack`, `auto_stack_similarity` (0.78) and
`auto_stack_window_seconds` (60). Per library because one catalogue may be
burst-heavy sport where the stack is the unit of work and another a studio where
every frame is deliberate.

### 19.3 The descriptor (`native/rawshim/src/stacks.rs`)

Rust computes it, Rust compares it, and TypeScript only ever stores the blob and
hands it back. A comparison is arithmetic over a couple of thousand cells, and a
library-sized pass makes hundreds of thousands of them, so handing that across
the FFI boundary one call at a time would cost more than the work.

Two views of the frame - the whole thing, and its **central 78%** - each holding
a rank-normalized luma grid at 20x20, two grey-world chroma grids at 20x20, and
a 10x10 luma grid used only to find the alignment. 2.6 kB per photo, so ~260 MB
for a 100k library, against the terabytes of RAW such a library holds.

Three properties do the work:

- **Rank normalization** is the exposure and white-balance invariance: any
  monotonic tone curve leaves the ordering of the cells alone, so it leaves the
  descriptor alone. Cells that tie share the mean of the ranks they span, and
  cells are rounded to the precision the descriptor stores *before* being
  ranked. Both matter more than they look: a flat sky, a blown highlight and a
  neutral shadow are long runs of equal cells, and the chromaticity of a grey
  region differs cell to cell only in the last bits of a float division. Ranking
  that raw turns numerical noise into a full-scale signal, and two frames of one
  grey scene describe it completely differently.
- **Aspect is squashed, not fitted.** A crop or a second body gives one scene two
  aspect ratios, and that must not read as a difference.
- **The trimmed mean** - the best 75% of cells - is the occlusion tolerance.
  Somebody walking through changes a handful of cells completely, and a plain
  mean lets those few outvote the scene they are standing in.

Comparing two descriptors takes the best of three pairings: both whole, and each
one's whole frame against the other's crop. Cropping both sides is the same view
as cropping neither, so that pairing is skipped; trying both directions is what
makes the score symmetric, which the grouping needs. Each pairing finds the
offset that best lines the 10x10 grids up, then evaluates the real distance once
at that offset. Searching coarsely and evaluating once rather than evaluating all
25 offsets at full size is 19x faster for 0.014 of margin.

The crop is centred, and measurably has to be: anchoring it off centre moves the
true pairs by 0.001 and lifts the different-scene pairs from 0.640 to 0.751,
because more freedom to slide the window is more chance of a coincidental match.
Vertical is worse than horizontal, since frames of a landscape share sky along
the top and ground along the bottom.

The descriptor is written when a photo's **grid tile** lands, read back from the
tile rather than computed inside the render, so every photo is described from
the picture the grid actually shows however its tile was produced. Two libraries
are then comparable even when one serves the camera's JPEG and the other a
demosaiced render.

### 19.4 Detection (`stacks_service.ts`)

#### 19.4.1 When

After a sync **and the processing it queued** have both settled, and only when
that sync added or changed photos. It waits for processing rather than for the
scan because what it needs is the derived files: photos imported a moment ago
have nothing to compare yet. The added-or-changed condition is not an
optimisation - watching is on by default with a two-second debounce, so a save
starts a scoped sync, and without it a library would re-clique its whole
collection every couple of seconds while somebody worked in it.

There is no separate "scan now" control: a manual sync is already how you ask a
library to re-look at itself.

#### 19.4.2 Candidates, and the absence of a backfill

Photos whose `stack_state` is `none` or `stacked`, which are not members of a
`manual` stack, and which have a descriptor. Deliberately **no camera or lens
gate**: shooting one subject with two bodies to compare them later is a case
stacking should serve.

A photo imported before this feature has no descriptor and is never a candidate,
so an existing library stacks nothing until it imports something new. There is
no backfill pass, because the value is in what arrives next rather than in a
walk over everything that already landed - and rebuilding a library's tiles
already backfills it as a side effect, since the descriptor rides along with the
tile.

#### 19.4.3 The rule

Candidates are walked once in time order, growing one stack at a time. The next
photo joins when **both** hold: it is no more than `auto_stack_window_seconds`
after the photo before it, *not* after the stack's first photo; and it clears
`auto_stack_similarity` against **every** photo already in the stack, not merely
against its neighbour.

The clique requirement is what bounds a stack, and it removes the need for any
separate guard against chaining: a scene that drifts frame by frame reaches a
point where the newest photo no longer matches the one the stack started from,
and the stack ends there on its own. On the labelled folder the largest stack
produced is seven.

The pass rewrites every `auto` stack in the library from scratch, which is what
makes the similarity setting mean something after it changes: raise it and stacks
split, lower it and they merge. Photos leaving an auto stack during that rewrite
go back to `none` rather than `unstacked` - this is detection changing its own
mind, not a person rejecting the grouping.

Cost is `n * s` where s is the size of the stack being built, never `n^2`, and
not a function of the window at all. Measured at 23k comparisons per second per
core.

#### 19.4.4 The human boundary

Any manual edit - create, add, remove, unstack - sets the stack's `origin` to
`manual`, and detection stops managing it permanently. Remove and unstack
additionally set every affected photo to `unstacked`. Enforced in the service
rather than at the API, so a later caller cannot route around it.

### 19.5 Reading stacks

#### 19.5.1 Collapsing

Collapsing happens in SQL, so a stack costs one row of a page and one unit of
`total`, which becomes `COUNT(DISTINCT COALESCE(stack_id, id))`. One helper
builds the predicate, used by the listing, by `idsAt` and by `positionsAt` -
written twice, a position would mean one photograph to the client and another
here. That one helper is also what makes an uncollapsed listing a flag rather
than a second query path (§19.5.4).

**It is a filter, not a window function, and that is the whole of why listings
are still fast.** A window has to see every scoped row before `LIMIT` can take a
hundred of them, so it sorts the collection for every block a scroll fetches:
measured at 179ms a page on 200k photos against 0.9ms for the same listing
without stacks, and paid by every library whether or not it has a single stack.
As a filter the ordering index is walked and stops at the page, and the same
listing costs 4.2ms.

The filter has two arms:

- `photos.is_representative`, a stored flag set on every unstacked photograph and
  on one member of each stack, which answers for almost every row with an
  equality test;
- failing that, "this stack has no visible flagged member, and no visible member
  sorts before me" - which **promotes** the next survivor when the flagged one is
  hidden, by a filter, by the bin, or by being in another shoot.

So the flag is a hint rather than a truth. Stale or missing, the second arm still
returns the right row and only costs a little more. What it must never be is set
on two members of one stack, which would show that stack twice, so a partial
unique index (`photos(stack_id) WHERE stack_id IS NOT NULL AND is_representative
= 1`) makes that an error at the write rather than a duplicate tile nobody
notices.

It is maintained by `refreshRepresentative` (`stacks/representative.ts`), called
on every membership change **and on every verdict or binning of a member**. The
last two matter because the flag being a hint is not the same as it being free:
the promotion arm is a correlated subquery per row, and rejecting the member a
stack stands for is what every triage session does (§20.2), so a stack whose flag
was left behind paid for the slow arm on every read from then on.

It picks the newest member that is neither rejected nor binned, which is the
member the promotion arm would pick in an unfiltered listing, so the two agree.
Deprioritised rather than excluded: a stack whose members are all rejected still
has exactly one flagged member, and the index keeps meaning what it means. The
comparison has to be null-safe (`COALESCE(triage, '')`), because `untriaged` is
stored as NULL and `NULL = 'rejected'` is NULL, which SQLite sorts *before* 0 -
so the oldest untriaged frame would outrank the newest keeper on nothing but its
NULL.

One consequence to know rather than discover: the collapsed row sorts on its
representative's date, so rejecting the newest member moves the stack's tile back
to the second-newest's place in the grid. For a burst that is a few positions;
for a stack spanning days it is a jump, on the keypress that caused it.

The promotion arm carries the **same scope and filters as the outer query**,
which is what keeps the properties the window gave for free. An album is strict,
because a member it does not hold is not a candidate to stand for the stack. A
shoot promotes to the newest *in-shoot* member, so it never shows a tile for a
photograph that is not in it. And a filter promotes rather than making the stack
vanish.

Two costs remain, both once-per-pass rather than per-block: the `total` count is
a full scan (it always was), and `positionsAt` numbers rows without a bound
because it cannot know where its keys are, at ~158ms on 200k photos. It runs on a
refresh with bands open, not on every block.

**Selecting a stack means selecting every photograph in it**, and `idsAt` is
where that happens: a collapsed row stands for its stack, so expanding the chosen
rows to their members is one join in one place, and no client holds a member id
to do it with.

#### 19.5.2 Scope rules

- The row a scope shows is the newest **in-scope** member, so a shoot never shows
  a tile for a photograph that is not in it. That is the promotion arm's doing;
  the stored flag is library-wide and knows nothing of scope, which is why the
  arm carries the outer query's own filters.
- `stack_size` is the full membership in library and shoot views, and the
  in-album count in an album view.
- A stack with one visible member renders as an ordinary tile.

#### 19.5.3 Expansion

`GET /api/stacks/:id/photos` returns every member; `?album_id=` narrows to what
that album holds. A shoot needs no such argument - each row carries its own
`shoot_id`, which is all the client needs to dim the members that are elsewhere.

**Stepping through the viewer sees the collection uncollapsed.** The grid shows a
stack as one tile; Previous and Next visit every frame of it. Two endpoints answer
the same listing with `representativeFilter` left off, and nothing else in the
system uses them, so the collapse is untouched everywhere it matters:

| method | path | purpose |
|---|---|---|
| `POST` | `/api/photos/neighbours` | the run around one photograph, ±50 by default |
| `POST` | `/api/photos/range` | the run between two, either end optional, capped |

Both take the same scope and filters a position lookup does, and both are a
**keyset seek** off a row's own sort key rather than an offset: a position in an
uncollapsed listing is not something the client holds, and computing one is the
`ROW_NUMBER` pass §19.5.1 measures in the hundreds of milliseconds - per arrow
press. The seek is ~0.2ms for a 50-row window on 200k photographs.

Two spellings in it are load-bearing and look wrong, so they are commented where
they sit. The group predicate must be the indexed *expression* `(date_taken IS
NULL) = 0|1`, never `IS NULL` / `IS NOT NULL` on the column: only the exact
expression matches `idx_photos_*_order_taken`, and without it the leading column
is unconstrained, the row-value comparison cannot become a range constraint, and
the whole collection is scanned into a temp b-tree - 4.8ms against 0.01ms at 40k
rows. And `date_taken IS NULL` must be *absent* from each seek arm's `ORDER BY`,
where it is a constant, or the ordering stops matching the index for the same
reason.

An absent range bound means that end of the collection, so the cap is read from
the bound that exists - capped from the start instead, a range asking about the
end of a library answers with the beginning of it.

#### 19.5.4 Expand all stacks

**Expand all stacks** is a setting on the grid's control row, beside the filters
and the sort. It is not "open every band": there is no stack in the grid to open.
The *listing itself* is uncollapsed, so every frame of every stack is a row of the
collection, in one stream, and the view looks like a library that never had a
stack in it.

It is `representativeFilter` left off - the same absence the viewer's two
endpoints are (§19.5.3) - which is why an expanded listing costs less than a
collapsed one rather than more. Three other things move with it, and all three are
the same statement about what a row now is:

- `total` is `COUNT(*)` rather than `COUNT(DISTINCT COALESCE(stack_id, id))`;
- `stack_size` is 1 on every row, so no tile draws a badge, takes a disclosure
  click, or opens a band;
- `idsAt` loses the arm that expands a chosen row to its stack. Picking one frame
  of a burst out of an expanded grid and binning it must bin that frame.

The flag therefore travels with the filters, in the query string and in the
`filters` of a selection or a position lookup alike. It is part of what identifies
the listing, and a question asked without it is a question about a different one:
position 400 would mean one photograph to the client and another here (§19.5.1).

For the same reason nothing in the grid *renders* from it. The rows in hand
already say what they are, so a click on a tile reads `stack_size`, not the
setting, and the two can never disagree mid-switch. Unstack is the exception, and
it reads the setting deliberately: a single selected row is no longer a stack to
unmake, so the action is not offered.

**The switch keeps the reader's place and their selection**, which is most of the
work. Every position in the collection changes, so both are named by **key** -
`COALESCE(stack_id, id)`, exactly as an open band is (§19.6.1) - and re-resolved
through one `POST /api/photos/positions` against the listing being switched *to*.
That endpoint answers with the positions a key names rather than a position, which
is the whole of what makes one lookup enough: a stack id is one row collapsed and
every member of it expanded, so a selected stack becomes its frames going one way
and its frames become the stack coming back. A member picked out of an open band
is named by its own id instead, since uncollapsed it is a row like any other and
its siblings are not what the reader chose. A row answers under **both** keys when
both were asked for - naming a member must not subtract it from what its stack
names, and filed under one of the two the answer for a stack depended on whether a
sibling happened to land in the same `IN (…)` chunk.

Four deliberate limits:

- **Only rows this client holds** can be named, so a selection reaching further is
  dropped rather than guessed at - the same choice `rebase` makes, for the same
  reason (§18.3.3). "Everything" is exempt, being the one selection that is not
  about positions: it survives as everything.
- **The count is read before the switch**, alongside the positions, so the
  collection is already the right height when the reader's row is put back at the
  pixel it was on. Read after, the view springs there when the first block lands.
- **Masonry is block-granular, with no offset.** How far into a block the reader
  was is measured against that block's real height, and the re-list has measured
  none of them - carried over, a reader 2,500px into a block that laid out at
  3,200 lands 2,500px into one estimated at 900, two blocks past their own photos.
- **A row the other listing cannot place leaves the reader where they were**, at
  the pixel rather than at the top: the anchored stack may have been unstacked
  from under them, and `resetRows` puts the scroll to zero unless something puts
  it back.

**The flag is not set until both answers are in hand.** It is what every other
request reads too, so flipping it first meant a sync poll fetching blocks of one
listing into a grid numbered by the other; the two reads state the listing they
are about instead. Setting it, resetting the rows and putting the selection and
the scroll back are then one action, and `resetRows` inside it abandons whatever
the old listing had in flight - so there is no window in which the grid is
half-way between the two.

Staleness is checked against the **listing** - the collection, its filters, its
sort and the flag - and deliberately not against the generation counter, which a
plain re-read bumps too. A sync poll ticks once a second through an import and
renumbers nothing the answers depend on; measured against the generation, the
press was swallowed for as long as the library was indexing, with the toggle
springing back and nothing said. A read that fails, or a filter or a sort that
lands while one is out, does cost the press - and nothing else, since nothing has
been written by then.

### 19.6 The grid (`bands.ts`)

Clicking a stack tile opens a **band of fresh rows directly below the row that tile
sits in** - the tile stands for the stack, not for the one member it shows, so it
never opens that member's detail view, and a member is reached from the band. Its
band is therefore the first click's business, unlike every other tile where that is
the second's (§18.3.1); a double-click on a stack opens the band and closes it
again, which is the same tile doing the same thing twice. The tile stays where it is
and takes a dark overlay with an up chevron, which is also how the stack closes.

**A stack's tile is a disclosure, not a selection.** A plain click on it opens or
closes its band and leaves the selection exactly as it was - it did select the row
for a while, which meant that looking inside a stack threw away whatever the reader
had already chosen. Cmd-click is what selects the row, which is also how Unstack is
reached, and it leaves the band as it found it. What *does* leave the selection is
closing a band: its members go with it, since a closed stack would leave them acted
on with nothing on screen saying so, and the collapsed row that replaces them is
not the same thing as three of its frames (§19.6.1).

**The tile and its band are drawn as one shape**, joined across the gap between
them: the tile leaves its bottom edge open, the band leaves the tile's own width
out of its top edge, and two stubs carry the sides over the gap. So the band reads
as belonging to that tile rather than to the row, which is the whole question a
reader asks of it. Only **one band per row** is joined - the one immediately below
it, which is the lowest position of that row's open stacks; the rest are separated
from their tiles by another band and keep a ring of their own, where the colour is
what pairs them. Masonry is the same rule per **line**, decided where the lines are
replayed rather than in the store.

Four details, each of which was wrong first:

- The gap is a **mask over the ring** rather than a redrawn edge, so the ring keeps
  its exact geometry. Where it is cut depends on what the corner there is: a fillet
  needs a radius of room to curve into, and a corner that runs straight through
  keeps a ring's width of cap - cut at the tile's inner edge instead, the line
  stopped short of the corner and read as broken.
- The two **interior corners are filleted**, since every other corner of the shape
  is rounded and a hard notch between them read as a mistake. They are concave, so
  neither box can round them with a `border-radius` of its own: each is a quarter of
  a ring whose centre sits out in the notch, drawn as a box of radius+ring with two
  borders and the corner facing the notch fully rounded - the radius equals the box,
  so nothing straight is left over. A fillet reaches a whole radius above the band,
  which is more than the row gap, so it crosses the tile's own bottom corner and
  replaces the stub that would otherwise bridge the gap on that side.
- A gap that reaches an end of the band **squares that corner off** and has no
  fillet: the tile's own edge runs straight down into it, and against the 4px arc
  that left a nick on one side and a broken corner on the other. Both ends at once
  is the single-column case, where the top edge disappears entirely and the two
  boxes are one.
- The stubs set `box-sizing` themselves: the reset's `*` does not match
  pseudo-elements, so their two borders were added outside the width and the right
  one landed a ring's width past the tile's edge.

Where the tile is comes from arithmetic where there is a row model - a column
index, and CSS works the width out from `--cols` - and from a **measurement** in
masonry, which is the one place it cannot be computed: a line grows its tiles from
their own shapes or hands the slack to a spacer depending on what follows it, so a
tile's place on one is not arithmetic the way a column is. The joined tile reports
its own offset and width (`fusedTileBoxes`), which is at most one tile per line and
the same exception, for the same reason, as a masonry block reporting its height
(§18.3.2). Until it lands the band is drawn whole for a frame.

The members live alone in that band and never share a row with photos outside
the stack, so no tile ever changes which neighbours it sits beside: the grid
below is displaced downwards and otherwise untouched. Band rows are ordinary tile
rows at the same cell geometry, marked by their background rather than their size.

**A member is the tile the collection would have drawn**: the same size, in the same
column, so its edges line up with the rows above and below. A band's outline is at the
**cell edge on every side**, so it is exactly the display rows it covers - which keeps
the scroll's pitch uniform, and a row of members the same height as a row of the
collection.

It needs no inset of its own, because **every tile holds its photograph inside its
cell** (`TILE_PAD`), and that one piece is what makes the rest of it work:

- A **ring at the cell's edge frames the photograph instead of cropping it.** The
  selection's ring did sit on the picture, which is what made a band's ring landing
  on its outermost members look like a mistake rather than an outline.
- A band's ring can therefore be **at the cell edge**, which is where the ring of the
  tile it is joined to is: one straight line down the two of them. A band inset from
  its own outline was tried, first by taking it off the cells - which drew the same
  photograph at two sizes - and then by making the band wider than the grid, which put
  a kink in the one line the eye actually follows.
- The **gap between two photographs is the gap plus two insets** (`GRID_GAP` plus
  twice `TILE_PAD`), which is where the air between frames comes from. `GRID_GAP`
  itself stays small, because it is what separates two *rings*, and two rings a
  photograph's width apart do not read as a pair.
- A tile has **no backdrop of its own**: the photograph's is the hit overlay's,
  clipped to the inset, so what shows between two frames is the bed the grid sits on.
  On the tile it showed in the inset as a dark border round every cell.

The 3:2 therefore belongs to the photograph rather than the cell, and `gridRowHeight`
says so: a cell is the 3:2 picture plus its inset, or every frame in the collection
would carry a hairline bar.

One scroll correction covers the bands, not two. Opening or closing one above the
reader, and re-placing every band at once, are both "keep the reader's row where it
was", and how far that row moved describes all of it - including a band at or below it,
which moves it not at all.

The member fills its column and states the grid's **3:2** itself, which is what
gives it the grid's height - the ratio rather than the row, because `.grid--grid
.tile` turns the ratio off (a grid cell has the shape already) and a member sized
from the row alone would be a photograph letterboxed inside a cell of another shape.
`align-self` places it in the row rather than `stretch`, which is the default:
stretch against an aspect ratio is a corner the engines read differently, and
Firefox took neither axis as definite and laid every member out at no height at all.
That, and the capped flex line below, is why one E2E file runs in both engines
(`band_layout.spec.ts`).

**Masonry's band is not in the row model at all** - the block it sits in reports the
height it laid out to (§18.3.2) - so its inset costs its members nothing, and its
rows are **capped** instead: a band is a full-width flex
line, so two portrait frames alone on one stretched to the width of the grid and
drew the stack several times the size of the collection around it. The cap is
`BAND_LINE_CAP` times the stack's own tile, which is the size the reader is already
looking at, and it is applied to the width - the ratio carries it to the height, and
flex leaves the space it no longer wants to the right of them. A masonry line's
tiles all share one height by construction, so capping one caps the line.

**Masonry** has no row model to hang a band off, so an open stack's members break
the line themselves: the band is a full-width item on the block's own flex line.
It waits for the **end of the line its tile sits on** rather than following that
tile straight away - a band in the middle of a line cuts the line short, and the
tiles left on it grow into the space the band walked off with, which stretched a
stack opened at the start of a line across the whole grid and pushed its
neighbours below the band. Which tile ends a line is the one thing the photos'
shapes decide rather than the row arithmetic, so `masonryLineStarts` replays the
wrap from the same flex bases the container packs from; nothing is measured. A
band flushed after the block's *last* line takes the `::after` that eats that
line's free space with it, so that line is given an end of its own.

A block's height is measured rather than computed, so the scroll learns the band
is there without being told, and the scroll correction opening one usually needs
is not owed at all.

Any number of stacks may be open. Expansions are a list of `(position, member
count)` sorted by position; `rowCount` is the base rows plus each band's
`ceil(members / columns)`, and mapping a display row to a collection position is
a prefix-sum walk over that list.

An open stack's tile and its band are ringed in **the same colour**, numbered
down the collection and wrapping after three. Several stacks open on one row put
several bands beneath it in a run, and the colour is the only thing saying which
band came from which tile. **None of the three is the house blue**, which belongs
to the selection (§18.3.1): the first used to be, and since a click both selects a
stack and opens it, that ring beside a genuinely selected photo read as two photos
selected when only one was.

#### 19.6.1 Keeping bands and the scroll put

A row's identity is `COALESCE(stack_id, id)` - the key the collapsing partitions
on. That is what the store holds for an open band, and positions are derived from
it rather than stored, so ordering changes, filters and syncs move where a band
is drawn without closing it. A band closes only when its stack genuinely leaves
the collection.

On any refresh, each open band's position is re-resolved through
`POST /api/photos/positions`, which numbers rows **once** and reads every wanted
key out of that one numbering. Ten open bands must not mean ten ordered passes
over the collection, which is the lesson `idsAt` already records. A key answers
with the positions it names rather than one position: in a collapsed listing a
stack has exactly one row, and in an uncollapsed one it is every member of it
(§19.5.4), which is what lets the same lookup carry a selection between the two.

Opening a band above the viewport displaces everything below it, so the action
moves the view the band's height further down the collection and nothing appears
to move. That goes to `anchorTop` rather than moving the scroller (§18.3.2), so
nothing the reader is doing to it is interrupted; only what the anchor cannot
absorb reaches `railTop`. Every input is a number the store already holds, so the
correction is exact rather than a measurement - but it has to be taken from
*before* the band changed, because the band is also what changed the collection's
height.

That correction is owed by a **re-read** as much as by a click, and for a while it
was not paid: a refresh re-places every band and closes the ones whose stack has
left, as often as not above the reader, and it happens on a bin, a restore, a
verdict under a filter or a sync poll. It is answered the same way, off how far
the reader's own row moved rather than off any one band's height, which is the only
form that describes several bands changing at once.

**Band members have no position of their own**, in any mode: the listing is
collapsed, so the server numbers one row per stack and members are not in that
numbering at all. They are selected **by id**, in a set held beside the position
ranges. This stays inside the rule the virtual grid enforces rather than bending
it - what must never happen is an id standing in for an *unloaded* row, and a
band's members are loaded, on screen, and few.

**The two halves are one selection.** They were separate, with the bulk bar acting
on whichever was live, on the grounds that "everything in this library" and "these
three frames of this burst" are different intentions - but a stack opened out is
part of the collection being worked through, and picking a frame out of it *and* a
frame beside it is an ordinary thing to want. So a wire selection carries
`members` alongside `ranges` (§18.3.3), the count is the sum of the two, and every
action reaches both. Each photo is acted on once: a run naming a stack's row
resolves to every member of it, so the server takes the union.

A **plain** click still replaces the whole selection, in a band exactly as in the
grid; cmd-click is what adds a member to what is already chosen, and shift-click
extends the runs. An action that consumes the selection drops the members with the
positions (§18.3.1).

The bulk bar counts **entries**, where a stack counts as one, because the client
cannot know the sizes of stacks in a selection covering rows it has never held.

| action | shown when |
|---|---|
| Stack | two or more entries selected |
| Unstack | the selection is a single row that is a stack, and no members |
| Remove from stack | band members are selected, of one stack or several |

Stacking a selection that already contains stacked photos moves those photos into
the new stack; any stack left with fewer than two members is deleted, because a
stack of one is a photograph.

## 20. Stack Triage

A stack (§19) is several takes of one scene, and picking the keepers means
comparing every take against every other: N² judgements, which reads as work
rather than as photography. **Stack triage** replaces that with a run of binary
questions. Two photos, one question, until the pool is a set of photographs
nothing has beaten.

Terms, used exactly and only this way: a **round** is one pair put to the
photographer; the **pool** is the photos still in contention; **decisive** means
*A better* or *B better*, where exactly one photo leaves; a **draw** is *Both*.
**A** and **B** are the two slots on screen, never photo names.

### 20.1 The tournament

`web/src/features/photos/stack_triage.ts`, pure, and where the correctness of the
feature lives.

```ts
interface Session { alive: readonly string[]; seen: ReadonlySet<string>; stopped: boolean }
```

`seen` holds every pair already judged, keyed by the two ids sorted and joined
with `|`. **Decisive pairs go in as well**, though a decisive pair can never recur
on its own, because it makes "a pair is never offered twice" a local property of
`nextRound` rather than a consequence of removed photos never returning, and
because it makes "this photo has been judged" derivable rather than a second set
to carry.

`nextRound` is one scan: the first pair in index order over the pool, `(0,1)`,
`(0,2)`, … then `(1,2)`, whose key is not in `seen`. That is the whole rule.

| verdict | the pool |
|---|---|
| A better | B removed, A moved to the **front** |
| B better | A removed, B moved to the front |
| Both | A then B moved to the back, in that order |
| Neither | both removed |

**The winner to the front is what holds it over.** The next round is then `(0,1)`:
the winner against the first photo it has not met. When it has met everyone left,
every `(0,k)` is judged and the scan walks on to a pair that cannot contain it, so
the stand-down needs no branch. An earlier draft carried a `champion` field to
express this, with a branch, an invariant tying it to the pool, and an argument
about when a stale one is cleared; the queue order produces the identical schedule
with none of that.

The drawn pair to the back is what spreads the work: without it the same two
photos sit at the front and every later round pairs one of them with someone new.

**Neither may empty the pool.** A stack where every frame is soft has no keeper.

**What it guarantees.** Every round either removes a photo or adds a pair, both
monotone and bounded, so a session terminates and no round repeats. A session that
ends by *exhaustion* returns a keep set that is a **clique of mutual draws**: every
pair of survivors was judged, and any decisive judgement would have removed one of
them. No photo is kept without having been held up against every other kept photo.
Keep the rest forfeits that knowingly, for the rounds never asked.

N−1 rounds when every verdict is decisive, which is optimal for finding a maximum;
N(N−1)/2 when every one is a draw, and the bound is tight. The alternative, treat
draws as transitive, so `p`≈`q` and `q`≈`r` skips `p` against `r`, was rejected
because it is not true, and because it would spend the guarantee silently on every
session where Keep the rest spends it only on request.

### 20.2 What is written

Elimination is the only final verdict, so it is the only one written during the
session.

- A loser is `PATCH`ed to `triage: 'rejected'` as the verdict lands; `Neither`
  writes both.
- **A win writes nothing**: the winner can still be eliminated two rounds later.
- When the session ends, each survivor **that appears in some judged pair** is
  written `picked`. One in no pair has never been on screen, which Keep the rest
  can leave, and `Neither` can leave by emptying the pool around it; and is left
  exactly as it was, rather than claimed as a considered keeper.

Every value a session writes is `rejected`, `picked`, or the photo's triage when
the session opened. That baseline is captured once, stored, and is what every undo
restores against, so an entry records only *which* photos it wrote. It is never
re-read from the member rows, which after a reload carry the session's own
rejections.

Writes go through `PhotosPresenter.setTriage`, which returns whether the write
landed and takes `quiet` to suppress its toast for a caller that reports failures
itself. **A failure is reported, not compensated**: both directions are already
safe, where rewinding would discard every verdict after the failed round to make
up for a write that under-applied, along a path that is itself failing.

Two root-cause fixes in `PhotosPresenter` fall out of this and are not triage's
alone: writes are **serialised** through one promise chain, since `api.updatePhoto`
is a bare fetch and a verdict followed quickly by an undo could otherwise land the
restore first; and `refresh()` **coalesces** rather than queueing a full re-read per
call, which the grid already hit by holding a cull key on the Active filter.

### 20.3 History, undo, and the queue

Every action pushes `{ session (as it was before), showing, choice, changed }`.
`choice` is stored because Completed has to show it and it is otherwise only
recoverable by diffing against the following entry, which the newest one lacks.

**Rewinding to entry `i`** restores that session and slot, re-writes every id in
`changed` from `i` onward; deduplicated, so one write per photo, to a value that
does not depend on which entry named it, and **truncates the history to `i`**.
Truncating is not bookkeeping: without it the abandoned branch stays reachable, and
a later undo restores a pool with photos missing from it that no write ever
rejected. Undo is a rewind to the last entry; the queue is a rewind to any.

Ending the session belongs to the action that ended it, so the closing `picked`
writes join that entry and undo from the summary re-opens the round. A separate
entry would restore a state for which there is still no round, landing back on the
summary it was pressed from. Ids are appended when a write is **issued**, not when
it lands, or undo pressed on the summary would miss a write still in flight.

The **queue** lists **Completed** (newest first, each round's thumbnails and its
verdict; selecting one rewinds to it) and **Upcoming**, read-only. Upcoming assumes
**every remaining round draws**, which is the run the pure functions produce for
`Both` repeated, and the only assumption under which the list *only shrinks*.
Assuming the winner keeps winning would make it grow whenever the winner lost.
Capped at 20, with the overflow counted from `remainingPairs`.

`status` is computed, never assigned, for the same reason `stopped` lives inside
the session: undo restores a session and nothing else, so a `status` field would
strand the photographer on a summary for a tournament that had just resumed.

### 20.4 The two presentations

**Flip** is one `PhotoStage` holding both frames of the round under a single
`photoKey`, so zoom and pan survive the toggle, both frames at 100% over the same
detail, alternating, which is the gesture the mode exists for. That needed the
stage to hold several frames at once (§18.6): a frame per source, each owning its
own decode. A mounted-but-hidden frame gets its own compositor layer, because an
`opacity: 0` element is never rasterised and revealing one would otherwise stall
for the frame or two a raster takes to build.

A peek suppresses the verdict keys while held, and clears on release, on
`pointercancel` and on the window losing focus: Shift-then-arrow is an easy
accident that casts the exact inverse of what is on screen, and a modifier held
across a `Cmd+Tab` never delivers its keyup.

The showing slot is kept when slot A holds the same photo it just held, and reset
to A when it does not. A held-over winner sits in A, so voting while looking at B
opens the next round still on B, the challenger, the one photo of the two not yet
seen.

**Split** draws both at once, each at the **same displayed area**, in whichever of
row or column makes that area largest. With aspect `a`, area `S`, `s = √S`, and
`gap` the gutter:

- row: `s = min( max(0, W − gap) / (√aA + √aB),  H · min(√aA, √aB) )`
- column: `s = min( max(0, H − gap) / (1/√aA + 1/√aB),  W / max(√aA, √aB) )`

Each constraint is a linear upper bound on `s`, so the smaller is the maximum. The
larger `s` wins; a tie goes to the row. The clamp is *inside* the expression
because `s²` squares away a negative sign, so a box narrower than the gutter would
otherwise render two photos in a container of negative width.

Equal area rather than a common extent, which hands the two photos areas in the
ratio `aA/aB` exactly, 2.25× on a 3:2 beside a 2:3, and size is persuasive in a
tool whose job is a fair comparison. It is not even reliably the smaller picture:
where width binds it uses *more* of the screen than a common height. Aspects come
from `PhotoSummary.width`/`.height`, which are display-upright and on the list row,
so the arrangement is known before a pixel decodes; `W` and `H` are observables the
presenter writes from a `ResizeObserver`, which is the one input that cannot come
from a store already held.

Flip does **not** equalise area, and is priced as a limit: stack members are takes
of one scene and almost always share an aspect, and forcing it would mean a second
layout system inside the mode whose appeal is that both frames occupy the same
pixels.

### 20.5 The screen

Header (back, the stack's size, the queue, the flip/split switch), then the frames,
then the verdicts, deliberately apart, because a misclick here rejects a
photograph. The bottom bar carries the four verdicts, Undo, Keep the rest, and
*n left · up to k rounds*, an upper bound labelled as one.

Keys: `←` A better, `→` B better, `↓`/`Space` Both, hold `Shift` to peek, `⌘Z` or
`Backspace` undo, `V` to switch presentation, `Esc` to leave. `⌘Z` is the only
modified chord accepted; every other modifier is ignored, because `Cmd+←` is the
browser's Back and casting a verdict on the way out is not a verdict anybody made.
`Neither` stays click-only: the one key left is `↑`, directly above a verdict that
destroys nothing, which is the wrong neighbour for the one that destroys two. It
reports through the bin's report-with-an-undo pattern rather than confirming.

`V` rather than `Tab`, which an earlier draft used: swallowing `Tab` took keyboard
navigation away from the whole page, and once focus was inside it there was no way
out. A key handler that hijacks a browsing key has to be worth more than the
browsing, and a presentation toggle is not. For the same reason the handler
ignores keys from inside a popup, where `Space` on a queue row would otherwise
cast a verdict rather than select the round under it.

The verdict bar is disabled until both frames of *this* round have decoded, and
what counts as decoded is cleared per round - kept, a round returned to by undo or
through the queue would read as ready before the stage had painted anything for
it.

**Prefetch** is the first ten survivors, and it only fetches. The frames are
mounted clipped to nothing, and a clipped element is never painted and so never
decoded; drawing them at stage size instead would cost a full-resolution raster
each, and ten of those is hundreds of megabytes. The bytes are in cache when the
round asks for them, which is what the cap was asked for. It waits for the round's
own two frames to be up before starting, or it competes with them for the
connection.

The session is judged at **one rendition throughout**, resolved by the triage store
from a member's own `library_id` against `LibrariesStore` and `AppSettingsStore`.
Not `PhotosStore`: `showing`, `preferredRendition`, `defaultRendition` and
`isAlwaysBuilt` are every one of them a function of `openPhoto`, which on this
route is either the entry photo; pinning one photo's remembered choice onto every
member, or nothing, where the library lookup misses and every session silently
becomes the camera's JPEG.

The session ends on a **summary**: Kept, Rejected, and Not saved when a write
failed, with Undo and the way back. A survivor that was never compared is drawn in
Kept and marked *not compared*. It is a screen rather than a return to the viewer
because the rejects have left the gallery's default filter, so the grid would
otherwise show a stack that silently lost members.

### 20.6 Entering, leaving, surviving a reload

`DetailNav` gains **Triage stack** when the photo has `stack_id != null`, not the
grid tile's `stack_id != null && stack_size > 1`. `stack_size` is a property of a
collapsed listing row: `toDetail` and the band-member listing both hardcode it to
1, so the tile's condition would hide the button on every route that actually
reaches the viewer from a stack. A stack has two or more members by construction.

Leaving mid-session is an explicit route to the entry photo, falling back to its
library; not `navigate(-1)`, which nothing in the app uses and which strands
anyone who refreshed. Leaving a *finished* session goes to the survivor that
sorts last in the collection's order instead, so stepping on from it steps past
the whole stack rather than back through the members that also survived. That one
is asked for rather than worked out here: `POST /api/photos/range` is handed the
photographs the stack lies between, and the last row still carrying its stack id
is the answer, in the collection's own ordering. The bounds come off the viewer's
run when the session opens, since a reload has no other way to know them.

The session is stored under `bowerbird.triage.<stackId>` in `sessionStorage` with
its history, baseline, entry photo, those bounds, and failed writes. **A finished session is
stored like any other**, and that is the whole of how the summary survives: an
earlier draft cleared the key and wrote the outcome to a second one, so reloading
the summary - or simply opening the stack again - found nothing and began a fresh
tournament over its own rejects, taking them as the baseline every undo would then
restore to.

`seen` is stored as an **array**: `JSON.stringify` renders a `Set` as `{}`, which
would return every session to a blank draw history and break §20.1's guarantee
where nothing would notice. History is capped at 50 entries, since each snapshots
a whole session.

On open the stored session is **pruned, never re-derived**: an id that is no longer
a live member is dropped from the pool, and `seen` is deliberately left alone,
because a pair naming a departed photo can never be offered again and dropping it
would demote a considered keeper out of the closing write. Re-deriving the pool
would return every eliminated photo to contention having already lost.

### 20.7 Tests

`stack_triage.ts` takes the unit tests: the N−1 decisive run, the 6-round all-draw
over four, a randomised sweep asserting no repeated round and that every keep set
is a clique of mutual draws, the worked case where two drawn photos still meet the
winner, `Neither` emptying the pool, the `upcomingRounds` cap and shrinkage, and
`arrangement` by aspect number rather than by adjective, a 3:1 panorama beside a
portrait chooses the *row*, and only turns over past about 4.5:1.

`PhotoStage`'s existing behaviour was pinned by e2e before the refactor: zoom
survives a rendition change and resets on a photo change. The screen takes an e2e
of its own over a three-frame fixture stack, in its own library because a session
writes over every member it judges.

`listStackPhotos` (§19.5.3) supplies the members and
`PATCH /api/photos/:id` records the verdicts.
