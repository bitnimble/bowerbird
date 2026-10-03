import { z } from 'zod';
import { RenderingIntentSchema } from './rendering_intent';

export const PrinterSchema = z.object({
  id: z.string(),
  name: z.string(),
  isDefault: z.boolean(),
  location: z.string().nullable(),
  model: z.string().nullable(),
  connection: z.enum(['usb', 'network', 'unknown']),
});
export type Printer = z.infer<typeof PrinterSchema>;

export const PrintersSchema = z.object({ printers: z.array(PrinterSchema) });

const BitsSchema = z.union([z.literal(8), z.literal(16)]);
export type Bits = z.infer<typeof BitsSchema>;

export const TransportSchema = z.object({
  space: z.enum(['device', 'adobe-rgb', 'srgb']),
  bits: BitsSchema,
});
export type Transport = z.infer<typeof TransportSchema>;

export const MediaSchema = z.object({
  key: z.string(),
  name: z.string().nullable(),
  widthMm: z.number().positive(),
  heightMm: z.number().positive(),
  margins: z.object({
    top: z.number().nonnegative(),
    right: z.number().nonnegative(),
    bottom: z.number().nonnegative(),
    left: z.number().nonnegative(),
  }),
  borderless: z.boolean(),
});
export type Media = z.infer<typeof MediaSchema>;

const PWG_MEDIA = /^([a-z]+)_([a-z0-9.-]+?)_([\d.]+)x([\d.]+)(mm|in)$/;
const SIZE_NAME = /^(?:index-)?[\d.]+x[\d.]+$/;

/** A PWG self-describing media key's own name, so `iso_a4_210x297mm` is A4; null for other keys. */
export function pwgMediaName(key: string): string | null {
  const match = PWG_MEDIA.exec(key);
  if (match == null) return null;
  const [, family, name = '', width, height, unit] = match;
  if (SIZE_NAME.test(name)) return `${width} × ${height} ${unit}`;
  if (family === 'iso' || family === 'jis') return name.toUpperCase();
  return sentenceCase(name);
}

/** An IPP keyword such as `photographic-glossy` as words. */
export function keywordName(keyword: string): string {
  return sentenceCase(keyword);
}

function sentenceCase(keyword: string): string {
  const words = keyword.replaceAll('-', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const PrinterColourSchema = z.object({
  transports: z.array(TransportSchema),
  profiles: z.array(z.object({ name: z.string(), source: z.enum(['printer', 'driver']) })),
});
export type PrinterColour = z.infer<typeof PrinterColourSchema>;

export const PrinterCapabilitiesSchema = z.object({
  media: z.array(MediaSchema),
  defaultMedia: z.string().nullable(),
  mediaTypes: z.array(z.object({ key: z.string(), name: z.string().nullable() })),
  defaultMediaType: z.string().nullable(),
  resolutionsDpi: z.array(z.number().int().positive()),
  copiesMax: z.number().int().positive(),
  colour: PrinterColourSchema,
});
export type PrinterCapabilities = z.infer<typeof PrinterCapabilitiesSchema>;

export const PrinterIdSchema = z
  .string()
  .regex(/^(?:cups:[^/#?\s\p{Cc}]+|windows:[^\p{Cc}]+)$/u, 'not a printer');

export const PRINT_JOB_ID_MAX = 2 ** 31 - 1;
export const PRINT_COPIES_MAX = 999;

export const PrinterIccSchema = z.object({ icc: z.string() });

/** Null where the spooler took the print without saying which job it became. */
export const PrintJobIdSchema = z.object({
  jobId: z.number().int().min(0).max(PRINT_JOB_ID_MAX).nullable(),
});

/** Carried in the error details of a submit whose printer never confirmed it, so the print may still arrive. */
export const PrintUnconfirmedSchema = z.object({ printUnconfirmed: z.literal(true) });
export type PrintUnconfirmed = z.infer<typeof PrintUnconfirmedSchema>;

export const PrintJobStateSchema = z.object({
  state: z.enum(['pending', 'held', 'processing', 'stopped', 'canceled', 'aborted', 'completed']),
  reasons: z.array(z.string()),
});
export type PrintJobState = z.infer<typeof PrintJobStateSchema>;

export const PrintReplySchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  kind: z.enum(['invalid', 'missing', 'unavailable']).optional(),
});

/** A printer's own profile, read through the spooler, or an ICC file the reader added. */
export const ProfileRefSchema = z.object({
  from: z.enum(['printer', 'file']),
  name: z.string().min(1),
});
export type ProfileRef = z.infer<typeof ProfileRefSchema>;

export const ColourPathSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('profile'), bits: BitsSchema, profile: ProfileRefSchema }),
  z.object({ kind: z.literal('adobe-rgb'), bits: BitsSchema }),
  z.object({ kind: z.literal('srgb'), bits: BitsSchema }),
]);
export type ColourPath = z.infer<typeof ColourPathSchema>;

export function colourPath(colour: PrinterColour, chosen: ProfileRef | null): ColourPath {
  const device = deepest(colour, 'device');
  if (device != null && chosen != null) return { kind: 'profile', bits: device, profile: chosen };
  const adobe = deepest(colour, 'adobe-rgb');
  if (adobe != null) return { kind: 'adobe-rgb', bits: adobe };
  return { kind: 'srgb', bits: deepest(colour, 'srgb') ?? 8 };
}

function deepest(colour: PrinterColour, space: Transport['space']): Bits | null {
  const bits = colour.transports.filter((each) => each.space === space).map((each) => each.bits);
  if (bits.length === 0) return null;
  return bits.includes(16) ? 16 : 8;
}

export function transportOf(path: ColourPath): Transport {
  return { space: path.kind === 'profile' ? 'device' : path.kind, bits: path.bits };
}

const PAGE_EDGE_MAX_PX = 20000;
const PageEdgeSchema = z.number().int().positive().max(PAGE_EDGE_MAX_PX);

const PlaceSchema = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  width: PageEdgeSchema,
  height: PageEdgeSchema,
});

export const PrintRequestSchema = z.object({
  photoId: z.string(),
  printer: PrinterIdSchema,
  colour: ColourPathSchema,
  intent: RenderingIntentSchema,
  quarterTurns: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  job: z
    .object({
      name: z.string().max(255),
      media: z.string(),
      mediaType: z.string().nullable(),
      borderless: z.boolean(),
      copies: z.number().int().min(1).max(PRINT_COPIES_MAX),
      resolutionDpi: z.number().int().positive(),
      page: z.object({ widthPx: PageEdgeSchema, heightPx: PageEdgeSchema }),
      place: PlaceSchema,
    })
    .refine(
      ({ page, place }) =>
        place.x + place.width <= page.widthPx && place.y + place.height <= page.heightPx,
      { message: 'the photo is placed off the page', path: ['place'] },
    ),
});
export type PrintRequest = z.infer<typeof PrintRequestSchema>;

export const PrintSheetRequestSchema = z.object({
  photoId: z.string(),
  width: z.number().int().positive().max(12000),
  height: z.number().int().positive().max(12000),
});
export type PrintSheetRequest = z.infer<typeof PrintSheetRequestSchema>;
