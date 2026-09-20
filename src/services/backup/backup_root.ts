import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { AppError } from '../../errors';
import { BackupMarkerSchema, type BackupMarker } from '../../schemas/backup';
import { containsPath } from '../../utils/paths';

// The directory a passive peer is (docs/replication.md §14.1): a mirror of the library tree, a
// hidden staging directory beside it, and a marker naming what it is a backup of.

const MARKER = '.bowerbird-backup.json';

// Hidden, and named as the library's own staging directory is, so a mount browsed by hand looks
// like the library it mirrors and nothing else.
const STAGING = '.bowerbird-staging';

export function markerPath(root: string): string {
  return path.join(root, MARKER);
}

export function backupStagingDir(root: string): string {
  return path.join(root, STAGING);
}

export function backupStagePath(root: string, photoId: string): string {
  return path.join(backupStagingDir(root), `${photoId}.partial`);
}

/**
 * Where a library-relative path lands on the mirror.
 *
 * Refuses one that would leave the mirror: the path comes from a catalogue row, and a replicated
 * row is remote input to a disk write (§11.2) whichever disk it is.
 */
export function backupPath(root: string, relPath: string): string {
  const target = path.join(root, relPath);
  if (!containsPath(root, target)) {
    throw new AppError('VALIDATION_ERROR', `file path escapes the backup folder: ${relPath}`);
  }
  return target;
}

export function readMarker(root: string): BackupMarker | null {
  try {
    return BackupMarkerSchema.parse(JSON.parse(readFileSync(markerPath(root), 'utf8')));
  } catch {
    return null;
  }
}

/**
 * The mirror, or a refusal naming what is wrong with it.
 *
 * Three states a backup pass has to tell apart, because only one of them is a problem: the drive
 * is not mounted (wait for it), the directory is there and is this library's mirror (go), and the
 * directory is there and is *somebody else's* - an empty mount point where the NAS should be, a
 * second library pointed at the same folder - which is the one that would write a photograph into
 * a tree that is not its own.
 */
export function assertMirrorOf(root: string, libraryId: string, name: string): void {
  if (!existsSync(root)) {
    throw new AppError('UNAVAILABLE', `the backup folder for "${name}" is not there: ${root}`);
  }
  const marker = readMarker(root);
  if (marker == null) {
    throw new AppError('UNAVAILABLE', `${root} holds no backup of "${name}"; the drive may not be mounted`);
  }
  if (marker.library_id !== libraryId) {
    throw new AppError('CONFLICT', `${root} is the backup of another library ("${marker.library_name}")`);
  }
}

/** Whether the mirror is there to be read, which is what a fetch and a cull both ask first. */
export function mirrorReady(root: string, libraryId: string): boolean {
  return readMarker(root)?.library_id === libraryId;
}
