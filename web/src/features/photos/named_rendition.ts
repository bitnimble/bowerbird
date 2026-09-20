import { useEffect, useState } from 'react';
import { type ViewerRendition } from '../../../../src/schemas/settings';

// How long the stage says which rendition it has just been given.
const NAMED_RENDITION_MS = 1600;

/**
 * Whether to name the rendition on screen, which is true for a beat after the reader picks
 * one. Takes their own pick (`store.rendition`), never what is on screen: that also moves
 * when a row lands for a photograph opened cold, and when two neighbouring photographs
 * resolve differently - an album spanning a library that renders and one that does not - so
 * announcing on it named a rendition nobody had asked for, on a plain page load and on plain
 * steps.
 */
export function useNamedRendition(chosen: ViewerRendition | null): boolean {
  const [named, setNamed] = useState(false);
  useEffect(() => {
    // No pick is no label, and that has to be written rather than left alone: opening a
    // photograph clears the pick (`beginDetail`) an effect after this one first sees the
    // previous photo's, so the announcement is made and then has its timer cancelled under
    // it. Retracted here, the label goes with the choice it was naming.
    setNamed(chosen != null);
    if (chosen == null) return;
    const timer = setTimeout(() => setNamed(false), NAMED_RENDITION_MS);
    return () => clearTimeout(timer);
  }, [chosen]);
  return named;
}
