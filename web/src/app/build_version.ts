import version from '../../../VERSION?raw';

/** The version this page and its wasm module were built as, which may differ from the server's on Android. */
export const BUILD_VERSION: string = version.trim();
