import { captureKey, type ImportFile } from '../../../../src/schemas/imports';
import { CameraFileFormatSchema, type PhotoFormat } from '../../../../src/schemas/photos';

const CAMERA_FILE_FORMATS: readonly PhotoFormat[] = CameraFileFormatSchema.options;
const FINISHED_FORMATS: readonly PhotoFormat[] = [...CAMERA_FILE_FORMATS, 'png', 'avif'];

export function isRawFormat(format: PhotoFormat): boolean {
  return !FINISHED_FORMATS.includes(format);
}

/** 1 tile: a single file, or a RAW with the camera files written beside it. */
export interface ImportEntry {
  key: string;
  /** The RAW where there is one, else the file. Filters read this one's date and camera. */
  lead: ImportFile;
  files: ImportFile[];
  /** Null for a file browsers can't draw. */
  thumbnail: ImportFile | null;
  /** What a merged entry holds, in order, for its badge. Empty when it holds 1 file. */
  mergedFormats: PhotoFormat[];
}

// Folder and stem only: headers arrive later, and tiles must not split while they do. The library
// applies its stricter capture-data rule to its own rows after the copy (catalogue §4.2.2).
export function buildEntries(files: readonly ImportFile[], merge: boolean): ImportEntry[] {
  if (!merge) return files.map((file) => single(file));

  const byStem = new Map<string, ImportFile[]>();
  for (const file of files) {
    const key = captureKey(file.rel_path);
    const held = byStem.get(key);
    if (held == null) byStem.set(key, [file]);
    else held.push(file);
  }

  const entries: ImportEntry[] = [];
  for (const group of byStem.values()) {
    const raws = group.filter((file) => isRawFormat(file.format));
    const cameraFiles = group.filter((file) => CAMERA_FILE_FORMATS.includes(file.format));
    const raw = raws[0];
    if (raws.length !== 1 || raw == null || cameraFiles.length === 0) {
      entries.push(...group.map((file) => single(file)));
      continue;
    }
    entries.push(merged(raw, cameraFiles));
    entries.push(
      ...group
        .filter((file) => file !== raw && !cameraFiles.includes(file))
        .map((file) => single(file)),
    );
  }
  return entries;
}

function single(file: ImportFile): ImportEntry {
  return {
    key: String(file.id),
    lead: file,
    files: [file],
    thumbnail: file.format === 'heif' ? null : file,
    mergedFormats: [],
  };
}

function merged(raw: ImportFile, cameraFiles: ImportFile[]): ImportEntry {
  return {
    key: String(raw.id),
    lead: raw,
    files: [raw, ...cameraFiles],
    thumbnail: cameraFiles.find((file) => file.format === 'jpeg') ?? raw,
    mergedFormats: [...new Set(cameraFiles.map((file) => file.format))],
  };
}

export function filenameOf(file: ImportFile): string {
  return file.rel_path.slice(file.rel_path.lastIndexOf('/') + 1);
}
