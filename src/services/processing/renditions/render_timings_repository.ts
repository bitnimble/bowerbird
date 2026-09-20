import type { Database } from '../../../db/driver';
import {
  RenderTimingSchema,
  type RenderTiming,
  type RenderTimings,
  type RenderedRendition,
} from '../../../schemas/render_stages';

interface TimingRow {
  library_id: string;
  rendition: string;
  total_ms: number;
  stages_ms: string;
  measured_at: string;
}

/**
 * What a render of a library's photographs was measured to cost here, stage by stage (§10.1).
 *
 * A row per library and rendition, so two benchmarks running at once each write their own and
 * neither can drop the other's - which a single stored blob merged in JavaScript could not promise,
 * a benchmark taking minutes between reading it and writing it back.
 */
export class RenderTimingsRepository {
  constructor(private readonly db: Database) {}

  forLibrary(libraryId: string): RenderTimings {
    const rows = this.db.query('SELECT * FROM render_timings WHERE library_id = ?').all(libraryId) as TimingRow[];
    return timingsOf(rows);
  }

  /** Every library's, for the list endpoint, so a page of them is one query rather than one each. */
  byLibrary(): Map<string, RenderTimings> {
    const rows = this.db.query('SELECT * FROM render_timings').all() as TimingRow[];
    const grouped = new Map<string, TimingRow[]>();
    for (const row of rows) grouped.set(row.library_id, [...(grouped.get(row.library_id) ?? []), row]);
    return new Map([...grouped].map(([libraryId, of]) => [libraryId, timingsOf(of)]));
  }

  put(libraryId: string, rendition: RenderedRendition, timing: RenderTiming): void {
    this.db
      .query(
        `INSERT INTO render_timings (library_id, rendition, total_ms, stages_ms, measured_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(library_id, rendition) DO UPDATE SET
             total_ms = excluded.total_ms, stages_ms = excluded.stages_ms, measured_at = excluded.measured_at`,
      )
      .run(libraryId, rendition, timing.total, JSON.stringify(timing.stages), timing.measured_at);
  }
}

/**
 * The rows as the panel reads them.
 *
 * A row this build cannot parse is dropped rather than failing the read: what it costs is an
 * estimate shown in place of a measurement, and that must not be the reason a library will not
 * list.
 */
function timingsOf(rows: TimingRow[]): RenderTimings {
  const timings: RenderTimings = {};
  for (const row of rows) {
    const parsed = RenderTimingSchema.safeParse({
      total: row.total_ms,
      stages: parseStages(row.stages_ms),
      measured_at: row.measured_at,
    });
    if (parsed.success) timings[row.rendition as RenderedRendition] = parsed.data;
  }
  return timings;
}

function parseStages(stored: string): unknown {
  try {
    return JSON.parse(stored);
  } catch {
    return {};
  }
}
