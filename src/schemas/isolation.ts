/**
 * What makes the app cross-origin isolated, which a browser requires before it hands a page
 * `SharedArrayBuffer`: Safari's AV1 decoder (`web/src/avif`) and Firefox's VP9 encoder
 * (`web/src/vp9`) run their threads on shared memory.
 * Sent on every response, since a worker is only isolated if its own script says so too.
 */
export const CROSS_ORIGIN_ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
} as const;
