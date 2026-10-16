import MODULE_ENTRY from '../../../../native/rawshim/pkg/rawshim.js?raw';
import IMPORT_WGSL from '../photos/generated/stage_import.wgsl?raw';
import PLANAR_WGSL from '../photos/generated/stage.wgsl?raw';
import READBACK_WGSL from '../photos/generated/readback.wgsl?raw';
import { hashOf } from '../../hash_of';

/**
 * Moves whenever a pipeline the precompile builds could: the decoder module's entry names its
 * content-hashed build (`hash-pkg.ts`), and the rest are the page's own shaders.
 */
export const PIPELINES_VERSION: string = hashOf(
  [MODULE_ENTRY, IMPORT_WGSL, PLANAR_WGSL, READBACK_WGSL].join('\0'),
);
