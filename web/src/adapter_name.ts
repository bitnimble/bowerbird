/**
 * The GPU as WebGPU names it: a vendor and an architecture rather than a card.
 *
 * `info` is typed as always there and is not - it arrived after `requestAdapter` did - so a
 * browser with WebGPU and without it reads as unreported instead of throwing.
 */
export function adapterName(adapter: GPUAdapter): string {
  const info = adapter.info as { vendor?: string; architecture?: string; device?: string } | undefined;
  return [info?.vendor, info?.architecture, info?.device].filter(Boolean).join(' / ') || 'unreported';
}
