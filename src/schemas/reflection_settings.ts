import type { EditDoc } from './photo_edits';
import type { ReflectionStroke } from './stored_grid';

/** The reflection removal as the module takes it: the strength a gain from 0 to 2. */
export type ReflectionSettings = {
  enabled: boolean;
  strength: number;
  strokes: ReflectionStroke[];
};

export function reflectionSettings(doc: EditDoc | undefined): ReflectionSettings {
  return {
    enabled: doc?.reflectionRemoval ?? false,
    strength: (doc?.reflectionStrength ?? 100) / 100,
    strokes: doc?.reflectionStrokes ?? [],
  };
}
