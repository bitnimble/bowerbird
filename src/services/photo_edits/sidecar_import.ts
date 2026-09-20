import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Logger } from '../../logger';
import { parseXmp } from '../processing/xmp/xmp';
import { editsFromXmp } from './from_xmp';
import type { PhotoEditsRepository } from './photo_edits_repository';

const log = new Logger('sidecar');

/** A photo this sync added, as much of it as finding its sidecar needs. */
export interface ImportTarget {
  id: string;
  /** Library-relative, as `photos.file_path` holds it. */
  filePath: string;
}

/**
 * Lightroom's develop settings, taken at import.
 *
 * **No UI and no endpoint: a sidecar beside a photo is part of what the photo *is*.**
 * A reader who has spent years editing a library in Lightroom and points this at the
 * same folder should see their photographs, not the neutral renderings of them, and
 * asking them to press a button per photo is asking them to know we had the file all
 * along.
 *
 * So this runs once, on the sync that first inserts a row, and never again. That is
 * the whole of the idempotency argument: a re-sync does not re-read the file, because
 * the second read could only overwrite edits the reader has since made here. It also
 * means a sidecar that *changes* in Lightroom afterwards is not picked up - deliberate
 * for now, and the honest place to put a choice about whose edit wins, when there is
 * something to choose between.
 *
 * Recorded as an ordinary edit rather than a special state: it lands through the same
 * `save` a slider release does, at revision 0, so it has a history entry and the first
 * thing a reader can do with an import they dislike is undo it.
 */
export class SidecarImportService {
  constructor(private readonly edits: PhotoEditsRepository) {}

  /**
   * Imports for each photo that has a sidecar. Returns how many took.
   *
   * Never throws. A sync that failed because one file in three hundred thousand held
   * malformed XML would be a worse trade than the edit it dropped, and the sidecar
   * stays on disk either way.
   */
  importFor(rootPath: string, photos: readonly ImportTarget[]): number {
    let taken = 0;
    for (const photo of photos) {
      try {
        if (this.importOne(rootPath, photo)) taken++;
      } catch (err) {
        log.warn('could not import a sidecar', { photo: photo.id, file: photo.filePath, err });
      }
    }
    return taken;
  }

  private importOne(rootPath: string, photo: ImportTarget): boolean {
    const sidecar = sidecarFor(path.join(rootPath, photo.filePath));
    if (sidecar == null) return false;

    const settings = parseXmp(readFileSync(sidecar, 'utf8'));
    if (settings == null) {
      log.warn('a sidecar is not readable XMP', { photo: photo.id, sidecar });
      return false;
    }

    // The trap `docs/lightroom-xmp.md` §2 records: `IMG_1234.CR3` and `IMG_1234.JPG`
    // in one folder both point at `IMG_1234.xmp`, and applying it to the wrong one
    // puts somebody else's edit on a photograph. The file usually says which it is
    // for, and where it does that answer beats the base name that found it.
    const stated = settings.metadata.sidecarForExtension;
    const actual = path.extname(photo.filePath).replace(/^\./, '');
    if (stated != null && stated !== '' && stated.toLowerCase() !== actual.toLowerCase()) {
      log.info('a sidecar names a different file, so it was left alone', {
        photo: photo.id,
        sidecar,
        statedFor: stated,
      });
      return false;
    }

    const imported = editsFromXmp(settings);
    if (imported.doc == null) {
      // Not a failure. Most of these are a sidecar holding a rating and no develop
      // settings at all, which is the common case in a library that rates before it
      // edits.
      log.debug('a sidecar carried no edit to import', { photo: photo.id, reasons: imported.reasons });
      return false;
    }

    // Revision 0: this photo was inserted moments ago and has no edits, which is also
    // why a re-sync cannot reach here - `importFor` is only handed rows this sync
    // created. A stale revision would throw, and that is the right outcome rather than
    // a silent overwrite.
    this.edits.save(photo.id, imported.doc, 0);
    if (imported.reasons.length > 0 || imported.unsupported.length > 0) {
      log.info('imported a sidecar with parts left behind', {
        photo: photo.id,
        reasons: imported.reasons,
        unsupported: imported.unsupported,
      });
    }
    return true;
  }
}

/**
 * The sidecar for a photo, or null.
 *
 * Camera Raw *replaces* the extension - `IMG_1234.CR3` becomes `IMG_1234.xmp` - and
 * that form is checked first because it is the one Lightroom writes. The appended form
 * is checked after it because exiftool and several backup tools write that instead, and
 * a library that has been through one of them would otherwise import nothing.
 *
 * Upper case as well, for a library that has been near a case-insensitive filesystem:
 * the same folder read on Linux shows `IMG_1234.XMP` where macOS showed `.xmp`, and a
 * miss there looks exactly like a photo nobody edited.
 */
export function sidecarFor(absolutePath: string): string | null {
  const withoutExtension = absolutePath.slice(0, absolutePath.length - path.extname(absolutePath).length);
  for (const candidate of [
    `${withoutExtension}.xmp`,
    `${withoutExtension}.XMP`,
    `${absolutePath}.xmp`,
    `${absolutePath}.XMP`,
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
