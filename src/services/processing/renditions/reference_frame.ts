import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const REFERENCE_FRAME = {
  filename: 'reference_frame.ARW',
  path: join(import.meta.dir, '../../../../assets/reference_frame.ARW'),
  url: 'https://media.githubusercontent.com/media/bitnimble/bowerbird/ef708c3d3967e2a4eaea6ffdaf238539e29f41ce/assets/reference_frame.ARW',
  byteLength: 74_784_768,
  sha256: 'da65f0b9e40479ccaa832e402c96894ac0fbaad8660c9c278afd95732e475848',
} as const;

const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;

export function assertReferenceFrame(filePath = REFERENCE_FRAME.path): void {
  if (!isReferenceFrame(readOrNull(filePath))) {
    throw new Error(`reference frame at ${filePath} is missing or does not match. Run \`git lfs pull\`.`);
  }
}

/** Downloads the frame to `filePath` unless it is already there. */
export async function fetchReferenceFrame(filePath: string, url: string = REFERENCE_FRAME.url): Promise<void> {
  if (isReferenceFrame(readOrNull(filePath))) return;
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`could not download the reference frame: ${url} answered ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!isReferenceFrame(bytes)) throw new Error(`the reference frame downloaded from ${url} does not match`);
  mkdirSync(dirname(filePath), { recursive: true });
  await Bun.write(filePath, bytes);
}

function readOrNull(filePath: string): Uint8Array | null {
  try {
    return readFileSync(filePath);
  } catch {
    return null;
  }
}

function isReferenceFrame(bytes: Uint8Array | null): boolean {
  return (
    bytes != null &&
    bytes.length === REFERENCE_FRAME.byteLength &&
    createHash('sha256').update(bytes).digest('hex') === REFERENCE_FRAME.sha256
  );
}
