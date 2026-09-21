// What a stage of a render costs here, measured by rendering the same photograph with it and
// without it. Only the real pipeline can answer it, and only the real pipeline can say whether
// turning a stage off still produces a file: every one of the five is a value the renderer is
// supposed to already refuse to act on, and a gate that moved would show up as a render that
// failed or as a saving of nothing.
//   docker exec bowerbird-dev bun test test/integration
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Library } from '../../src/schemas/libraries';
import { fileRecipe } from '../../src/schemas/recipes';
import { OPTIONAL_STAGES } from '../../src/schemas/render_stages';
import { DEFAULT_SETTINGS, type Settings } from '../../src/schemas/settings';
import { ProcessingService } from '../../src/services/processing/pipeline/processing_service';
import { RenderTimingsFile } from '../../src/services/processing/renditions/render_timings_file';
import type { PhotoPathsRepository } from '../../src/services/photos/paths/photo_paths_repository';
import type { SettingsRepository } from '../../src/services/settings/settings_repository';
import { getDataPath } from '../../src/utils/paths';

const PHOTO = 'bench-photo';

const library: Library = {
  id: 'render-benchmark',
  root_path: `${import.meta.dir}/../fixtures`,
  bin_name: 'Bin',
  read_only: false,
  name: 'lib',
  ordering: 'added_desc',
  rendition_source: 'render',
  rendition_hdr: true,
  render_skip_full: [],
  render_skip_max: [],
  include_subfolders: true,
  include_non_raw: false,
  auto_stack: true,
  auto_stack_similarity: 0.78,
  auto_stack_window_seconds: 60,
  last_synced_at: null,
  photo_count: 1,
};

// The one photograph the benchmark renders, handed over without a catalogue behind it. Its stated
// size is the frame's own, so what comes back is what was timed rather than something scaled.
const paths = {
  aFileToBenchmark: () => ({
    id: PHOTO,
    library_id: library.id,
    shoot_id: null,
    recipe: fileRecipe('DSC02981.ARW'),
    width: 6000,
    height: 4000,
  }),
} as unknown as PhotoPathsRepository;

function service(): ProcessingService {
  const settings: Settings = { ...DEFAULT_SETTINGS, processing_concurrency: 1, match_embedded_jpeg: true };
  return new ProcessingService(
    { markTileBuilt: () => {}, markRenditionsBuilt: () => {}, markCopyBuilt: () => {} } as never,
    paths,
    {} as ConstructorParameters<typeof ProcessingService>[2],
    { get: () => settings } as SettingsRepository,
    () => null,
    () => library,
  );
}

// Under a scratch directory of its own rather than the app's, which no test should be writing to.
function timings(): RenderTimingsFile {
  return new RenderTimingsFile(join(mkdtempSync(join(tmpdir(), 'bowerbird-timings-')), 'render_timings.json'));
}

const scratchDirs = (): string[] => readdirSync(tmpdir()).filter((entry) => entry.startsWith('bowerbird-benchmark-'));

test('every optional stage is priced, and nothing of the photograph is written', async () => {
  const into = timings();
  const before = scratchDirs();
  // A measurement of another rendition, to prove this one files beside it rather than over it.
  into.put('max', { total: 999, stages: { denoise: 1 }, measured_at: '2026-01-01T00:00:00.000Z' });
  try {
    const timing = await service().benchmarkRender('full', into);

    expect(timing.total).toBeGreaterThan(0);
    // Every stage answers, whether or not it cost anything on this frame: a missing key reads as
    // "not measured" in the panel and falls back to the estimate, which would hide a stage whose
    // gate had stopped working.
    for (const stage of OPTIONAL_STAGES) expect(timing.stages[stage]).toBeGreaterThanOrEqual(0);
    // The camera match is the expensive one everywhere it has been measured, and the arm most
    // likely to go quiet: it is skipped outright when an analysis is on file, so a benchmark that
    // stopped rendering cold would report nothing for it while every other stage still read.
    expect(timing.stages.match).toBeGreaterThan(0);

    // Filed under the rendition, beside the one that was already there.
    const filed = into.read();
    expect(filed.full?.total).toBe(timing.total);
    expect(filed.max?.total).toBe(999);

    // Not under the photograph: a benchmark writes renditions and measures an analysis, and both
    // go in a scratch directory that leaves with it.
    expect(existsSync(getDataPath(library))).toBe(false);
    expect(scratchDirs()).toEqual(before);
  } finally {
    rmSync(getDataPath(library), { recursive: true, force: true });
  }
}, 600_000);
