export interface PrintRenderTarget {
  space: 'srgb' | 'adobe-rgb' | 'device';
  bits: 8 | 16;
  intent: 'perceptual' | 'relative';
  blackPointCompensation: boolean;
  icc: Uint8Array | null;
  width: number;
  height: number;
  quarterTurns: 0 | 1 | 2 | 3;
}

export async function renderPrint(
  _photoId: string,
  _target: PrintRenderTarget,
  _outputPath: string,
): Promise<void> {
  throw new Error('not built yet');
}
