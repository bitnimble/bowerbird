// Per-format metadata extraction. Stage 1 dispatches every supported file to
// the LibRaw header parser. See DESIGN §11.
//
// The LibRaw FFI implementation lands with the RAW decoder (raw_decoder.ts) and
// runs only where libraw.so is present (the container). Until then the reader is
// stubbed so the rest of the graph type-checks.

export interface FileMetadata {
  width: number; // display/upright width (post-flip)
  height: number; // display/upright height (post-flip)
  colorSpace: string;
  orientation: number; // LibRaw flip orientation code; informational + hash input only
  dateTaken: string | null; // ISO datetime, UTC-normalized
  latitude: number | null;
  longitude: number | null;
  mtime: string; // filesystem mtime, ISO datetime
  fileSize: number; // bytes
}

export async function extractMetadata(filePath: string): Promise<FileMetadata> {
  return extractArwMetadata(filePath);
}

async function extractArwMetadata(_filePath: string): Promise<FileMetadata> {
  throw new Error('extractArwMetadata not yet implemented (pending LibRaw FFI, DESIGN §11.1)');
}
