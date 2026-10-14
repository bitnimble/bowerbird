import { z } from 'zod';

/**
 * The nits a platform shows a PQ video's SDR white at, which Firefox's 10-bit copy of an HDR
 * rendition codes white at (§10.7.2): 203 as a browser shows a PQ still, 100 on macOS.
 */
export const TenBitWhiteSchema = z.union([z.literal(203), z.literal(100)]);
export type TenBitWhite = z.infer<typeof TenBitWhiteSchema>;

export const TEN_BIT_WHITES: readonly TenBitWhite[] = [203, 100];
export const STILL_WHITE: TenBitWhite = 203;
