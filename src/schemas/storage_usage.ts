import { z } from 'zod';

export const StorageUsageSchema = z.object({
  bytes: z.number().int().nonnegative(),
});
export type StorageUsage = z.infer<typeof StorageUsageSchema>;
