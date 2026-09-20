import { readSetting, writeSetting } from '../../app/local_setting';
import { sourceKey, type PhotoSource, type ViewMode } from './photos_store';
import type { PhotoFilters } from './grid/photo_filters';

// How a collection was last being looked at, on this device. Deliberately not
// the sort: that belongs to the collection and is stored with it, so it follows
// you to the next browser (§18.3.1). What is left is genuinely about the machine
// you are sitting at - how big the tiles are on this screen, which layout, what
// the tiles say, and the filter you were last narrowing by.
export interface ViewState {
  filters: PhotoFilters;
  tileSize: number;
  mode: ViewMode;
  expandStacks: boolean;
  showFilenames: boolean;
  showTriage: boolean;
  showRating: boolean;
}

const PREFIX = 'bowerbird.view.';

function key(source: PhotoSource): string {
  return PREFIX + sourceKey(source);
}

// A search or a date range is a question you were asking in the moment, not a
// property of how you like to view the collection, so neither is carried across.
function durable(filters: PhotoFilters): PhotoFilters {
  const { search: _search, takenFrom: _from, takenTo: _to, ...rest } = filters;
  return rest;
}

export function saveViewState(source: PhotoSource, state: ViewState): void {
  writeSetting(key(source), JSON.stringify({ ...state, filters: durable(state.filters) }));
}

export function loadViewState(source: PhotoSource): Partial<ViewState> | null {
  const raw = readSetting(key(source));
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ViewState>;
    // Hand-edited or written by an older version: take only what is usable
    // rather than letting a bad shape break opening the collection.
    return {
      ...(parsed.filters != null && typeof parsed.filters === 'object' ? { filters: durable(parsed.filters) } : {}),
      ...(typeof parsed.tileSize === 'number' && parsed.tileSize > 0 ? { tileSize: parsed.tileSize } : {}),
      ...(parsed.mode === 'grid' || parsed.mode === 'masonry' || parsed.mode === 'list' ? { mode: parsed.mode } : {}),
      ...(typeof parsed.expandStacks === 'boolean' ? { expandStacks: parsed.expandStacks } : {}),
      ...(typeof parsed.showFilenames === 'boolean' ? { showFilenames: parsed.showFilenames } : {}),
      ...(typeof parsed.showTriage === 'boolean' ? { showTriage: parsed.showTriage } : {}),
      ...(typeof parsed.showRating === 'boolean' ? { showRating: parsed.showRating } : {}),
    };
  } catch {
    return null;
  }
}
