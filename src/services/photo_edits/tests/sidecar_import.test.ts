import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Database } from '../../../db/driver';
import { runMigrations } from '../../../db/migrate';
import { PhotoEditsRepository } from '../photo_edits_repository';
import { SidecarImportService, sidecarFor } from '../sidecar_import';

const NS = [
  'xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"',
  'xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"',
].join(' ');

function sidecar(attrs: string): string {
  return `<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" ${NS} ${attrs}></rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;
}

const EDITED = 'crs:ProcessVersion="15.4" crs:Version="18.5" crs:HasSettings="True" crs:Exposure2012="+1.25" crs:Contrast2012="+20"';

describe('SidecarImportService', () => {
  let root: string;
  let db: Database;
  let edits: PhotoEditsRepository;
  let service: SidecarImportService;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'bb-sidecar-'));
    db = new Database(':memory:');
    // The edits table has a foreign key onto photos, and the cascade is the whole
    // reason it does; without this the insert below is accepted against nothing.
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db);
    db.run("INSERT INTO libraries (id, name, root_path) VALUES ('lib', 'Library', ?)", [root]);
    edits = new PhotoEditsRepository(db);
    service = new SidecarImportService(edits);
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  const addPhoto = (id: string, filePath: string): { id: string; filePath: string } => {
    db.run(
      `INSERT INTO photos (id, library_id, recipe, width, height, date_added)
         VALUES (?, 'lib', json_object('kind', 'file', 'path', ?), 6000, 4000, '2026-01-01')`,
      [id, filePath],
    );
    return { id, filePath };
  };

  it('takes the edit beside a photo, as an undoable revision rather than a hidden state', () => {
    writeFileSync(path.join(root, 'IMG_1.xmp'), sidecar(EDITED));
    const photo = addPhoto('p1', 'IMG_1.CR3');

    expect(service.importFor(root, [photo])).toBe(1);

    const state = edits.get('p1');
    expect(state.doc.exposure).toBe(1.25);
    expect(state.doc.contrast).toBe(20);
    // An import a reader dislikes has to be reversible by the control they already
    // have, which means it is a revision and not a state nothing recorded.
    expect(state.rev).toBeGreaterThan(0);
    expect(state.canUndo).toBe(true);
  });

  it('leaves a photo alone when the sidecar names a different one', () => {
    // The trap in `docs/lightroom-xmp.md` §2: one folder, `IMG_2.CR3` and `IMG_2.JPG`,
    // one `IMG_2.xmp`. Applying it to the wrong file puts somebody else's edit on a
    // photograph, and the file usually says which it is for.
    writeFileSync(path.join(root, 'IMG_2.xmp'), sidecar(`${EDITED} photoshop:SidecarForExtension="CR3"`));
    const raw = addPhoto('raw', 'IMG_2.CR3');
    const jpeg = addPhoto('jpeg', 'IMG_2.JPG');

    expect(service.importFor(root, [raw, jpeg])).toBe(1);
    expect(edits.get('raw').doc.exposure).toBe(1.25);
    expect(edits.get('jpeg').rev).toBe(0);
  });

  it('imports nothing for a photo with no sidecar, and says nothing about it', () => {
    expect(service.importFor(root, [addPhoto('p3', 'IMG_3.CR3')])).toBe(0);
    expect(edits.get('p3').rev).toBe(0);
  });

  it('carries on past a sidecar it cannot read', () => {
    // A sync that failed because one file in three hundred thousand held malformed XML
    // would be a worse trade than the edit it dropped.
    writeFileSync(path.join(root, 'IMG_4.xmp'), '<x:xmpmeta><not closed');
    writeFileSync(path.join(root, 'IMG_5.xmp'), sidecar(EDITED));

    expect(service.importFor(root, [addPhoto('p4', 'IMG_4.CR3'), addPhoto('p5', 'IMG_5.CR3')])).toBe(1);
    expect(edits.get('p5').doc.exposure).toBe(1.25);
  });

  it('takes nothing from a sidecar that holds only a rating', () => {
    writeFileSync(path.join(root, 'IMG_6.xmp'), sidecar('xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Rating="4"'));

    expect(service.importFor(root, [addPhoto('p6', 'IMG_6.CR3')])).toBe(0);
    expect(edits.get('p6').rev).toBe(0);
  });

  it('finds a sidecar in a subfolder, where the library keeps most of them', () => {
    mkdirSync(path.join(root, '2025-04-12'));
    writeFileSync(path.join(root, '2025-04-12', 'IMG_7.xmp'), sidecar(EDITED));

    expect(service.importFor(root, [addPhoto('p7', '2025-04-12/IMG_7.CR3')])).toBe(1);
    expect(edits.get('p7').doc.exposure).toBe(1.25);
  });
});

describe('sidecarFor', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'bb-sidecar-name-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('prefers the replaced extension, which is the one Camera Raw writes', () => {
    writeFileSync(path.join(root, 'A.xmp'), '');
    writeFileSync(path.join(root, 'A.CR3.xmp'), '');
    expect(sidecarFor(path.join(root, 'A.CR3'))).toBe(path.join(root, 'A.xmp'));
  });

  it('accepts the appended form, which exiftool and several backup tools write', () => {
    writeFileSync(path.join(root, 'B.CR3.xmp'), '');
    expect(sidecarFor(path.join(root, 'B.CR3'))).toBe(path.join(root, 'B.CR3.xmp'));
  });

  it('accepts upper case, which is what a case-insensitive filesystem hands back', () => {
    writeFileSync(path.join(root, 'C.XMP'), '');
    expect(sidecarFor(path.join(root, 'C.CR3'))).toBe(path.join(root, 'C.XMP'));
  });

  it('is null where there is none, rather than a path that does not exist', () => {
    expect(sidecarFor(path.join(root, 'D.CR3'))).toBeNull();
  });
});
