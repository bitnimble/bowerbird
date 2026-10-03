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

export const PrinterIccSchema = z.object({ icc: z.base64() });

export const PrintJobIdSchema = z.object({ jobId: z.number().int() });

export const PrintJobStateSchema = z.object({
  state: z.enum(['pending', 'held', 'processing', 'stopped', 'canceled', 'aborted', 'completed']),
  reasons: z.array(z.string()),
});
export type PrintJobState = z.infer<typeof PrintJobStateSchema>;

/** Every printshim reply, before its outcome is read against the command's own schema. */
export const PrintReplySchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  outcome: z.unknown().optional(),
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

/** The best way this printer lets Bowerbird do the colour: matched to the paper, then Adobe RGB, then sRGB. */
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

const PlaceSchema = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const PrintRequestSchema = z.object({
  photoId: z.string(),
  printer: z.string(),
  colour: ColourPathSchema,
  intent: RenderingIntentSchema,
  quarterTurns: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  job: z.object({
    name: z.string(),
    media: z.string(),
    mediaType: z.string().nullable(),
    borderless: z.boolean(),
    copies: z.number().int().positive(),
    resolutionDpi: z.number().int().positive(),
    page: z.object({
      widthPx: z.number().int().positive(),
      heightPx: z.number().int().positive(),
    }),
    place: PlaceSchema,
  }),
});
export type PrintRequest = z.infer<typeof PrintRequestSchema>;

export const PrintSheetRequestSchema = z.object({
  photoId: z.string(),
  width: z.number().int().positive().max(12000),
  height: z.number().int().positive().max(12000),
});
export type PrintSheetRequest = z.infer<typeof PrintSheetRequestSchema>;
