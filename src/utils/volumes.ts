import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ImportVolume } from '../schemas/imports';

const LINUX_MOUNT_ROOTS = ['/media/', '/run/media/', '/mnt/'];
const MAC_VOLUMES_DIR = '/Volumes';
const WINDOWS_DRIVE_LETTERS = 'CDEFGHIJKLMNOPQRSTUVWXYZ';

/** Mounted disks a photographer would import from, excluding the one the system runs on. */
export async function listVolumes(): Promise<ImportVolume[]> {
  switch (process.platform) {
    case 'linux':
      return linuxVolumes(await readFile('/proc/self/mounts', 'utf8'));
    case 'darwin':
      return await macVolumes();
    case 'win32':
      return await windowsVolumes();
    default:
      return [];
  }
}

export function linuxVolumes(mounts: string): ImportVolume[] {
  const volumes: ImportVolume[] = [];
  for (const line of mounts.split('\n')) {
    const field = line.split(' ')[1];
    if (field == null) continue;
    // mounts escapes spaces and the like as octal, so `/media/me/EOS\040R5` is `EOS R5`.
    const mountPoint = field.replace(/\\(\d{3})/g, (_, octal: string) =>
      String.fromCharCode(parseInt(octal, 8)),
    );
    if (!LINUX_MOUNT_ROOTS.some((root) => mountPoint.startsWith(root))) continue;
    volumes.push({ name: path.basename(mountPoint), path: mountPoint });
  }
  return volumes;
}

async function macVolumes(): Promise<ImportVolume[]> {
  const volumes: ImportVolume[] = [];
  for (const name of await readdir(MAC_VOLUMES_DIR)) {
    const volume = path.join(MAC_VOLUMES_DIR, name);
    const stats = await lstat(volume).catch(() => null);
    // The boot volume appears here as a symlink to `/`.
    if (stats == null || stats.isSymbolicLink() || name.startsWith('.')) continue;
    volumes.push({ name, path: volume });
  }
  return volumes;
}

// In parallel: a disconnected mapped drive can hold its own probe for seconds.
async function windowsVolumes(): Promise<ImportVolume[]> {
  const system = process.env.SystemDrive?.toUpperCase();
  const probed = await Promise.all(
    [...WINDOWS_DRIVE_LETTERS].map(async (letter): Promise<ImportVolume | null> => {
      const name = `${letter}:`;
      const root = `${name}\\`;
      if (name === system || (await stat(root).catch(() => null)) == null) return null;
      return { name, path: root };
    }),
  );
  return probed.filter((volume) => volume != null);
}
