// What a rendition request costs, stage by stage, held against what it cost last time.
//
//   bun run bench                      compare against test/fixtures/bench.budget.json
//   BOWERBIRD_WRITE_BUDGET=1 bun run bench    record this machine's numbers as the new budget
//
// **A same-machine ratchet, not a cross-machine gate.** A millisecond means something different on
// every adapter, so the budget records a table per adapter and a run on one it has never seen
// reports rather than fails. What it is for is a change - the Slang port above all - where the
// question is whether this machine got slower than it was an hour ago, and that is a question a
// committed number can answer exactly.
//
// **Every GPU the machine offers, not the fastest one.** A user runs this pipeline on whatever is
// in their box, and the two kinds do not merely differ in speed - they disagree about which stages
// are expensive. Measured here on the same commit: the discrete card is 37x on `demosaic` and 18x
// on `denoise`, and *slower* on `resize` and `condition`, which are small enough that a round trip
// across the bus costs more than the work and an integrated GPU's shared memory never charges it.
// A ratchet on one of them cannot see a regression that only lands on the other, so this runs the
// render once per adapter and holds each against its own table.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const BUDGET = resolve(ROOT, 'test/fixtures/bench.budget.json');
const FIXTURES = ['DSC02981.ARW', 'IMG_5360.CR3', 'DSC00853.ARW'];

/// What `bench_stages` times for each of them, and what a recorded budget has to hold for all three.
///
/// The order is the order a render runs in, which is the order they are reported in - `bench_stages`
/// emits them keyed rather than positioned, so this is the one place that says which is which.
const STAGES = [
  'file',
  'metadata',
  'unpack',
  'condition',
  'dust',
  'denoise',
  'demosaic',
  'measure',
  'code',
  'resize',
  'grade',
  'encode',
  'peak',
  'total',
];

/// The stages a regression is called on. The rest are measured and reported and nothing more.
///
/// **The two ends of a request are not this pipeline's to answer for.** `file` is the page cache
/// telling you whether someone else read the photograph recently, and `encode` is libaom, whose
/// speed is the machine's and whose output this repo does not otherwise tune. Both belong in the
/// table - a render is not faster because its slow part moved into a stage nobody watches - but a
/// build should not fail because the kernel dropped a mapping.
///
/// `total` is reported for the same reason and gated for none of it: it is the sum of a gated
/// middle and two ungated ends, so failing on it would fail on them by the back door.
const REPORTED_ONLY = new Set(['file', 'encode', 'total']);

/// How much slower than its budget a stage has to be before a percentage is believed.
///
/// **A tolerance alone cannot gate a stage that costs half a millisecond**, and the jitter it has to
/// floor is not the printed precision. Two tenths would be right if rounding were the whole of it;
/// measured instead, on an idle machine with the budget freshly recorded and not a line of code
/// changed between runs, `resize` on `DSC02981` came in at 0.5, 0.9, 1.1, 1.4, 1.6, 1.7 and 1.8ms
/// against a budget of 0.8. Consecutive runs of the gate passed and failed on it alone, which is a
/// gate that teaches a reader to disbelieve it.
///
/// So the margin is that spread, and the tolerance still rules everything the machine can actually
/// resolve: at `grade`'s three hundred milliseconds fifteen percent is fifty, and this never comes
/// into it. What it costs is the ability to call a sub-millisecond stage regressed on less than a
/// millisecond and a half, and the regression those budgets exist to catch was far larger - the
/// `006ca970` re-record found `resize` at 3.9 against 0.2, which is over this by more than twice.
const MARGIN_MS = 1.5;

type Taken = Record<string, Record<string, number>>;

type Budget = {
  tolerance: number;
  /// The stages the budget was recorded over.
  ///
  /// **Without this a renamed stage is worse than a missing one.** A key that survives a change of
  /// meaning - `grade` was the whole of `edit::from_frame` and is now one dispatch - matches by
  /// name and reports a percentage against a number measuring something else, which reads as a
  /// large win rather than as a budget to re-record.
  stages?: string[];
  /// Fixture by stage, under the adapter the numbers were taken on.
  ///
  /// **Keyed by the adapter's own description, so a machine that gains or loses a GPU does not
  /// invalidate the rest.** Recording merges rather than replaces for the same reason: a laptop
  /// that can only see its integrated part must not silently drop the discrete table a workstation
  /// recorded.
  adapters: Record<string, Taken>;
  /// What a stage is *held* to, where its spread is wider than the gate its measurement gives.
  ///
  /// **Not a hand-edit of `adapters`, which is indistinguishable from a measurement and which the
  /// next `BOWERBIRD_WRITE_BUDGET=1` writes straight back over.** `DSC00853 condition` on the
  /// integrated part reads 13.3 to 23.3 across runs of an unchanged binary, which is wider than 15%
  /// and a 1.5ms margin can floor, and a gate that fails one run in three teaches a reader to
  /// disbelieve it. The gate is the larger of the two numbers, so a stage that grows past its
  /// widening is still caught by its own measurement.
  widened?: Record<string, Taken>;
};

/// What a stage is held to on this adapter: what it measured, unless [`Budget.widened`] says its
/// spread is wider than that.
export function gateOf(
  budget: Budget,
  adapter: string,
  fixture: string,
  stage: string,
): number | undefined {
  const recorded = budget.adapters[adapter]?.[fixture]?.[stage];
  if (recorded == null) return undefined;
  return Math.max(recorded, budget.widened?.[adapter]?.[fixture]?.[stage] ?? 0);
}

/// What a re-record writes: this run's numbers over the adapters already recorded, every widening
/// carried through.
export function rerecorded(budget: Budget, runs: { adapter: string; taken: Taken }[]): Budget {
  const adapters = { ...budget.adapters };
  for (const { adapter, taken } of runs) adapters[adapter] = taken;
  return { tolerance: budget.tolerance, stages: STAGES, widened: budget.widened, adapters };
}

/** Whether a recorded budget describes the stages this build renders. */
function current(budget: Budget): boolean {
  return (
    budget.stages != null &&
    budget.stages.length === STAGES.length &&
    budget.stages.every((stage, at) => stage === STAGES[at])
  );
}

/** The adapter `gpu::device` settled on, which is what makes a number comparable. */
function adapterOf(stderr: string): string {
  const line = stderr.split('\n').find((l) => l.startsWith('rawshim gpu: '));
  return line?.slice('rawshim gpu: '.length).trim() ?? 'unknown';
}

/// Every adapter the run saw, in the order the shim listed them.
///
/// The software rasteriser is dropped: `gpu::device` keeps it so a box with no hardware imports
/// slowly rather than not at all, and timing it would record how fast a CPU pretends to be a GPU.
function offeredBy(stderr: string): string[] {
  const mark = 'rawshim gpu offered: ';
  const all = stderr
    .split('\n')
    .filter((l) => l.startsWith(mark))
    .map((l) => l.slice(mark.length).trim())
    .filter((a) => !a.includes('(Cpu,'));
  return [...new Set(all)];
}

function measured(stdout: string): Taken {
  const out: Taken = {};
  for (const line of stdout.split('\n')) {
    const [fixture, stage, ms] = line.split('\t');
    if (!fixture || !stage || !ms) continue;
    (out[fixture] ??= {})[stage] = Number(ms);
  }
  return out;
}

/// One whole `bench_stages` over every fixture, on whichever adapter `want` names.
///
/// `want` unset is the adapter the product would pick on its own, which is what the first run has
/// to be: the shim's own choice is a thing worth reporting, and asking for it by name would hide a
/// change in how it chooses.
function render(want?: string): { adapter: string; offered: string[]; taken: Taken } {
  const run = spawnSync(
    'bun',
    [
      'run',
      'scripts/cargo.ts',
      'run',
      '--release',
      '--example',
      'bench_stages',
      '--manifest-path',
      'native/rawshim/Cargo.toml',
      '--',
      ...FIXTURES.map((f) => `test/fixtures/${f}`),
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: want == null ? process.env : { ...process.env, BOWERBIRD_ADAPTER: want },
    },
  );
  if (run.status !== 0) {
    process.stderr.write(run.stderr ?? '');
    console.error(`bench_stages did not run${want == null ? '' : ` on ${want}`}`);
    process.exit(run.status ?? 1);
  }
  return {
    adapter: adapterOf(run.stderr),
    offered: offeredBy(run.stderr),
    taken: measured(run.stdout),
  };
}

function main(): void {
  const budget: Budget = JSON.parse(readFileSync(BUDGET, 'utf8'));

  // The shim's own choice first, then each other adapter it listed. The first run pays for the
  // enumeration as well as for its own numbers, so nothing is spent finding out what is here.
  const first = render();
  const rest = first.offered.filter((a) => a !== first.adapter);
  const runs = [
    { adapter: first.adapter, taken: first.taken },
    ...rest.map((want) => {
      const run = render(want);
      return { adapter: run.adapter, taken: run.taken };
    }),
  ];

  // **These stages share a CPU and one integrated GPU with whatever else is running**, so a build
  // or a browser suite alongside them moves every number at once: measured here, one run put
  // `frame` at +1.7% and the next, against the same binary, at +41.7%. Neither reading is about
  // the code, so a busy machine reports rather than judges - the same argument the adapter check
  // below makes - and cannot record a budget at all, since that would bake the contention in and
  // loosen the gate for good.
  const load = loadavg()[0] ?? 0;
  const busy = load > cpus().length / 2;

  if (process.env.BOWERBIRD_WRITE_BUDGET) {
    if (busy) {
      console.error(
        `load average ${load.toFixed(1)} over ${cpus().length} cpus: too busy to record a ` +
          'budget, which would hold every later run to what contention cost this one.',
      );
      process.exit(1);
    }
    // **A fixture that failed to measure must not be written as one that has no budget.**
    // `bench_stages` reports a bad open on stderr and moves on, so the run still exits 0 with that
    // fixture simply absent from stdout - and a budget recorded from it would drop the fixture
    // silently, leaving the ratchet watching two photographs where it used to watch three.
    const missing = runs.flatMap(({ adapter, taken }) =>
      FIXTURES.flatMap((fixture) =>
        STAGES.filter((stage) => taken[fixture]?.[stage] == null).map(
          (stage) => `${adapter}: ${fixture} ${stage}`,
        ),
      ),
    );
    if (missing.length > 0) {
      console.error(`not measured, so the budget was not written: ${missing.join(', ')}`);
      process.exit(1);
    }
    writeFileSync(BUDGET, `${JSON.stringify(rerecorded(budget, runs), null, 2)}\n`);
    for (const { adapter, taken } of runs) {
      console.log(`recorded ${Object.keys(taken).length} fixtures on ${adapter}`);
    }
    return;
  }

  if (busy) {
    console.log(`load average ${load.toFixed(1)} over ${cpus().length} cpus`);
    console.log('reporting only: this machine is busy, and every stage moves together when it is.');
    console.log('re-run it idle before believing a regression.\n');
  }

  const stale = !current(budget);
  if (stale) {
    console.log('the budget was recorded over a different set of stages, so none of it is held');
    console.log('against this run. re-record it with BOWERBIRD_WRITE_BUDGET=1 on an idle machine.\n');
  }

  // **Over what was measured, not over what the budget knows.** A stage added to the render shows
  // up in this table on the run that adds it, rather than staying invisible until somebody records
  // a budget - which is the state a table read for "where did the time go" has to be in.
  let regressed = false;
  for (const { adapter, taken } of runs) {
    const recorded = budget.adapters[adapter];
    console.log(`\n${adapter}`);
    if (recorded == null) {
      console.log('no budget for this adapter yet: reporting only.');
    }
    const comparable = recorded != null && !busy;
    for (const fixture of FIXTURES) {
      for (const stage of STAGES) {
        const ms = taken[fixture]?.[stage];
        const was = stale ? undefined : recorded?.[fixture]?.[stage];
        const gate = stale ? undefined : gateOf(budget, adapter, fixture, stage);
        if (ms == null) {
          console.error(`${fixture} ${stage}: not measured`);
          regressed ||= comparable;
          continue;
        }
        const over =
          gate != null &&
          !REPORTED_ONLY.has(stage) &&
          ms > gate * (1 + budget.tolerance) &&
          ms - gate > MARGIN_MS;
        regressed ||= over && comparable;
        const mark = over ? 'OVER ' : '     ';
        const wider = was != null && gate != null && gate > was ? `  gate ${gate.toFixed(1)}ms` : '';
        const against =
          was == null
            ? 'no budget yet'
            : `budget ${was.toFixed(1)}ms  ${((ms - was) / was) * 100 >= 0 ? '+' : ''}${
                (((ms - was) / was) * 100).toFixed(1)
              }%${wider}`;
        console.log(
          `${mark}${fixture.padEnd(16)} ${stage.padEnd(10)} ${ms.toFixed(1).padStart(8)}ms  ` +
            against,
        );
      }
    }
  }

  if (regressed) {
    console.error(
      `\na stage is more than ${(budget.tolerance * 100).toFixed(0)}% over budget. ` +
        'If the cost is deliberate, re-record with BOWERBIRD_WRITE_BUDGET=1.',
    );
    process.exit(1);
  }
}

if (import.meta.main) main();
