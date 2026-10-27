import { z } from 'zod';

const KEY = 'bowerbird.gpuLosses';
const RELOADS_TOLERATED = 3;
const LOSS_WINDOW_MS = 10 * 60_000;

const LossesSchema = z.object({ at: z.array(z.number()), sites: z.array(z.string()) });
type Losses = z.infer<typeof LossesSchema>;

/**
 * The GPU devices this tab lost, kept across the reload that replaces one, so the next worker cuts
 * the bands dispatched from where they were submitting smaller (`splitBands`).
 */
export class GpuLosses {
  /** `storage` is asked on each use, since reading `sessionStorage` itself throws where storage is blocked. */
  constructor(private readonly storage: () => Pick<Storage, 'getItem' | 'setItem'>) {}

  /** Every site a lost device was submitting from, once for each loss. */
  sites(): string[] {
    return this.read().sites;
  }

  /** Records a loss, answering whether a reload for it is within budget. */
  record(sites: string[], now: number): boolean {
    const held = this.read();
    const at = [...held.at.filter((then) => now - then < LOSS_WINDOW_MS), now];
    // Unrecorded, the next page would neither split the sites nor count this loss, and reload forever.
    if (!this.write({ at, sites: [...held.sites, ...new Set(sites)] })) return false;
    return at.length <= RELOADS_TOLERATED;
  }

  private read(): Losses {
    try {
      const parsed = LossesSchema.safeParse(JSON.parse(this.storage().getItem(KEY) ?? 'null'));
      return parsed.success ? parsed.data : { at: [], sites: [] };
    } catch {
      return { at: [], sites: [] };
    }
  }

  private write(losses: Losses): boolean {
    try {
      this.storage().setItem(KEY, JSON.stringify(losses));
      return true;
    } catch {
      return false;
    }
  }
}
