/** What the Android shell appends to its WebView's user agent on a television. */
export const TV_AGENT = 'BowerbirdTV';

/** The page's handler for the remote's Back, which the shell calls and leaves the app on false. */
export const TV_BACK = 'bowerbirdBack';

declare global {
  interface Window {
    [TV_BACK]?: () => boolean;
  }
}

export const TV_CONTROLS_SHOWN_MS = 5000;

export function onTv(): boolean {
  return globalThis.navigator?.userAgent.includes(TV_AGENT) === true;
}
