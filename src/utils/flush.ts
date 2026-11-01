import { open } from 'node:fs/promises';

// What a filesystem without directory sync answers, as some FUSE and SMB mounts are.
const NO_DIRECTORY_SYNC = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EBADF']);

export async function flushFile(file: string): Promise<void> {
  // Windows refuses to flush a handle without write access; elsewhere a read-only file must still flush.
  await flush(file, process.platform === 'win32' ? 'r+' : 'r');
}

export async function flushDirectory(directory: string): Promise<void> {
  // Windows gives no handle to a directory here, and NTFS journals the entry itself.
  if (process.platform === 'win32') return;
  await flush(directory, 'r').catch((err: NodeJS.ErrnoException) => {
    if (err.code == null || !NO_DIRECTORY_SYNC.has(err.code)) throw err;
  });
}

async function flush(target: string, flags: string): Promise<void> {
  const handle = await open(target, flags);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
