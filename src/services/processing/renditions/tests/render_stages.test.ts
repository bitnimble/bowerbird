import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from '../../../../db/driver';
import { runMigrations } from '../../../../db/migrate';
import { AS_METERED } from '../../pipeline/developed';
import { LibrariesRepository } from '../../../libraries/libraries_repository';
import { ESTIMATED_MS, stageMs } from '../../../../schemas/render_stages';
import { readStages, renditionSkips, withStagesOff, writeStages } from '../render_stages';
import { RenderTimingsRepository } from '../render_timings_repository';

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

describe('the column the library holds them in', () => {
  let db: Database;
  let libraries: LibrariesRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    // The timings cascade off the library, which SQLite only enforces when asked.
    db.exec('PRAGMA foreign_keys = ON;');
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

  // Filed per library and per rendition rather than merged into one stored value, so a benchmark
  // that takes minutes cannot come back and overwrite what another one settled while it ran.
  it('files a measurement beside the others rather than over them', () => {
    const timings = new RenderTimingsRepository(db);
    timings.put(LIB, 'full', { total: 800, stages: { match: 400 }, measured_at: '2026-01-01T00:00:00.000Z' });
    timings.put(LIB, 'max', { total: 3000, stages: { denoise: 90 }, measured_at: '2026-01-02T00:00:00.000Z' });
    timings.put(LIB, 'full', { total: 750, stages: { match: 380 }, measured_at: '2026-01-03T00:00:00.000Z' });

    expect(libraries.getById(LIB)?.render_timings).toEqual({
      full: { total: 750, stages: { match: 380 }, measured_at: '2026-01-03T00:00:00.000Z' },
      max: { total: 3000, stages: { denoise: 90 }, measured_at: '2026-01-02T00:00:00.000Z' },
    });
  });

  // The rows hang off the library, so removing one takes its measurements with it rather than
  // leaving them for whichever library is minted with that id next.
  it('loses the timings with the library they describe', () => {
    new RenderTimingsRepository(db).put(LIB, 'full', { total: 800, stages: {}, measured_at: '2026-01-01T00:00:00.000Z' });
    libraries.delete(LIB);
    expect(db.query('SELECT COUNT(*) AS left FROM render_timings').get()).toEqual({ left: 0 });
  });
});
