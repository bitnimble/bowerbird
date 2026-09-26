import { shellInvoke } from '../api/transport';

/** The macOS app, whose traffic lights are drawn over the window's top left corner. */
export const HAS_TRAFFIC_LIGHTS = shellInvoke() != null && navigator.userAgent.includes('Mac');

/** Lets a header drag the window where the app has no title bar; buttons in it still take clicks. */
export const DRAGS_WINDOW: { 'data-tauri-drag-region'?: 'deep' } = HAS_TRAFFIC_LIGHTS
  ? { 'data-tauri-drag-region': 'deep' }
  : {};
