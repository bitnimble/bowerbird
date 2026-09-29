import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { AppError } from '../../errors';
import {
  BackupAccessSchema,
  BackupMarkerSchema,
  type BackupAccess,
  type BackupMarker,
} from '../../schemas/backup';
import { containsPath } from '../../utils/paths';
import { BackupError } from './backup_error';

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
  } catch (error) {
    if (error instanceof Error && 'code' in error) {
      if (error.code === 'ENOENT') return null;
      throw new BackupError(
        'unreadable',
        "We couldn't read the backup marker. Check the folder permissions and try again.",
      );
    }
    throw new BackupError(
      'marker_invalid',
      "The backup marker can't be read. Choose another backup folder or restore its marker.",
    );
  }
}

export function assertMirrorOf(
  root: string,
  libraryId: string,
  name: string,
  peerId?: string,
): void {
  let folder;
  try {
    folder = statSync(root, { throwIfNoEntry: false });
  } catch {
    throw new BackupError(
      'unreadable',
      `We couldn't read the backup folder for "${name}". Check its permissions and try again.`,
    );
  }
  if (folder == null || !folder.isDirectory()) {
    throw new BackupError(
      'folder_missing',
      `The backup folder for "${name}" isn't available. Connect the drive or select its folder again.`,
    );
  }
  const marker = readMarker(root);
  if (marker == null) {
    throw new BackupError(
      'marker_missing',
      'The backup marker is missing. Connect the backup drive or select the folder again.',
    );
  }
  if (marker.library_id !== libraryId) {
    throw new BackupError(
      'wrong_library',
      `This folder backs up "${marker.library_name}". Choose this library's backup folder.`,
    );
  }
  if (peerId != null && marker.peer_id !== peerId) {
    throw new BackupError(
      'wrong_backup',
      'This folder is a different backup. Select the backup folder again to use it.',
    );
  }
}

export function mirrorAccess(
  root: string,
  libraryId: string,
  name: string,
  peerId?: string,
): BackupAccess {
  try {
    assertMirrorOf(root, libraryId, name, peerId);
    return 'ready';
  } catch (error) {
    const access = BackupAccessSchema.safeParse(
      error instanceof BackupError ? error.issueCode : null,
    );
    return access.success ? access.data : 'unreadable';
  }
}

export function mirrorReady(
  root: string,
  libraryId: string,
  name: string,
  peerId?: string,
): boolean {
  return mirrorAccess(root, libraryId, name, peerId) === 'ready';
}
