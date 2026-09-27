import { adapterName } from '../../adapter_name';
import { displayIsHdr } from '../../app/device';
import { WebCodecs } from '../photos/viewer/image_decoder';

export interface Diagnostics {
  display: string;
  browser: string;
  origin: string;
  adapter: string;
  hdrDisplay: boolean;
  imageDecoder: boolean;
  crossOriginIsolated: boolean;
  secureContext: boolean;
  sharedMemory: boolean;
}

/** What this page is running in, read on each call: a window dragged to another screen changes it. */
export async function readDiagnostics(): Promise<Diagnostics> {
  return {
    display: `${window.screen.width}x${window.screen.height} at ${window.devicePixelRatio}x`,
    browser: window.navigator.userAgent,
    origin: window.location.origin,
    adapter: await adapter(),
    hdrDisplay: displayIsHdr(),
    imageDecoder: WebCodecs != null,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    secureContext: globalThis.isSecureContext === true,
    sharedMemory: typeof SharedArrayBuffer === 'function',
  };
}

async function adapter(): Promise<string> {
  if (navigator.gpu == null) return 'no WebGPU';
  try {
    const found = await navigator.gpu.requestAdapter();
    return found == null ? 'no adapter' : adapterName(found);
  } catch {
    return 'no adapter';
  }
}
