import { describe, it, expect, afterEach, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../../../../db/driver';
import { runMigrations } from '../../../../db/migrate';
import { AS_METERED } from '../../pipeline/developed';
import { LibrariesRepository } from '../../../libraries/libraries_repository';
import { ESTIMATED_MS, REFERENCE_PIXELS, scaledToReference, stageMs } from '../../../../schemas/render_stages';
import { readStages, renditionSkips, withStagesOff, writeStages } from '../render_stages';
import { RenderTimingsFile } from '../render_timings_file';

const LIB = 'lib';

const job = { ...AS_METERED, defringe: 1, matchEmbeddedJpeg: true };

describe('the stages a library leaves out of a render', () => {
  it('drops a name this build does not know, rather than refusing the render', () => {
    expect(readStages('denoise,warp,sharpen')).toEqual(['denoise', 'sharpen']);
    expect(readStages('')).toEqual([]);
  });

  it('writes one string for one set, whatever order it was chosen in', () => {
    expect(writeStages(['sharpen', 'dust'])).toBe(writeStages(['dust', 'sharpen']));
  });

  // Each of these is a value the renderer already refuses to act on, so what the setting does is
  // turn one down rather than take a second path. A stage that stopped being gated on the far side
  // would leave the checkbox doing nothing, which is the failure this pins.
  it('turns each stage down to the value the renderer skips it at', () => {
    expect(withStagesOff(job, ['denoise'])).toMatchObject({ denoiseLuminance: 0, denoiseColour: 0 });
    expect(withStagesOff(job, ['dust']).dust.enabled).toBe(false);
    expect(withStagesOff(job, ['match']).matchEmbeddedJpeg).toBe(false);
    expect(withStagesOff(job, ['defringe']).defringe).toBe(0);
    expect(withStagesOff(job, ['sharpen']).sharpen).toBe(0);
  });

  it('leaves everything alone when nothing is turned off', () => {
    expect(withStagesOff(job, [])).toEqual(job);
  });

  // The grid tile is the camera's own JPEG wherever there is one, and the render it falls back to
  // is cut from the `full` job's frame - so it has no list of its own to read.
  it('states stages for the two rendered renditions and for neither of the others', () => {
    const library = { render_skip_full: ['match' as const], render_skip_max: ['sharpen' as const] } as never;
    expect(renditionSkips(library, 'full')).toEqual(['match']);
    expect(renditionSkips(library, 'max')).toEqual(['sharpen']);
    expect(renditionSkips(library, 'grid')).toEqual([]);
    expect(renditionSkips(library, 'embedded')).toEqual([]);
  });
});

describe('what a stage is said to cost', () => {
  const measured = {
    total: 800,
    stages: { match: 400, denoise: 30 },
    measured_at: '2026-01-01T00:00:00.000Z',
  };

  it('is the estimate until this machine has measured one', () => {
    expect(stageMs('full', undefined)).toEqual(ESTIMATED_MS.full);
    // The two renditions are not the same render, so they must not quote the same numbers.
    expect(stageMs('max', undefined).encode).not.toBe(ESTIMATED_MS.full.encode);
  });

  it('prefers a measurement to an estimate, stage by stage rather than all or nothing', () => {
    const shown = stageMs('full', measured);
    expect(shown.match).toBe(400);
    expect(shown.denoise).toBe(30);
    // Never measured, because only the optional stages are: the estimate stands for the rest
    // rather than the row reading zero.
    expect(shown.encode).toBe(ESTIMATED_MS.full.encode);
    expect(shown.dust).toBe(ESTIMATED_MS.full.dust);
  });

  it('keeps a measured zero, which is a stage that saves nothing here', () => {
    expect(stageMs('full', { ...measured, stages: { sharpen: 0 } }).sharpen).toBe(0);
  });
});

// One machine has one answer, so a figure cannot also depend on which body the photograph the
// benchmark found came from: measured on half the reference sensor, a stage reads as twice what it
// took. Without this, the same machine would quote a different cost per catalogue.
describe('scaling a measurement to the reference sensor', () => {
  const measured = { total: 800, stages: { match: 400, denoise: 30 }, measured_at: '2026-01-01T00:00:00.000Z' };

  it('leaves a frame that is already the reference sensor alone', () => {
    expect(scaledToReference(measured, REFERENCE_PIXELS)).toEqual(measured);
  });

  it('carries the total and every stage together', () => {
    const scaled = scaledToReference(measured, REFERENCE_PIXELS / 2);
    expect(scaled.total).toBe(1600);
    expect(scaled.stages.match).toBe(800);
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
    db.query(`INSERT INTO libraries (id, root_path, name) VALUES (?, '/nowhere', 'Library')`).run(LIB);
    libraries = new LibrariesRepository(db);
  });

  it('starts empty, which is every stage running', () => {
    expect(libraries.getById(LIB)?.render_skip_full).toEqual([]);
    expect(libraries.getById(LIB)?.render_skip_max).toEqual([]);
  });

  it('keeps the two renditions apart', () => {
    libraries.setRenderSkip(LIB, 'max', ['denoise', 'match']);
    expect(libraries.getById(LIB)?.render_skip_max).toEqual(['denoise', 'match']);
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
  // minutes, and the other rendition's may well land while it runs.
  it('files a measurement beside the other rendition rather than over it', () => {
    file.put('full', { total: 800, stages: { match: 400 }, measured_at: '2026-01-01T00:00:00.000Z' });
    file.put('max', { total: 3000, stages: { denoise: 90 }, measured_at: '2026-01-02T00:00:00.000Z' });
    file.put('full', { total: 750, stages: { match: 380 }, measured_at: '2026-01-03T00:00:00.000Z' });

    expect(file.read()).toEqual({
      full: { total: 750, stages: { match: 380 }, measured_at: '2026-01-03T00:00:00.000Z' },
      max: { total: 3000, stages: { denoise: 90 }, measured_at: '2026-01-02T00:00:00.000Z' },
    });
  });

  // What it holds is an estimate shown in place of a measurement, so a file this build cannot
  // parse must not be the reason a settings page will not open.
  it('reads a file it cannot parse as nothing measured', () => {
    file.put('full', { total: 800, stages: {}, measured_at: '2026-01-01T00:00:00.000Z' });
    writeFileSync(join(scratch, 'nested', 'render_timings.json'), 'not json');
    expect(file.read()).toEqual({});
  });
});
