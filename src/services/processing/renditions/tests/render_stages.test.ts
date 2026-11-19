import { describe, it, expect, afterEach, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../../../../db/driver';
import { runMigrations } from '../../../../db/migrate';
import { EditDocSchema } from '../../../../schemas/photo_edits';
import { AS_METERED, developedFrom } from '../../pipeline/developed';
import { LibrariesRepository } from '../../../libraries/libraries_repository';
import {
  ESTIMATED_MS,
  ESTIMATED_PMRID_DENOISE_MS,
  REFERENCE_PIXELS,
  cameraMatchOf,
  importedEdits,
  scaledToReference,
  stageMs,
  type OptionalStage,
} from '../../../../schemas/render_stages';
import type { Developed } from '../../workers/processing_types';
import { readStages, writeStages } from '../render_stages';
import { RenderTimingsFile } from '../render_timings_file';

const LIB = 'lib';

describe('the stages a library starts new photos without', () => {
  it('drops a name this build does not know, rather than failing the import', () => {
    expect(readStages('denoise,warp,sharpen')).toEqual(['denoise', 'sharpen']);
    expect(readStages('')).toEqual([]);
  });

  it('writes one string for one set, whatever order it was chosen in', () => {
    expect(writeStages(['sharpen', 'dust'])).toBe(writeStages(['dust', 'sharpen']));
  });

  it('normalises dependent stages into one ordered set', () => {
    expect(readStages('sharpen,lens,denoise,lens')).toEqual([
      'denoise',
      'lens',
      'colour',
      'sharpen',
    ]);
    expect(writeStages(['sharpen', 'lens', 'denoise'])).toBe('denoise,lens,colour,sharpen');
  });
});

describe('the edits import starts a photo at', () => {
  const imported = (skip: readonly OptionalStage[]): Developed =>
    developedFrom(EditDocSchema.parse(importedEdits(skip, 'galosh')), 'galosh', () => false);

  it('turns the colour profile off with the lens, and never on without it', () => {
    expect(cameraMatchOf({ lensCorrection: true, colourProfile: 'matched' })).toBe('lensAndColour');
    expect(cameraMatchOf({ lensCorrection: true, colourProfile: 'none' })).toBe('lens');
    expect(cameraMatchOf({ lensCorrection: false, colourProfile: 'matched' })).toBe('none');
    expect(imported(['colour']).cameraMatch).toBe('lens');
    expect(imported(['lens']).cameraMatch).toBe('none');
  });

  // Each of these is a value the renderer already refuses to act on, so what the setting does is
  // turn one down rather than take a second path. A stage that stopped being gated on the far side
  // would leave the checkbox doing nothing, which is the failure this pins.
  it('turns each stage down to the value the renderer skips it at', () => {
    expect(imported(['denoise'])).toMatchObject({ denoiseLuminance: 0, denoiseColour: 0 });
    expect(imported(['dust']).dust.enabled).toBe(false);
    expect(imported(['defringe']).defringe).toBe(0);
    expect(imported(['sharpen']).sharpen).toBe(0);
  });

  it('writes the lens and its colour profile off together, and the profile off alone', () => {
    expect(importedEdits(['lens'], 'galosh')).toEqual({
      awaitsCameraMatch: true,
      denoiser: 'galosh',
      lensCorrection: false,
      colourProfile: 'none',
    });
    expect(importedEdits(['dust', 'colour'], 'galosh')).toEqual({
      awaitsCameraMatch: true,
      denoiser: 'galosh',
      dustRemoval: false,
      colourProfile: 'none',
    });
  });

  it('is the unedited render when nothing is turned off', () => {
    expect(imported([])).toEqual(AS_METERED);
  });

  it("records the library's denoiser", () => {
    expect(importedEdits([], 'pmrid').denoiser).toBe('pmrid');
  });
});

describe('what a stage is said to cost', () => {
  const measured = {
    total: 800,
    stages: { colour: 400, denoise: 30 },
    measured_at: '2026-01-01T00:00:00.000Z',
  };

  it('is the estimate until this machine has measured one', () => {
    expect(stageMs('full', 'galosh', undefined)).toEqual(ESTIMATED_MS.full);
    // The two renditions are not the same render, so they must not quote the same numbers.
    expect(stageMs('max', 'galosh', undefined).encode).not.toBe(ESTIMATED_MS.full.encode);
  });

  it("estimates the denoise the library's filter costs, and nothing else differently", () => {
    const pmrid = stageMs('full', 'pmrid', undefined);
    expect(pmrid.denoise).toBe(ESTIMATED_PMRID_DENOISE_MS);
    expect({ ...pmrid, denoise: ESTIMATED_MS.full.denoise }).toEqual(ESTIMATED_MS.full);
  });

  it("books the upscaler's work to the demosaic, where it runs", () => {
    const upscaler = stageMs('full', 'upscaler', undefined);
    expect(upscaler.demosaic).toBe(360);
    expect(upscaler.denoise).toBe(14);
    const { denoise, demosaic } = ESTIMATED_MS.full;
    expect({ ...upscaler, denoise, demosaic }).toEqual(ESTIMATED_MS.full);
  });

  it('prefers a measurement to an estimate, stage by stage rather than all or nothing', () => {
    const shown = stageMs('full', 'galosh', measured);
    expect(shown.colour).toBe(400);
    expect(shown.denoise).toBe(30);
    // Never measured, because only the optional stages are: the estimate stands for the rest
    // rather than the row reading zero.
    expect(shown.encode).toBe(ESTIMATED_MS.full.encode);
    expect(shown.dust).toBe(ESTIMATED_MS.full.dust);
  });

  it('keeps a measured zero, which is a stage that saves nothing here', () => {
    expect(stageMs('full', 'galosh', { ...measured, stages: { sharpen: 0 } }).sharpen).toBe(0);
  });
});

// One machine has one answer, so a figure cannot also depend on which body the photograph the
// benchmark found came from: measured on half the reference sensor, a stage reads as twice what it
// took. Without this, the same machine would quote a different cost per catalogue.
describe('scaling a measurement to the reference sensor', () => {
  const measured = {
    total: 800,
    stages: { colour: 400, denoise: 30 },
    measured_at: '2026-01-01T00:00:00.000Z',
  };

  it('leaves a frame that is already the reference sensor alone', () => {
    expect(scaledToReference(measured, REFERENCE_PIXELS)).toEqual(measured);
  });

  it('carries the total and every stage together', () => {
    const scaled = scaledToReference(measured, REFERENCE_PIXELS / 2);
    expect(scaled.total).toBe(1600);
    expect(scaled.stages.colour).toBe(800);
    expect(scaled.stages.denoise).toBe(60);
    expect(scaled.measured_at).toBe(measured.measured_at);
  });
});

describe('the column the library holds them in', () => {
  let db: Database;
  let libraries: LibrariesRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    db.query(`INSERT INTO libraries (id, root_path, name) VALUES (?, '/nowhere', 'Library')`).run(
      LIB,
    );
    libraries = new LibrariesRepository(db);
  });

  afterEach(() => db.close());

  it('starts empty, which is every stage running', () => {
    expect(libraries.getById(LIB)?.render_skip_full).toEqual([]);
    expect(libraries.getById(LIB)?.render_skip_max).toEqual([]);
  });

  it('denoises with GALOSH until told otherwise', () => {
    expect(libraries.getById(LIB)?.denoiser).toBe('galosh');
    libraries.setDenoiser(LIB, 'pmrid');
    expect(libraries.getById(LIB)?.denoiser).toBe('pmrid');
  });

  it('keeps the two renditions apart', () => {
    libraries.setRenderSkip(LIB, 'max', ['denoise', 'lens']);
    expect(libraries.getById(LIB)?.render_skip_max).toEqual(['denoise', 'lens', 'colour']);
    expect(libraries.getById(LIB)?.render_skip_full).toEqual([]);
  });
});

describe('the file the measurements are kept in', () => {
  let scratch: string;
  let file: RenderTimingsFile;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'bowerbird-timings-'));
    file = new RenderTimingsFile(join(scratch, 'nested', 'render_timings.json'));
  });

  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  it('reads as nothing measured before anything has been', () => {
    expect(file.read()).toEqual({});
  });

  // Merged with what is on disk rather than with anything read at the start: a benchmark takes
  // minutes, and another one's may well land while it runs.
  it('files a measurement beside the other rendition and the other denoiser rather than over them', () => {
    file.put('full', 'galosh', {
      total: 800,
      stages: { colour: 400 },
      measured_at: '2026-01-01T00:00:00.000Z',
    });
    file.put('max', 'galosh', {
      total: 3000,
      stages: { denoise: 90 },
      measured_at: '2026-01-02T00:00:00.000Z',
    });
    file.put('full', 'pmrid', {
      total: 820,
      stages: { denoise: 40 },
      measured_at: '2026-01-03T00:00:00.000Z',
    });
    file.put('full', 'galosh', {
      total: 750,
      stages: { colour: 380 },
      measured_at: '2026-01-04T00:00:00.000Z',
    });

    expect(file.read()).toEqual({
      full: {
        galosh: { total: 750, stages: { colour: 380 }, measured_at: '2026-01-04T00:00:00.000Z' },
        pmrid: { total: 820, stages: { denoise: 40 }, measured_at: '2026-01-03T00:00:00.000Z' },
      },
      max: {
        galosh: { total: 3000, stages: { denoise: 90 }, measured_at: '2026-01-02T00:00:00.000Z' },
      },
    });
  });

  // What it holds is an estimate shown in place of a measurement, so a file this build cannot
  // parse must not be the reason a settings page will not open.
  it('reads a file it cannot parse as nothing measured', () => {
    file.put('full', 'galosh', { total: 800, stages: {}, measured_at: '2026-01-01T00:00:00.000Z' });
    writeFileSync(join(scratch, 'nested', 'render_timings.json'), 'not json');
    expect(file.read()).toEqual({});
  });

  it('discards measurements naming a stage this build does not recognise', () => {
    file.put('full', 'galosh', { total: 800, stages: {}, measured_at: '2026-01-01T00:00:00.000Z' });
    writeFileSync(
      join(scratch, 'nested', 'render_timings.json'),
      JSON.stringify({
        full: {
          galosh: {
            total: 800,
            stages: { match: 400, grade: 24 },
            measured_at: '2026-01-01T00:00:00.000Z',
          },
        },
      }),
    );
    expect(file.read()).toEqual({});
  });
});
