import { describe, expect, it } from 'bun:test';
import {
  EXPORT_FORMATS,
  ExportOptionsSchema,
  ExportRequestSchema,
  exportFilename,
  honoured,
  writesSdr,
  type ExportFormat,
} from '../export';

const FORMATS = Object.keys(EXPORT_FORMATS) as ExportFormat[];
const options = (over: Partial<ReturnType<typeof ExportOptionsSchema.parse>> = {}) =>
  ExportOptionsSchema.parse({ ...over });

describe('honoured', () => {
  // The dialog greys a control out and the route must not trust that it did. Both ask this
  // function, so a format that cannot carry a setting cannot be talked into it either way.
  it('drops HDR for a format with no way to signal it', () => {
    for (const format of FORMATS) {
      const asked = honoured(options({ format, exportHdr: true }));
      expect(asked.exportHdr).toBe(EXPORT_FORMATS[format].hdr);
    }
  });

  it('drops a gain map for a format that cannot carry one', () => {
    for (const format of FORMATS) {
      const asked = honoured(options({ format, exportHdr: true, gainMap: true }));
      expect(asked.gainMap).toBe(EXPORT_FORMATS[format].gainMap && EXPORT_FORMATS[format].gainMapEncoder);
    }
  });

  // A JPEG's primary image is eight-bit whatever is asked of it, so the map is not an extra on
  // top of an HDR file - it is the only place the range can go, and asking for one is what makes
  // the HDR arm worth rendering at all.
  it('keeps HDR for a format that carries it only in a gain map', () => {
    expect(honoured(options({ format: 'jpeg', exportHdr: true, gainMap: true })).exportHdr).toBe(true);
    expect(honoured(options({ format: 'jpeg', exportHdr: true, gainMap: false })).exportHdr).toBe(false);
  });

  // A gain map reconstructs the HDR from the base. With no HDR asked for there is nothing to
  // reconstruct, so the map would be a second copy of the picture already in the file.
  it('drops a gain map when HDR was not asked for', () => {
    expect(honoured(options({ format: 'avif', exportHdr: false, gainMap: true })).gainMap).toBe(false);
  });

  it('leaves an honourable request alone', () => {
    const asked = options({ format: 'avif', exportHdr: true, gainMap: true, quality: 70, longEdge: 2048 });
    expect(honoured(asked)).toEqual(asked);
  });
});

describe('exportFilename', () => {
  it('keeps the name and takes the format extension', () => {
    expect(exportFilename('Trip/DSC02981.ARW', 'jpeg')).toBe('DSC02981.jpg');
    expect(exportFilename('DSC02981.ARW', 'avif')).toBe('DSC02981.avif');
    expect(exportFilename('a/b/IMG_5360.CR3', 'tiff')).toBe('IMG_5360.tif');
  });

  it('survives a name with no extension and one with several dots', () => {
    expect(exportFilename('photo', 'png')).toBe('photo.png');
    expect(exportFilename('a.b.c.ARW', 'jpeg')).toBe('a.b.c.jpg');
  });
});

// **The one request in this app with a producer TypeScript never sees**: the desktop shell
// builds this body in Rust (`src-tauri/src/export.rs`), so renaming a field here is a 400 at
// runtime on that host and nothing red anywhere else.
describe('ExportRequestSchema', () => {
  const options = ExportOptionsSchema.parse({});

  it('takes one photograph by id', () => {
    expect(ExportRequestSchema.safeParse({ photoId: 'p1', options }).success).toBe(true);
  });

  it('refuses a list of ids, which is a selection rather than one export', () => {
    expect(ExportRequestSchema.safeParse({ photoIds: ['p1'], options }).success).toBe(false);
  });

  it('refuses an empty id rather than looking one up', () => {
    expect(ExportRequestSchema.safeParse({ photoId: '', options }).success).toBe(false);
  });
});

describe('ExportOptionsSchema', () => {
  // What the dialog opens on, and what a client too old to send a field gets.
  it('defaults to a full-size JPEG with edits and HDR', () => {
    expect(options()).toEqual({
      format: 'jpeg',
      longEdge: 0,
      quality: 88,
      includeEdits: true,
      halfSize: false,
      exportHdr: true,
      gainMap: false,
      renderingIntent: 'perceptual',
    });
  });
});

describe('writesSdr', () => {
  it('is true where the file holds an SDR picture, a gain map base included', () => {
    expect(writesSdr(options({ format: 'jpeg', exportHdr: false }))).toBe(true);
    expect(writesSdr(options({ format: 'jpeg', exportHdr: true, gainMap: true }))).toBe(true);
    expect(writesSdr(options({ format: 'tiff', exportHdr: true }))).toBe(true);
    expect(writesSdr(options({ format: 'avif', exportHdr: true, gainMap: true }))).toBe(true);
  });

  it('is false for an HDR file with no SDR base', () => {
    expect(writesSdr(options({ format: 'avif', exportHdr: true, gainMap: false }))).toBe(false);
  });
});
