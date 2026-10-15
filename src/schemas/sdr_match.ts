import { z } from 'zod';

/**
 * How a platform shows a PQ video's SDR range, which Firefox's 10-bit copy of an HDR rendition is
 * coded to match (§10.7.2, `hdrVideoSdrMatch`).
 */
export const SdrMatchSchema = z.enum(['still', 'mac-video']);
export type SdrMatch = z.infer<typeof SdrMatchSchema>;

export const SDR_MATCHES: readonly SdrMatch[] = SdrMatchSchema.options;

/** What a file or directory coded to `matching` adds to the name of the one coded as a still. */
export function sdrMatchSuffix(matching: SdrMatch): string {
  return matching === 'still' ? '' : `-${matching}`;
}
