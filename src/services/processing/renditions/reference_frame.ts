import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const REFERENCE_FRAME = {
  filename: 'reference_frame.ARW',
  path: join(import.meta.dir, '../../../../assets/reference_frame.ARW'),
  byteLength: 74_784_768,
  sha256: 'da65f0b9e40479ccaa832e402c96894ac0fbaad8660c9c278afd95732e475848',
} as const;

export function assertReferenceFrame(filePath = REFERENCE_FRAME.path): void {
  let bytes: Buffer;
  try {
    bytes = readFileSync(filePath);
  } catch {
    throw mismatch(filePath);
  }
  if (
    bytes.length !== REFERENCE_FRAME.byteLength ||
    createHash('sha256').update(bytes).digest('hex') !== REFERENCE_FRAME.sha256
  ) {
    throw mismatch(filePath);
  }
}

function mismatch(filePath: string): Error {
  return new Error(`reference frame at ${filePath} is missing or does not match. Run \`git lfs pull\`.`);
}
