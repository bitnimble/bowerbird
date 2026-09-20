import { Hono } from 'hono';
import type { Context } from 'hono';
import { existsSync } from 'node:fs';
import { AppError } from '../../errors';
import {
  BlobAppendQuerySchema,
  BlobAppendResponseSchema,
  BlobCommitRequestSchema,
  BlobHashResponseSchema,
  BlobQueueResponseSchema,
  BlobStageResponseSchema,
  BlobVerifyResponseSchema,
  EvictBlobsRequestSchema,
  EvictResultSchema,
  PushBlobsRequestSchema,
  TransferSchema,
  TransfersQuerySchema,
  TransfersSchema,
} from '../../schemas/blobs';
import type { Library } from '../../schemas/libraries';
import type { PhotoTarget } from '../../schemas/photos';
import { PathSegment, route } from '../../schemas/route';
import { containsPath, getRenditionPath, originalPathOf } from '../../utils/paths';
import type { BlobLocations } from '../../services/blobs/blob_locations';
import { renditionCurrent } from '../../services/blobs/rendition_fetch_service';
import { RENDITION_CONTENT_TYPE, isRendition, renditionVariant } from '../../services/processing/renditions/renditions';
import {
  appendToStage,
  contentHash,
  stagedSize,
  stagePath,
  stagingDir,
} from '../../services/blobs/blob_store';
import { acceptVerifiedBlob, type TransferService } from '../../services/blobs/transfer_service';
import { deleteStagedBlob } from '../../utils/deletions';
import { respond } from '../respond';
import type { PhotoMetadataRepository } from '../../services/photos/metadata/photo_metadata_repository';
import type { BasicPhoto, PhotoPathsRepository } from '../../services/photos/paths/photo_paths_repository';
import type { PhotoProcessingRepository } from '../../services/photos/renditions/photo_processing_repository';
import type { LibrariesRepository } from '../../services/libraries/libraries_repository';

// Originals moving between peers (docs/replication.md §7): the byte-serving
// half a remote peer calls, and the queue actions the UI calls. Mounted under
// /api/blobs beside the replication endpoints, and like them it is only
// reachable on the trusted network (§11.1).

export class BlobsApi {
  readonly routes: Hono;

  constructor(
    private readonly photoPaths: PhotoPathsRepository,
    private readonly photoMetadata: PhotoMetadataRepository,
    private readonly photoProcessing: PhotoProcessingRepository,
    private readonly libraries: LibrariesRepository,
    private readonly locations: BlobLocations,
    private readonly transfers: TransferService,
    /** What an original pushed here by a peer owes the pipeline (§7.8). */
    private readonly build: (photoIds: string[]) => void = () => {},
    /** §7.10: whether this device keeps RAW files for a library it replicates. */
    private readonly keepsOriginals: (libraryId: string) => boolean = () => true,
    /** A bulk selection resolved to ids, as the photo routes resolve theirs (§12.3). */
    private readonly resolve: (target: PhotoTarget) => string[] = (target) => {
      // Answering "nothing" for a selection would report an eviction that never
      // ran, which on this route reads as "those copies are gone".
      if (!('photo_ids' in target)) throw new AppError('VALIDATION_ERROR', 'this server cannot resolve a selection');
      return target.photo_ids;
    },
  ) {
    const app = new Hono();

    // What a peer calls: the bytes, their hash, a live possession check for
    // eviction, and the staged upload a push lands in.
    app.get(route(PathSegment.param('photoId'), PathSegment.original()), (c) => this.serveOriginal(c));
    // A built rendition for a peer that cannot build one (§7.9). `hdr=1` names
    // the dynamic range, because that is a per-peer choice (§3.2) and the caller
    // wants the range its own library serves.
    app.get(route(PathSegment.param('photoId'), PathSegment.rendition(), PathSegment.param('rendition')), (c) => this.serveRendition(c));
    app.get(route(PathSegment.param('photoId'), PathSegment.hash()), (c) => this.serveHash(c));
    app.get(route(PathSegment.param('photoId'), PathSegment.verify()), (c) => this.verify(c));
    app.get(route(PathSegment.param('photoId'), PathSegment.stage()), (c) => this.stageStatus(c));
    app.put(route(PathSegment.param('photoId'), PathSegment.stage()), (c) => this.receive(c));
    app.post(route(PathSegment.param('photoId'), PathSegment.commit()), (c) => this.commit(c));

    // What the UI calls (§7.3, §7.5, §7.6).
    app.post(route(PathSegment.push()), async (c) => {
      const body = PushBlobsRequestSchema.parse(await c.req.json());
      const queued = await this.transfers.pushDiff(body.library_id, body.peer_id, body.scope);
      this.transfers.kick();
      return c.json(respond(BlobQueueResponseSchema, { queued }));
    });
    app.post(route(PathSegment.pull()), async (c) => {
      const body = PushBlobsRequestSchema.parse(await c.req.json());
      this.assertKeepsOriginals(this.library(body.library_id));
      const queued = await this.transfers.pullDiff(body.library_id, body.peer_id, body.scope);
      this.transfers.kick();
      return c.json(respond(BlobQueueResponseSchema, { queued }));
    });
    app.get(route(PathSegment.transfers()), (c) => {
      const { library_id } = TransfersQuerySchema.parse(c.req.query());
      return c.json(respond(TransfersSchema, this.transfers.list(library_id)));
    });
    app.post(route(PathSegment.transfers(), PathSegment.param('id'), PathSegment.pause()), (c) => {
      this.transfers.pause(c.req.param('id'));
      return c.body(null, 204);
    });
    app.post(route(PathSegment.transfers(), PathSegment.param('id'), PathSegment.resume()), (c) => {
      this.transfers.resume(c.req.param('id'));
      return c.body(null, 204);
    });
    app.post(route(PathSegment.transfers(), PathSegment.param('id'), PathSegment.cancel()), async (c) => {
      await this.transfers.cancel(c.req.param('id'));
      return c.body(null, 204);
    });
    app.post(route(PathSegment.param('photoId'), PathSegment.fetch()), (c) => {
      const transfer = this.transfers.fetchOriginal(c.req.param('photoId') ?? '');
      return transfer == null ? c.body(null, 204) : c.json(respond(TransferSchema, transfer));
    });
    app.post(route(PathSegment.evict()), async (c) => {
      const body = EvictBlobsRequestSchema.parse(await c.req.json());
      return c.json(respond(EvictResultSchema, await this.transfers.evict(this.resolve(body.target), body.peer_id)));
    });

    this.routes = app;
  }

  private async serveOriginal(c: Context): Promise<Response> {
    const { photo, library } = this.locate(c);
    const abs = this.originalPath(library, photo);
    const file = Bun.file(abs);
    if (!(await file.exists())) throw new AppError('NOT_FOUND', `original not on disk: ${photo.id}`);
    const size = file.size;
    const offset = rangeOffset(c.req.header('range'));
    if (offset > size) throw new AppError('VALIDATION_ERROR', `range starts at ${offset} of a ${size}-byte file`);
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(size - offset),
      'Accept-Ranges': 'bytes',
      ...(offset > 0 ? { 'Content-Range': `bytes ${offset}-${size - 1}/${size}` } : {}),
    };
    const status = offset > 0 ? 206 : 200;
    if (this.photoMetadata.contentHashOf(photo.id) != null) {
      return new Response(offset > 0 ? file.slice(offset) : file, { status, headers });
    }
    // The photo's first transfer: hashed while streaming, off the read this
    // response is already paying for, and recorded when the last byte has gone
    // (§7.1). A resumed first transfer still reads from zero, so the hash always
    // covers the whole file.
    return new Response(this.hashingBody(file, offset, photo, library), { status, headers });
  }

  private hashingBody(file: ReturnType<typeof Bun.file>, offset: number, photo: BasicPhoto, library: Library): ReadableStream<Uint8Array> {
    const hasher = new Bun.CryptoHasher('sha256');
    const reader = file.stream().getReader();
    const { photoMetadata, locations } = this;
    let position = 0;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          photoMetadata.setContentHash(photo.id, hasher.digest('hex'));
          locations.record(library.id, photo.id);
          controller.close();
          return;
        }
        hasher.update(value);
        const from = Math.max(offset - position, 0);
        position += value.byteLength;
        if (from < value.byteLength) controller.enqueue(from === 0 ? value : value.subarray(from));
      },
      cancel(reason) {
        void reader.cancel(reason);
      },
    });
  }

  private async serveRendition(c: Context): Promise<Response> {
    const { photo, library } = this.locate(c);
    const kind = c.req.param('rendition') ?? '';
    if (!isRendition(kind)) throw new AppError('NOT_FOUND', `unknown rendition: ${kind}`);
    const hdr = c.req.query('hdr') === '1';
    const abs = getRenditionPath(library, photo.id, kind, hdr);
    const stamps = this.photoProcessing.renditionStamps(photo.id, renditionVariant(kind, hdr));
    const builtFrom = stamps?.built_from ?? null;
    const file = Bun.file(abs);
    // A copy the edits have moved past is refused, not served: the caller cannot
    // rebuild, so handing it over would propagate the stale picture as current.
    if (!(await file.exists()) || !renditionCurrent(builtFrom, stamps?.edited_from ?? null)) {
      throw new AppError('NOT_FOUND', `no current ${kind} rendition here for ${photo.id}`);
    }
    const size = file.size;
    const offset = rangeOffset(c.req.header('range'));
    if (offset > size) throw new AppError('VALIDATION_ERROR', `range starts at ${offset} of a ${size}-byte file`);
    const headers: Record<string, string> = {
      'Content-Type': RENDITION_CONTENT_TYPE,
      'Content-Length': String(size - offset),
      'Accept-Ranges': 'bytes',
      // Always over the whole file, whatever the range: it is what the caller
      // verifies its assembled copy against.
      'X-Content-Hash': await contentHash(abs),
      // What it was rendered from, so the caller can hold it against an edit this
      // device has not been told about yet.
      ...(builtFrom == null ? {} : { 'X-Rendition-Built-From': builtFrom }),
      ...(offset > 0 ? { 'Content-Range': `bytes ${offset}-${size - 1}/${size}` } : {}),
    };
    return new Response(offset > 0 ? file.slice(offset) : file, { status: offset > 0 ? 206 : 200, headers });
  }

  private async serveHash(c: Context): Promise<Response> {
    const { photo, library } = this.locate(c);
    const recorded = this.photoMetadata.contentHashOf(photo.id);
    if (recorded != null) return c.json(respond(BlobHashResponseSchema, { content_hash: recorded }));
    // A first transfer that crashed between the stream and the store lands here:
    // the receiver holds the bytes and asks what they should hash to.
    const abs = this.originalPath(library, photo);
    if (!existsSync(abs) || this.transfers.isUnsettled(library.id, photo.id)) {
      // Unsettled means what is at the row's path may be somebody else's file, and
      // what this writes is the hash every peer will hold this photograph to -
      // stamped into the imported unit and replicated. Hashed from an occupant it
      // is wrong everywhere, permanently, and every later push of the real original
      // is refused for not matching it.
      throw new AppError('NOT_FOUND', `no settled original on disk: ${photo.id}`);
    }
    const computed = await contentHash(abs);
    this.photoMetadata.setContentHash(photo.id, computed);
    this.locations.record(library.id, photo.id);
    return c.json(respond(BlobHashResponseSchema, { content_hash: computed }));
  }

  // The live possession check eviction requires (§7.6): existence plus the bytes
  // hashed *now*. The caller compares against its recorded hash; answering with
  // this peer's opinion of itself would let a rotted copy vouch for itself.
  private async verify(c: Context): Promise<Response> {
    const { photo, library } = this.locate(c);
    const abs = this.originalPath(library, photo);
    // A copy this device is in the middle of removing is one it does not hold. The
    // file is still there, so answering off the filesystem alone tells the asker to
    // go ahead and delete theirs - and the two of them each keeping it "on the
    // other" is how the last two copies go together (§7.6).
    if (this.transfers.isEvicting(library.id, photo.id) || !existsSync(abs)) {
      return c.json(respond(BlobVerifyResponseSchema, { held: false }));
    }
    return c.json(respond(BlobVerifyResponseSchema, { held: true, content_hash: await contentHash(abs) }));
  }

  private stageStatus(c: Context): Response {
    const { photo, library } = this.locate(c);
    return c.json(
      respond(BlobStageResponseSchema, {
        staged: stagedSize(stagePath(library, photo.id)),
        held: existsSync(this.originalPath(library, photo)),
      }),
    );
  }

  /**
   * Where an arriving original is allowed to land at all (§7.10).
   *
   * Both halves of a transfer go through this rather than each checking for
   * itself: staging and committing are separated by however long the sender
   * takes, and a stage file outlives the setting being turned off in between -
   * after which a commit alone, with no bytes to send, would land the original on
   * a device configured not to keep one.
   */
  private acceptingOriginals(c: Context): { photo: BasicPhoto; library: Library } {
    const located = this.locate(c);
    if (located.library.read_only) throw new AppError('READ_ONLY', `library ${located.library.name} is read-only`);
    this.assertKeepsOriginals(located.library);
    return located;
  }

  private async receive(c: Context): Promise<Response> {
    // Before a single byte is staged rather than after the transfer. The sending
    // peer greys the action out from what the handshake told it, but that answer
    // is minutes old and is not what makes this true.
    const { photo, library } = this.acceptingOriginals(c);
    const { offset } = BlobAppendQuerySchema.parse(c.req.query());
    const body = c.req.raw.body;
    if (body == null) throw new AppError('VALIDATION_ERROR', 'no bytes in the request');
    const staged = await appendToStage(stagePath(library, photo.id), offset, body);
    return c.json(respond(BlobAppendResponseSchema, { staged }));
  }

  private async commit(c: Context): Promise<Response> {
    const { photo, library } = this.acceptingOriginals(c);
    const { content_hash } = BlobCommitRequestSchema.parse(await c.req.json());
    const stage = stagePath(library, photo.id);
    if (!existsSync(stage)) throw new AppError('VALIDATION_ERROR', `nothing staged for ${photo.id}`);

    const recorded = this.photoMetadata.contentHashOf(photo.id);
    const computed = await contentHash(stage);
    if (computed !== content_hash || (recorded != null && computed !== recorded)) {
      await deleteStagedBlob(stagingDir(library), stage);
      throw new AppError('VALIDATION_ERROR', `discarded staged ${photo.id}: bytes hash ${computed}, expected ${recorded ?? content_hash}`);
    }
    await acceptVerifiedBlob(this.photoPaths, this.photoMetadata, this.locations, library, photo.id, stage, this.build);
    return c.body(null, 204);
  }

  private assertKeepsOriginals(library: Library): void {
    if (this.keepsOriginals(library.id)) return;
    throw new AppError(
      'CONFLICT',
      `this device is set not to keep the RAW files of "${library.name}". Turn on "Sync RAWs to this device" ` +
        'under the library\'s synced devices to accept them.',
    );
  }

  // The staged path and the target are derived from the row, never from the URL:
  // a photo id is only trusted once it has resolved to a catalogue row (§11.2).
  private locate(c: Context): { photo: BasicPhoto; library: Library } {
    const photoId = c.req.param('photoId');
    if (photoId == null) throw new AppError('NOT_FOUND', 'photo not found');
    const photo = this.photoPaths.getBasicById(photoId);
    if (photo == null) throw new AppError('NOT_FOUND', `photo not found: ${photoId}`);
    const library = this.libraries.getById(photo.library_id);
    if (library == null) throw new AppError('NOT_FOUND', `library not found: ${photo.library_id}`);
    return { photo, library };
  }

  private library(libraryId: string): Library {
    const library = this.libraries.getById(libraryId);
    if (library == null) throw new AppError('NOT_FOUND', `library not found: ${libraryId}`);
    return library;
  }

  private originalPath(library: Library, photo: BasicPhoto): string {
    const abs = originalPathOf(library, photo);
    // A peer asking for the original of a row that has none: what composes it is catalogue, and
    // travels as catalogue. Refused rather than answered with the path it would have had.
    if (abs == null) {
      throw new AppError('VALIDATION_ERROR', `${photo.id} is composed rather than imported, so it has no original`);
    }
    // A replicated path joined onto the root and read from disk (§11.2).
    if (!containsPath(library.root_path, abs)) {
      throw new AppError('VALIDATION_ERROR', `file path escapes the library root: ${photo.id}`);
    }
    return abs;
  }
}

// `bytes=N-` only: a peer resumes from its staged size and never asks for less.
function rangeOffset(header: string | undefined): number {
  if (header == null) return 0;
  const match = /^bytes=(\d+)-$/.exec(header);
  if (match == null) throw new AppError('VALIDATION_ERROR', `unsupported range: ${header}`);
  return Number(match[1]);
}
