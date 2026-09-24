import { z } from 'zod';
import { RenderingIntentSchema } from '../../../../../src/schemas/rendering_intent';

export const LAMP_REACH = 10;
const LAMP_NEAREST = 1;

const lampAxis = z.number().min(-LAMP_REACH).max(LAMP_REACH);

export const PrintSceneSchema = z.object({
  paper: z.enum(['gloss', 'satin', 'matte']),
  renderingIntent: RenderingIntentSchema.default('perceptual'),
  blackPointCompensation: z.boolean().default(true),
  ink: z.enum(['dye', 'pigment']).default('dye'),
  printResolutionPpi: z.number().min(72).max(1200),
  inkSpreadMicrons: z.number().min(0).max(200),
  presentation: z.enum(['scene', 'surface', 'flat']),
  framed: z.boolean().default(false),
  yawDegrees: z.number().min(-180).max(180),
  pitchDegrees: z.number().min(-85).max(85),
  keyLux: z.number().min(0).max(10000),
  lightAcross: lampAxis,
  lightHeight: lampAxis,
  lightForward: lampAxis,
  lightAngularDegrees: z.number().min(0.1).max(90),
  fillLux: z.number().min(0).max(10000),
  lightTemperatureKelvin: z.number().min(2000).max(10000),
  roughness: z.number().min(0.03).max(1),
  whiteReflectance: z.number().min(0.5).max(0.99),
  blackReflectance: z.number().min(0.001).max(0.2),
  refractiveIndex: z.number().min(1).max(2),
  paperLongEdgeMm: z.number().min(50).max(1000),
  surfaceTexture: z.number().min(0).max(1),
  zoom: z.number().min(1).max(8),
  panX: z.number().min(-1).max(1),
  panY: z.number().min(-1).max(1),
}).refine(
  (scene) => Math.hypot(scene.lightAcross, scene.lightHeight, scene.lightForward) >= LAMP_NEAREST,
  { message: `The lamp must hang at least ${LAMP_NEAREST} print length from the sheet` },
);

export type PrintScene = z.infer<typeof PrintSceneSchema>;
export type Paper = PrintScene['paper'];
export type Presentation = PrintScene['presentation'];
export type Ink = PrintScene['ink'];
export type PrintControl = Exclude<
  keyof PrintScene,
  'paper' | 'renderingIntent' | 'blackPointCompensation' | 'ink' | 'presentation' | 'framed' | 'zoom' | 'panX' | 'panY'
>;

export const PRINT_ZOOM_RANGE = { min: 1, max: 8 };

export const PRINT_FRAME_BORDER_SHARE = 0.125;

export function printDisplaySize(photo: { width: number; height: number }, framed: boolean): { width: number; height: number } {
  if (!framed) return photo;
  const border = Math.min(photo.width, photo.height) * PRINT_FRAME_BORDER_SHARE;
  return { width: photo.width + 2 * border, height: photo.height + 2 * border };
}

export const PAPER_MATERIALS = {
  gloss: { roughness: 0.16, whiteReflectance: 0.95, blackReflectance: 0.003, surfaceTexture: 0, refractiveIndex: 1.25 },
  satin: { roughness: 0.28, whiteReflectance: 0.95, blackReflectance: 0.002, surfaceTexture: 0.08, refractiveIndex: 1.25 },
  matte: { roughness: 0.84, whiteReflectance: 0.92, blackReflectance: 0.0035, surfaceTexture: 0, refractiveIndex: 1.5 },
} satisfies Record<Paper, Pick<PrintScene, 'roughness' | 'whiteReflectance' | 'blackReflectance' | 'surfaceTexture' | 'refractiveIndex'>>;

/**
 * A landed drop's radius and the paper's own light scatter together: a 3 pl dye drop lands 37 µm
 * across on RC gloss, pigment tighter, and the coat's scatter reaches 52 µm on gloss and 25 µm on
 * matte (Koopipat et al., PICS 2000).
 */
export const INK_SPREAD_MICRONS = {
  dye: { gloss: 55, satin: 55, matte: 40 },
  pigment: { gloss: 50, satin: 50, matte: 35 },
} satisfies Record<Ink, Record<Paper, number>>;

export const DEFAULT_PRINT_SCENE: PrintScene = {
  paper: 'satin',
  renderingIntent: 'perceptual',
  blackPointCompensation: true,
  ink: 'dye',
  printResolutionPpi: 600,
  presentation: 'scene',
  framed: false,
  yawDegrees: -12,
  pitchDegrees: 8,
  keyLux: 1000,
  lightAcross: 0,
  lightHeight: 3.9,
  lightForward: 1.7,
  lightAngularDegrees: 1,
  fillLux: 500,
  lightTemperatureKelvin: 6500,
  paperLongEdgeMm: 300,
  zoom: 1,
  panX: 0,
  panY: 0,
  ...PAPER_MATERIALS.satin,
  inkSpreadMicrons: INK_SPREAD_MICRONS.dye.satin,
};

/** What the paper and the ink bring with them, which choosing either sets. */
export function paperAndInk(paper: Paper, ink: Ink): Pick<PrintScene, 'paper' | 'ink' | keyof typeof PAPER_MATERIALS.satin | 'inkSpreadMicrons'> {
  return { paper, ink, ...PAPER_MATERIALS[paper], inkSpreadMicrons: INK_SPREAD_MICRONS[ink][paper] };
}

/** Where a control goes back to: the chosen paper's or ink's own value for theirs, the default scene's for the rest. */
export function restingValue(scene: Pick<PrintScene, 'paper' | 'ink'>, control: PrintControl): number {
  return { ...DEFAULT_PRINT_SCENE, ...paperAndInk(scene.paper, scene.ink) }[control];
}
