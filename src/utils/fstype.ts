import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

const MOUNTINFO = '/proc/self/mountinfo';

// Filesystems whose contents change without this kernel doing the writing, so
// there is no VFS event for inotify to report: another NFS client's copy lands on
// the server and never touches us. NFSv4.1 has directory delegations in the spec
// for exactly this, and neither the Linux client nor knfsd implements them, so a
// library on one of these is polled instead (DESIGN §9.8).
//
// Only mounts with *other writers* belong here. A local FUSE filesystem is fine -
// everything reaching it comes through this kernel - which is why the fuse entries
// are named ones that front a remote or a second store rather than `fuse.` whole.
const REMOTE_FS = new Set([
  '9p',
  'afs',
  'beegfs',
  'ceph',
  'cifs',
  'coda',
  'davfs',
  'davfs2',
  'glusterfs',
  'lustre',
  'ncpfs',
  'prl_fs',
  'smb2',
  'smb3',
  'smbfs',
  'vboxsf',
  'virtiofs',
  'vmhgfs',
  'fuse.davfs2',
  'fuse.glusterfs',
  'fuse.mergerfs',
  'fuse.rclone',
  'fuse.s3fs',
  'fuse.sshfs',
]);

export function reportsFileEvents(fsType: string): boolean {
  return !fsType.startsWith('nfs') && !REMOTE_FS.has(fsType);
}

/** The filesystem `absPath` resolves onto, or null where that cannot be read (a host that is not Linux). */
export function mountFsType(absPath: string): string | null {
  let mountinfo: string;
  try {
    mountinfo = readFileSync(MOUNTINFO, 'utf8');
  } catch {
    return null;
  }
  let resolved: string;
  try {
    resolved = realpathSync(absPath);
  } catch {
    resolved = path.resolve(absPath);
  }
  return fsTypeIn(mountinfo, resolved);
}

/** The parse, given the file's contents, so it can be tested without one. */
export function fsTypeIn(mountinfo: string, absPath: string): string | null {
  let best: { mountPoint: string; fsType: string } | null = null;
  for (const line of mountinfo.split('\n')) {
    // `mountinfo`'s optional fields are variable in number and end at ' - ', which
    // is what makes the type findable at all: it is the first field after that.
    const separator = line.indexOf(' - ');
    if (separator < 0) continue;
    const mountPoint = unescapeOctal(line.slice(0, separator).split(' ')[4] ?? '');
    const fsType = line.slice(separator + 3).split(' ')[0];
    if (mountPoint === '' || fsType == null || fsType === '') continue;
    if (!contains(mountPoint, absPath)) continue;
    // Longest mount point wins, and a later line wins a tie: a tie is an overmount,
    // and what a path resolves through is the last thing mounted there.
    if (best == null || mountPoint.length >= best.mountPoint.length) best = { mountPoint, fsType };
  }
  return best?.fsType ?? null;
}

function contains(mountPoint: string, absPath: string): boolean {
  if (mountPoint === '/') return true;
  return absPath === mountPoint || absPath.startsWith(`${mountPoint}/`);
}

// A mount point holding a space arrives as `\040`, and a path that is not decoded
// matches nothing.
function unescapeOctal(field: string): string {
  return field.replace(/\\(\d{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}
