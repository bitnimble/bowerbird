import { shellInvoke } from '../api/transport';

/** The macOS app, whose traffic lights are drawn over the window's top left corner. */
export const HAS_TRAFFIC_LIGHTS = shellInvoke() != null && navigator.userAgent.includes('Mac');

/** The Windows app, which has no title bar and draws `CaptionButtons` over the window's top right corner. */
export const HAS_CAPTION_BUTTONS = shellInvoke() != null && navigator.userAgent.includes('Windows');

/** Lets a header drag the window where the app has no title bar; buttons in it still take clicks. */
export const DRAGS_WINDOW: { 'data-tauri-drag-region'?: 'deep' } =
  HAS_TRAFFIC_LIGHTS || HAS_CAPTION_BUTTONS ? { 'data-tauri-drag-region': 'deep' } : {};
