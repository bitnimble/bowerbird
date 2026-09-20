import { type PhotoDaysResponse, type PhotoModelsResponse, type Triage } from '../../../../../src/schemas/photos';
import type { PhotoSource } from '../photos_store';

// What the user narrowed the view to. Separate from PhotoSource: the source is
// which collection, this is which slice of it.
export interface PhotoFilters {
  rated?: boolean;
  triage?: Triage[];
  isMissing?: boolean;
  // Ticked, the photographs put away join the grid rather than replacing what is in it: a chip
  // like its neighbours, so "hidden or picks" holds both. Only ever true - hiding is the default
  // every other tick is read against, so there is nothing to ask for by unticking it.
  isHidden?: boolean;
  search?: string;
  // Inclusive YYYY-MM-DD bounds from the calendar.
  takenFrom?: string;
  takenTo?: string;
  // Bodies and lenses ticked in the filter menu, spelled as the RAW header
  // spelled them. Several of either is any of them.
  cameraModels?: string[];
  lensModels?: string[];
  // 'any' is what the filter panel sends: picking "picks, unrated and missing"
  // means a photo that is any of those, which as an intersection is empty.
  match?: 'all' | 'any';
}

export type ModelPair = PhotoModelsResponse['pairs'][number];
export type PhotoDay = PhotoDaysResponse['days'][number];

/**
 * Each day's count as a 0..1 weight against the busiest day in the collection, for the
 * calendar to shade a dot by.
 *
 * Logarithmic, not linear: a single day of a burst-shot event runs to hundreds of frames
 * where an ordinary day is five, and dividing by that flattens every ordinary day to the
 * same invisible dot. The busiest day is 1 and the quietest is above 0, so a day that
 * holds anything shows something.
 */
export function dayDensities(days: readonly PhotoDay[]): Map<string, number> {
  const top = Math.log(Math.max(...days.map((day) => day.count), 1) + 1);
  return new Map(days.map((day) => [day.day, Math.log(day.count + 1) / top]));
}

/**
 * The models on one side of the pairing that were photographed with any of `partners`
 * on the other - every one of them when nothing on that side is ticked.
 *
 * One copy for both the greying and the trimming that follows an untick: a second would
 * be a row the menu offers and the presenter then takes away.
 */
export function reachableModels(pairs: readonly ModelPair[], side: keyof ModelPair, partners: readonly string[]): Set<string> {
  const other: keyof ModelPair = side === 'camera_model' ? 'lens_model' : 'camera_model';
  const reached = new Set<string>();
  for (const pair of pairs) {
    const value = pair[side];
    if (value == null) continue;
    const against = pair[other];
    if (partners.length === 0 || (against != null && partners.includes(against))) reached.add(value);
  }
  return reached;
}

export function distinctSorted(values: (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => value != null))].sort((a, b) => a.localeCompare(b));
}

// A gallery opens on the working set: everything not yet rejected. Rejecting is
// a decision to stop seeing a frame, so it should leave the view at once. Lives
// here so the presenter's opening state and the "Active" chip cannot disagree.
export function activeFilters(): PhotoFilters {
  return { triage: ['untriaged', 'picked'] };
}

// What a collection is looked at with before anyone has narrowed it, which is both where
// it opens and what Reset puts back. The Bin and the missing view are already a specific
// slice, so a verdict default there would fight the thing the reader opened.
export function openingFilters(source: PhotoSource | null): PhotoFilters {
  return source?.kind === 'bin' || source?.kind === 'missing' ? {} : activeFilters();
}
