// Fetches the render benchmark's frame into `assets/`, from its release asset.
//
//   bun run get:reference-frame
import {
  fetchReferenceFrame,
  REFERENCE_FRAME,
} from '../src/services/processing/renditions/reference_frame';

await fetchReferenceFrame(REFERENCE_FRAME.path);
console.log(`reference frame at ${REFERENCE_FRAME.path}`);
