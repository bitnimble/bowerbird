import { z } from 'zod';

export const LAMP_REACH = 10;
const LAMP_NEAREST = 1;

const lampAxis = z.number().min(-LAMP_REACH).max(LAMP_REACH);

/** How highlights are fitted under a white that cannot go higher: paper's, or an sRGB proof's. */
export const TonemapSchema = z.enum(['neutral', 'filmic', 'channel', 'local']);
export type Tonemap = z.infer<typeof TonemapSchema>;

export const PrintSceneSchema = z.object({
  paper: z.enum(['gloss', 'satin', 'matte']),
  tonemap: TonemapSchema,
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
export type PrintControl = Exclude<
  keyof PrintScene,
  'paper' | 'tonemap' | 'presentation' | 'framed' | 'zoom' | 'panX' | 'panY'
>;

export const PRINT_ZOOM_RANGE = { min: 1, max: 8 };

export const PRINT_FRAME_BORDER_SHARE = 0.125;

export function printDisplaySize(photo: { width: number; height: number }, framed: boolean): { width: number; height: number } {
  if (!framed) return photo;
  const border = Math.min(photo.width, photo.height) * PRINT_FRAME_BORDER_SHARE;
  return { width: photo.width + 2 * border, height: photo.height + 2 * border };
}

export const PAPER_MATERIALS = {
  gloss: { roughness: 0.08, whiteReflectance: 0.92, blackReflectance: 0.004, surfaceTexture: 0.15, refractiveIndex: 1.5 },
  satin: { roughness: 0.18, whiteReflectance: 0.9, blackReflectance: 0.008, surfaceTexture: 0.5, refractiveIndex: 1.5 },
  matte: { roughness: 0.65, whiteReflectance: 0.88, blackReflectance: 0.025, surfaceTexture: 0.85, refractiveIndex: 1.5 },
} satisfies Record<Paper, Pick<PrintScene, 'roughness' | 'whiteReflectance' | 'blackReflectance' | 'surfaceTexture' | 'refractiveIndex'>>;

export const DEFAULT_PRINT_SCENE: PrintScene = {
  paper: 'satin',
  tonemap: 'neutral',
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
};

/** Where a control goes back to: the chosen paper's own value for a paper's controls, the default scene's for the rest. */
export function restingValue(paper: Paper, control: PrintControl): number {
  return { ...DEFAULT_PRINT_SCENE, ...PAPER_MATERIALS[paper] }[control];
}
