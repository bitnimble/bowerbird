// A Lightroom sidecar has to arrive with the photograph, through a real scan.
//
// The service that reads one is unit-tested beside it; what only this can say is that
// scan calls it at all, for the rows it just inserted, and not again afterwards - the
// wiring, which is where an import that works in isolation silently never runs.
//   docker exec bowerbird-dev bun test test/integration
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDatabase } from '../../src/db/connection';
import { AlbumsRepository } from '../../src/services/albums/albums_repository';
import { LibrariesRepository } from '../../src/services/libraries/libraries_repository';
import { PhotoEditsRepository } from '../../src/services/photo_edits/photo_edits_repository';
import { SidecarImportService } from '../../src/services/photo_edits/sidecar_import';
import { photoMetadata, photoPaths, photoProcessing, photoScan } from './helpers/photo_repositories';
import { FolderRulesRepository } from '../../src/services/shoots/folder_rules_repository';
import { ShootsRepository } from '../../src/services/shoots/shoots_repository';
import { ScanService } from '../../src/services/sync/scan/scan_service';
import { SyncLocksRepository } from '../../src/services/sync/coordination/sync_locks_repository';
import { extractMetadata } from '../../src/services/processing/analysis/metadata';

const FIXTURE = path.join(import.meta.dir, '../fixtures/DSC02981.ARW');
const LIB = 'lib000fb';

const SIDECAR = `<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
   xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
   crs:ProcessVersion="15.4" crs:Version="18.5" crs:HasSettings="True"
   crs:Exposure2012="-0.75" crs:Contrast2012="+30" crs:Clarity2012="+12"></rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;

let root: string;
let db: ReturnType<typeof createDatabase>;
let scan: ScanService;
let edits: PhotoEditsRepository;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'bb-sidecar-scan-'));
  db = createDatabase(':memory:');
  db.query('INSERT INTO libraries (id, root_path, name, ordering) VALUES (?, ?, ?, ?)').run(LIB, root, 'lib', 'taken_desc');
  const processing = photoProcessing(db);
  edits = new PhotoEditsRepository(db);
  scan = new ScanService(
    photoScan(db, processing),
    photoPaths(db),
    photoMetadata(db, processing),
    processing,
    new LibrariesRepository(db),
    new AlbumsRepository(db),
    new ShootsRepository(db),
    new FolderRulesRepository(db),
    new SyncLocksRepository(db),
    { processUnprocessed() {} },
    extractMetadata,
    new SidecarImportService(edits),
  );
  copyFileSync(FIXTURE, path.join(root, 'edited.arw'));
  writeFileSync(path.join(root, 'edited.xmp'), SIDECAR);
});

afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a scan imports the sidecar beside a photo, once', async () => {
  await scan.scanLibrary(LIB);

  const photo = db.query(`SELECT id FROM photos WHERE json_extract(recipe, '$.path') = ?`).get('edited.arw') as { id: string };
  expect(photo).not.toBeNull();

  const imported = edits.get(photo.id);
  expect(imported.doc.exposure).toBe(-0.75);
  expect(imported.doc.contrast).toBe(30);
  expect(imported.doc.clarity).toBe(12);
  // A revision, so the reader can undo an import they did not want.
  expect(imported.rev).toBeGreaterThan(0);

  // The reader's own edit, on top of what Lightroom said.
  const mine = edits.save(photo.id, { ...imported.doc, exposure: 2 }, imported.rev);

  // Second scan: the file is unchanged and the row is not new, so nothing re-reads
  // the sidecar. Were it to, this would be back at -0.75 and the reader's own work
  // would be gone - which is the whole reason the import is keyed on the insert.
  await scan.scanLibrary(LIB);
  const after = edits.get(photo.id);
  expect(after.doc.exposure).toBe(2);
  expect(after.rev).toBe(mine.rev);
});
