/**
 * What the picture on screen stands in for: the library's HDR rendition, its sRGB one, or the print.
 *
 * `print` is the pigment on the paper as a soft proof, drawn through the ordinary view; `print3d` is
 * the sheet itself, turned in a lit room.
 */
export type SoftProof = 'hdr' | 'srgb' | 'print' | 'print3d';

export const SOFT_PROOFS: readonly SoftProof[] = ['hdr', 'srgb', 'print', 'print3d'];

export function isSoftProof(value: string | null): value is SoftProof {
  return SOFT_PROOFS.some((proof) => proof === value);
}

export function isPrintProof(proof: SoftProof): boolean {
  return proof === 'print' || proof === 'print3d';
}
