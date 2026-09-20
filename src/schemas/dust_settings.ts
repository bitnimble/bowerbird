import type { EditDoc } from './photo_edits';

/** `crate::dust::Settings`: the switch, and the two positions as the fractions a shader reads. */
export type DustSettings = {
  enabled: boolean;
  sensitivity: number;
  intensity: number;
};

/**
 * The document's dust three in the units the module takes.
 *
 * **The one conversion on the edit path, so it lives once.** Everything else in `EditDoc` is
 * carried to the far side untouched - even the exposure, whose `2^EV` would otherwise be computed
 * here and again in the editor - because a rule with an implementation on each path is the kind that fails
 * quietly, both answers being plausible pictures. These two are positions the panel shows and
 * fractions the kernel wants, so the scaling has to happen somewhere; here is the somewhere, and
 * both the rendition worker and the editor's open call it.
 *
 * Its own module rather than `photo_edits.ts` for the reason `display_size.ts` is: that one imports
 * zod, which the page keeps out of its bundle, and this is on the page's side of the boundary.
 */
export function dustSettings(doc: EditDoc | undefined): DustSettings {
  return {
    enabled: doc?.dustRemoval ?? true,
    sensitivity: (doc?.dustSensitivity ?? 25) / 100,
    intensity: (doc?.dustIntensity ?? 100) / 100,
  };
}
