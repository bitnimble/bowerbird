import { z } from 'zod';
import type { ExportOptions } from '../../../../src/schemas/export';
import { exportsApi } from '../../api/exports';
import { shellInvoke, type Invoke } from '../../api/transport';
import { ExportStrings } from './export.strings';

/** Where a finished export goes, which is the one part of an export the server cannot decide. */
export interface ExportSink {
  /**
   * Answers where the file landed, for the history to record.
   *
   * A path where the destination has one, and the name alone where it does not: a browser
   * writing through a directory handle is told the folder's name and never its path, and the
   * downloads folder is not somewhere the page can name at all.
   *
   * `run` is carried into the render because the history's tile comes off it (§10.5.2), so
   * which run this belongs to has to be known before the file exists rather than after.
   */
  save(photoId: string, options: ExportOptions, run: string): Promise<string>;
}

type Picker = (options?: {
  mode?: 'read' | 'readwrite';
  id?: string;
  startIn?: string;
}) => Promise<FileSystemDirectoryHandle>;

/**
 * Asks the reader where the files go, and answers null if they decline.
 *
 * `count` is how many files are coming: one, in a browser, is a download, which is where a
 * single file goes without being asked about anywhere else on the web. The shell asks either
 * way - it writes with the reader's own filesystem, and its dialog remembers where.
 *
 * **Must be reached inside the click that started the export.** `showDirectoryPicker` needs
 * transient activation, so anything awaited before this runs turns the picker into a silent
 * no-op and the export into a pile of downloads.
 */
export function chooseSink(count: number): Promise<ExportSink | null> {
  const invoke = shellInvoke();
  if (invoke != null) return shellFolder(invoke);
  const picker = (window as { showDirectoryPicker?: Picker }).showDirectoryPicker;
  return picker == null || count < 2 ? Promise.resolve(downloads()) : pickedDirectory(picker);
}

/** `src-tauri/src/export.rs`. Android has no folder to pick, so the shell says so. */
const FolderSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unsupported') }),
  z.object({ kind: z.literal('dismissed') }),
  z.object({ kind: z.literal('picked'), path: z.string() }),
]);

async function shellFolder(invoke: Invoke): Promise<ExportSink | null> {
  const answer = FolderSchema.safeParse(await invoke('pick_export_folder', {}));
  // A shell newer than this page.
  if (!answer.success) throw new Error(ExportStrings.unknownFolderAnswer());
  const folder = answer.data;
  switch (folder.kind) {
    case 'dismissed':
      return null;
    case 'unsupported':
      return downloads();
    case 'picked':
      return {
        save: async (photoId, options, run) =>
          z.string().parse(await invoke('export_to_folder', { folder: folder.path, photoId, options, runId: run })),
      };
  }
}

async function pickedDirectory(picker: Picker): Promise<ExportSink | null> {
  let directory: FileSystemDirectoryHandle;
  try {
    // `id` is what makes the picker reopen where the last export went rather than at home,
    // and `startIn` is only the first time.
    directory = await picker.call(window, { mode: 'readwrite', id: 'export', startIn: 'downloads' });
  } catch (err) {
    // Only `AbortError` is a reader saying no. A `SecurityError` is this having been reached
    // past the click's transient activation, which is the one bug the ordering above guards
    // against - swallowed as a dismissal, it looks like the reader closed the picker.
    if (err instanceof DOMException && err.name === 'AbortError') return null;
    throw err;
  }
  return {
    async save(photoId, options, run): Promise<string> {
      const file = await exportsApi.create({ photoId, options, runId: run });
      const filename = await free(directory, named(file.filename));
      const handle = await directory.getFileHandle(filename, { create: true });
      const writable = await handle.createWritable();
      await writable.write(file.bytes as BlobPart);
      await writable.close();
      return `${directory.name}/${filename}`;
    },
  };
}

/**
 * A name nothing in the folder is already using.
 *
 * `create: true` truncates an existing name, and two bodies both number their frames from one.
 * Asked of the folder rather than tracked across this run, so a second export into a folder an
 * earlier one wrote to is safe too. `src-tauri/src/export.rs` numbers the shell's the same way.
 */
async function free(directory: FileSystemDirectoryHandle, filename: string): Promise<string> {
  const dot = filename.lastIndexOf('.');
  const stem = dot <= 0 ? filename : filename.slice(0, dot);
  const extension = dot <= 0 ? '' : filename.slice(dot);
  for (let attempt = 1; ; attempt++) {
    const candidate = attempt === 1 ? filename : `${stem} (${attempt})${extension}`;
    try {
      await directory.getFileHandle(candidate);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotFoundError') return candidate;
      throw err;
    }
  }
}

/** Refused rather than invented: the route names every export, so a guess here improves nothing. */
function named(filename: string | null): string {
  if (filename == null) throw new Error(ExportStrings.unnamedExport());
  return filename;
}

function downloads(): ExportSink {
  return {
    async save(photoId, options, run): Promise<string> {
      const { bytes, mediaType, filename } = await exportsApi.create({ photoId, options, runId: run });
      const name = named(filename);
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mediaType }));
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      link.click();
      // Revoking in the same task as the click cancels the download in WebKit, which has not
      // started reading it yet.
      requestAnimationFrame(() => URL.revokeObjectURL(url));
      return name;
    },
  };
}
