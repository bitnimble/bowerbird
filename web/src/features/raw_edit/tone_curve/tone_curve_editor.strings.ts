export const ToneCurveEditorStrings = {
  heading: () => 'Tone curve',
  reset: () => 'Reset tone curve',
  blackPoint: () => 'Black point',
  whitePoint: () => 'White point',
  curvePoint: (index: number) => `Curve point ${index}`,
  pointPosition: (name: string, x: number, y: number) =>
    `${name}, ${Math.round(x * 100)}% input, ${Math.round(y * 100)}% output`,
};
