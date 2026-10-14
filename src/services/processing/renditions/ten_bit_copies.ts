import { mkdir, stat, utimes } from 'node:fs/promises';
import path from 'node:path';
import { newId } from '../../../schemas/id';
import type { LibraryConfiguration } from '../../../schemas/libraries';
import { STILL_WHITE, type TenBitWhite } from '../../../schemas/ten_bit_white';
import { deleteGeneratedFile } from '../../../utils/deletions';
import { replaceFile } from '../../../utils/files';
import { getDataPath, renditionPathFor, tenBitCopyPathFor } from '../../../utils/paths';
import type { RenderTargets } from '../pipeline/render_targets';
import { RawshimCommandWorker } from '../rawshim/rawshim_command';
import { storedAsHdr, type Rendition } from './renditions';

/**
 * Firefox's copies of HDR renditions (§10.7.2): 10-bit 4:2:0 re-encodes of the stored still,
 * made the first time Firefox asks for one and kept until that still changes.
 */
export class TenBitCopies {
  private readonly writing = new Map<string, Promise<void>>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly targets: RenderTargets) {}

  /**
   * The file a reader asking for 10 bits is served: the copy coding SDR white at `white` where
   * `rendition` is stored HDR, otherwise the rendition itself, which is then 8-bit already.
   *
   * A rendition with no file on disk answers with its own path, so it 404s.
   */
  async pathFor(
    library: LibraryConfiguration,
    photoId: string,
    rendition: Rendition,
    white: TenBitWhite = STILL_WHITE,
  ): Promise<string> {
    const dataPath = getDataPath(library);
    const source = renditionPathFor(dataPath, photoId, rendition, library.rendition_hdr);
    if (!storedAsHdr(rendition, library.rendition_hdr)) return source;
    const sourceTime = await modifiedAt(source);
    if (sourceTime == null) return source;
    const copy = tenBitCopyPathFor(dataPath, photoId, rendition, white);
    const copyTime = await modifiedAt(copy);
    // Within a millisecond rather than equal: `utimes` sets milliseconds, a file system keeps more.
    if (copyTime != null && Math.abs(copyTime - sourceTime) < 1) return copy;

    const key = `${copy}@${sourceTime}`;
    let writing = this.writing.get(key);
    if (writing == null) {
      // One at a time: a reader holding an arrow key asks for both neighbours of every photo
      // passed, and each is a full-size encode in a worker of its own.
      writing = this.queue
        .then(() => this.write(dataPath, photoId, rendition, source, sourceTime, copy, white))
        .finally(() => this.writing.delete(key));
      this.queue = writing.catch(() => undefined);
      this.writing.set(key, writing);
    }
    await writing;
    return copy;
  }

  private async write(
    dataPath: string,
    photoId: string,
    rendition: Rendition,
    source: string,
    sourceTime: number,
    copy: string,
    white: TenBitWhite,
  ): Promise<void> {
    const { hdrQuantizer, preset } = this.targets.target(
      dataPath,
      photoId,
      rendition,
      true,
      'render',
    );
    const staging = `${copy}.${newId()}.tmp`;
    await mkdir(path.dirname(copy), { recursive: true });
    const worker = new RawshimCommandWorker();
    try {
      await worker.tenBitCopy({
        sourcePath: source,
        outPath: staging,
        quantizer: hdrQuantizer,
        speed: preset,
        whiteNits: white,
      });
      await replaceFile(staging, copy);
      // Its still's time, not its own: a still rebuilt while this encoded is older than this
      // write, so "copy newer than still" would keep serving the old picture. After the move, so
      // the staging file reads as fresh to the prune sweep.
      const stamp = new Date(sourceTime);
      await utimes(copy, stamp, stamp);
    } finally {
      worker.close();
      await deleteGeneratedFile(dataPath, staging).catch(() => undefined);
    }
  }
}

async function modifiedAt(file: string): Promise<number | null> {
  return (await stat(file).catch(() => null))?.mtimeMs ?? null;
}
