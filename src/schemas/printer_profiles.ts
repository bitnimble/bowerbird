import { z } from 'zod';

/** The ICC output profiles a print can be proofed through, by file name. */
export const PrinterProfilesSchema = z.object({ profiles: z.array(z.string()) });
export type PrinterProfiles = z.infer<typeof PrinterProfilesSchema>;
