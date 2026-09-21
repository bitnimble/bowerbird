import { z } from 'zod';

export const PrintSceneSchema = z.object({
  paper: z.enum(['gloss', 'satin', 'matte']),
  presentation: z.enum(['scene', 'surface']),
  yawDegrees: z.number().min(-180).max(180),
  pitchDegrees: z.number().min(-85).max(85),
  keyLux: z.number().min(0).max(10000),
  lightAzimuthDegrees: z.number().min(-180).max(180),
  lightElevationDegrees: z.number().min(-85).max(85),
  lightAngularDegrees: z.number().min(1).max(90),
  fillLux: z.number().min(0).max(10000),
  lightTemperatureKelvin: z.number().min(2000).max(10000),
  roughness: z.number().min(0.03).max(1),
  whiteReflectance: z.number().min(0.5).max(0.99),
  blackReflectance: z.number().min(0.001).max(0.2),
  refractiveIndex: z.number().min(1).max(2),
  lightDistance: z.number().min(1).max(20),
  paperLongEdgeMm: z.number().min(50).max(1000),
  surfaceTexture: z.number().min(0).max(1),
});

export type PrintScene = z.infer<typeof PrintSceneSchema>;
export type Paper = PrintScene['paper'];
export type PrintControl = Exclude<keyof PrintScene, 'paper' | 'presentation'>;

export const PAPER_MATERIALS = {
  gloss: { roughness: 0.08, whiteReflectance: 0.92, blackReflectance: 0.004, surfaceTexture: 0.15 },
  satin: { roughness: 0.28, whiteReflectance: 0.9, blackReflectance: 0.008, surfaceTexture: 0.5 },
  matte: { roughness: 0.65, whiteReflectance: 0.88, blackReflectance: 0.025, surfaceTexture: 0.85 },
} satisfies Record<Paper, Pick<PrintScene, 'roughness' | 'whiteReflectance' | 'blackReflectance' | 'surfaceTexture'>>;

export const DEFAULT_PRINT_SCENE: PrintScene = {
  paper: 'satin',
  presentation: 'scene',
  yawDegrees: -12,
  pitchDegrees: 8,
  keyLux: 1000,
  lightAzimuthDegrees: 0,
  lightElevationDegrees: 75,
  lightAngularDegrees: 30,
  fillLux: 500,
  lightTemperatureKelvin: 6500,
  refractiveIndex: 1.5,
  lightDistance: 4,
  paperLongEdgeMm: 300,
  ...PAPER_MATERIALS.satin,
};
