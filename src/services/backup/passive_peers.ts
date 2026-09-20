import { existsSync } from 'node:fs';
import { link } from 'node:fs/promises';
import path from 'node:path';
import type { Database } from '../../db/driver';
import { AppError } from '../../errors';
import { BlobCommitRequestSchema } from '../../schemas/blobs';
import type { Library } from '../../schemas/libraries';
import { soleInputOf } from '../../schemas/recipes';
import { PathSegment } from '../../schemas/route';
import { deleteStagedBlob, unlinkMovedFile } from '../../utils/deletions';
import { ensureDir } from '../../utils/files';
import { contentHash } from '../../utils/hash';
import { originalPathOf } from '../../utils/paths';
import { appendToStage, occupant, stagedSize } from '../blobs/blob_store';
import type { PeerTransport } from '../blobs/peer';
import type { LibrariesRepository } from '../libraries/libraries_repository';
import type { PhotoMetadataRepository } from '../photos/metadata/photo_metadata_repository';
import type { BasicPhoto, PhotoPathsRepository } from '../photos/paths/photo_paths_repository';
import type { BackupLocations } from './backup_locations';
import { assertMirrorOf, backupPath, backupStagePath, backupStagingDir, mirrorReady } from './backup_root';

// A directory answering for itself as a peer (docs/replication.md §14.2).
//
// The transfer queue moves originals by asking a peer for staged bytes, sending it chunks and
// telling it to commit; a folder on a drive cannot be asked anything, so this answers on its
// behalf, against the mount. That is what makes one queue, one hash check and one materialisation
// serve both kinds of peer - the alternative was a second copy of the transfer loop that would be
// free to verify a little less carefully than the first.

export interface PassivePeer {
  libraryId: string;
  peerId: string;
  name: string;
  root: string;
}

export function passivePeerOf(db: Database, peerId: string): PassivePeer | null {
  const row = db
    .query("SELECT library_id, peer_id, name, address FROM replication_peers WHERE peer_id = ? AND kind = 'passive'")
    .get(peerId) as { library_id: string; peer_id: string; name: string; address: string | null } | null;
  if (row?.address == null) return null;
  return { libraryId: row.library_id, peerId: row.peer_id, name: row.name, root: row.address };
}

export function passivePeersOf(db: Database, libraryId: string): PassivePeer[] {
  return (
    db
      .query(
        `SELECT library_id, peer_id, name, address FROM replication_peers
          WHERE library_id = ? AND kind = 'passive' AND address IS NOT NULL ORDER BY paired_at`,
      )
      .all(libraryId) as { library_id: string; peer_id: string; name: string; address: string }[]
  ).map((row) => ({ libraryId: row.library_id, peerId: row.peer_id, name: row.name, root: row.address }));
}

export class PassivePeers implements PeerTransport {
  constructor(
    private readonly db: Database,
    private readonly libraries: LibrariesRepository,
    private readonly photoPaths: PhotoPathsRepository,
    private readonly photoMetadata: PhotoMetadataRepository,
    private readonly backups: BackupLocations,
  ) {}

  /** Whether this peer is one of ours at all, which is what the composite transport dispatches on. */
  handles(peerId: string): boolean {
    return passivePeerOf(this.db, peerId) != null;
  }

  // Mounted, and holding this library's marker. A drive that is not plugged in and a mount point
  // that resolves to an empty directory are the same answer here, and both are "not now" rather
  // than "never": the queue leaves the transfer where it is and the next pass asks again.
  canReach(peerId: string): boolean {
    const peer = passivePeerOf(this.db, peerId);
    return peer != null && mirrorReady(peer.root, peer.libraryId);
  }

  async request(peerId: string, target: string, init?: RequestInit): Promise<Response> {
    const peer = passivePeerOf(this.db, peerId);
    if (peer == null) throw new AppError('NOT_FOUND', `no backup folder is paired as ${peerId}`);
    const library = this.library(peer.libraryId);
    assertMirrorOf(peer.root, library.id, library.name);

    const url = new URL(target, 'http://backup');
    const [photoId, action] = url.pathname.split('/').filter((part) => part !== '');
    if (photoId == null || action == null) throw new AppError('INTERNAL_ERROR', `a backup cannot answer ${target}`);
    const photo = this.photo(photoId);
    // A folder mirrors one library's tree, and what is written into it is a path out of a
    // catalogue row. Another library's row would resolve against this one's mirror and put a file
    // where a photograph of this library belongs.
    if (photo.library_id !== peer.libraryId) {
      throw new AppError('VALIDATION_ERROR', `${photoId} is not in the library "${library.name}" is the backup of`);
    }
    const relPath = soleInputOf(photo.recipe);
    if (relPath == null) {
      throw new AppError('VALIDATION_ERROR', `${photoId} is composed rather than imported, so it has no original`);
    }

    switch (action) {
      case PathSegment.stage():
        return init?.method === 'PUT' ?
            await this.receive(peer, photoId, Number(url.searchParams.get('offset') ?? 0), init)
          : await this.stageStatus(peer, library, photo, relPath);
      case PathSegment.commit():
        return await this.commit(peer, photo, relPath, init);
      case PathSegment.original():
        return this.serve(peer, photoId, init);
      case PathSegment.hash():
        return await this.hash(peer, photoId);
      default:
        throw new AppError('INTERNAL_ERROR', `a backup cannot answer ${target}`);
    }
  }

  /**
   * What the mount already has of this photograph: staged bytes to resume from, and whether the
   * copy is there and current.
   *
   * "Current" is the bytes hashed, not the path being occupied. A mirror is a tree somebody can
   * copy into by hand, and answering yes off a filename alone would record a backup of whatever
   * happened to be sitting there - which the cull later reads as permission to delete the only
   * other copy.
   */
  private async stageStatus(peer: PassivePeer, library: Library, photo: BasicPhoto, relPath: string): Promise<Response> {
    const staged = stagedSize(backupStagePath(peer.root, photo.id));
    const copy = backupPath(peer.root, relPath);
    if (!existsSync(copy)) return Response.json({ staged, held: false });
    const found = await contentHash(copy);
    // The photograph's hash exists from the moment bytes first move (§7.1), and a copy somebody put
    // on the drive by hand is not that moment: it says what is on the mount, not what the
    // photograph is. So a library that has never transferred this one reads its own file to find
    // out, and the two have to agree before the copy counts.
    const recorded = this.photoMetadata.contentHashOf(photo.id) ?? (await this.hereIs(library, photo));
    if (found !== recorded) return Response.json({ staged, held: false });
    // Recorded here rather than left to the caller: the queue's "already held" arm ends the
    // transfer without a commit, so this is the only moment anything knows the mount holds it, and
    // without the row the next pass would send it all over again, for ever.
    this.backups.record(peer.libraryId, peer.peerId, photo.id, relPath, found, Bun.file(copy).size);
    return Response.json({ staged, held: true });
  }

  /** This device's own copy, hashed, and kept as the photograph's hash once it is. */
  private async hereIs(library: Library, photo: BasicPhoto): Promise<string | null> {
    const abs = originalPathOf(library, photo);
    if (abs == null || !existsSync(abs)) return null;
    const here = await contentHash(abs);
    this.photoMetadata.setContentHash(photo.id, here);
    return here;
  }

  private async receive(peer: PassivePeer, photoId: string, offset: number, init: RequestInit): Promise<Response> {
    if (init.body == null) throw new AppError('VALIDATION_ERROR', 'no bytes in the request');
    const body = init.body instanceof ReadableStream ? init.body : new Response(init.body).body;
    if (body == null) throw new AppError('VALIDATION_ERROR', 'no bytes in the request');
    const staged = await appendToStage(backupStagePath(peer.root, photoId), offset, body);
    return Response.json({ staged });
  }

  /**
   * The staged bytes becoming the backup's copy: hashed where they now sit, then linked into the
   * mirror at the photograph's path.
   *
   * Never over an occupied name, for the reason §7.7 gives: a backup that overwrites is a backup
   * that can lose a file to a bug in the thing it is protecting the files from.
   */
  private async commit(peer: PassivePeer, photo: BasicPhoto, relPath: string, init?: RequestInit): Promise<Response> {
    const asked = BlobCommitRequestSchema.parse(await new Response(init?.body ?? '{}').json());
    const stage = backupStagePath(peer.root, photo.id);
    if (!existsSync(stage)) throw new AppError('VALIDATION_ERROR', `nothing staged for ${photo.id}`);
    const found = await contentHash(stage);
    if (found !== asked.content_hash) {
      await deleteStagedBlob(backupStagingDir(peer.root), stage);
      throw new AppError('VALIDATION_ERROR', `the copy on the backup hashes ${found}, not ${asked.content_hash}`);
    }
    const copy = backupPath(peer.root, relPath);
    await ensureDir(path.dirname(copy));
    const taken = occupant(path.dirname(copy), path.basename(copy));
    if (taken != null) {
      throw new AppError('CONFLICT', `${taken} is already at ${relPath} on the backup, and is not this photo`);
    }
    const size = Bun.file(stage).size;
    // Claiming the name is the move, as everywhere else these files are placed: staging is under
    // the mirror's own root, so this is one filesystem and `link` cannot overwrite.
    try {
      await link(stage, copy);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new AppError('CONFLICT', `something is already at ${relPath} on the backup`);
      }
      throw new AppError('IO_ERROR', `failed to place ${relPath} on the backup: ${(err as Error).message}`);
    }
    await unlinkMovedFile(stage, copy);
    this.backups.record(peer.libraryId, peer.peerId, photo.id, relPath, found, size);
    return new Response(null, { status: 204 });
  }

  /**
   * The copy, read from where it actually sits.
   *
   * Off the recorded path rather than the photograph's current one: a rename made while the drive
   * was unplugged leaves them disagreeing until a pass replays the move, and this is the read a
   * fetch of an offloaded original goes through.
   */
  private serve(peer: PassivePeer, photoId: string, init?: RequestInit): Response {
    const entry = this.backups.entry(peer.libraryId, peer.peerId, photoId);
    if (entry == null) throw new AppError('NOT_FOUND', `the backup does not hold ${photoId}`);
    const copy = backupPath(peer.root, entry.rel_path);
    if (!existsSync(copy)) throw new AppError('NOT_FOUND', `the backup's copy of ${photoId} has gone`);
    const file = Bun.file(copy);
    const offset = rangeOffset(new Headers(init?.headers).get('range'));
    const size = file.size;
    if (offset > size) throw new AppError('VALIDATION_ERROR', `range starts at ${offset} of a ${size}-byte file`);
    return new Response(offset > 0 ? file.slice(offset) : file, {
      status: offset > 0 ? 206 : 200,
      headers: { 'Content-Length': String(size - offset) },
    });
  }

  private async hash(peer: PassivePeer, photoId: string): Promise<Response> {
    const entry = this.backups.entry(peer.libraryId, peer.peerId, photoId);
    if (entry == null) throw new AppError('NOT_FOUND', `the backup does not hold ${photoId}`);
    // Read back rather than answered out of the row: what this is for is a download the caller is
    // about to accept as an original, and a row cannot notice a copy that has rotted.
    return Response.json({ content_hash: await contentHash(backupPath(peer.root, entry.rel_path)) });
  }

  private photo(photoId: string): BasicPhoto {
    const photo = this.photoPaths.getBasicById(photoId);
    if (photo == null) throw new AppError('NOT_FOUND', `photo not found: ${photoId}`);
    return photo;
  }

  private library(libraryId: string): Library {
    const library = this.libraries.getById(libraryId);
    if (library == null) throw new AppError('NOT_FOUND', `library not found: ${libraryId}`);
    return library;
  }
}

// `bytes=N-` only, as the peer route parses: a transfer resumes from its staged size.
function rangeOffset(header: string | null): number {
  if (header == null) return 0;
  const match = /^bytes=(\d+)-$/.exec(header);
  if (match == null) throw new AppError('VALIDATION_ERROR', `unsupported range: ${header}`);
  return Number(match[1]);
}
