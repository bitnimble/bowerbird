import { sourceKey, type PhotoFilters, type PhotoSource, type ViewMode } from './photos_store';

// How a collection was last being looked at, on this device. Deliberately not
// the sort: that belongs to the collection and is stored with it, so it follows
// you to the next browser (§18.3.1). What is left is genuinely about the machine
// you are sitting at - how big the tiles are on this screen, which layout, and
// the filter you were last narrowing by.
export interface ViewState {
  filters: PhotoFilters;
  tileSize: number;
  mode: ViewMode;
  expandStacks: boolean;
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
  try {
    localStorage.setItem(key(source), JSON.stringify({ ...state, filters: durable(state.filters) }));
  } catch {
    // Private browsing or a full quota. Losing the preference is not worth an error.
  }
}

export function loadViewState(source: PhotoSource): Partial<ViewState> | null {
  try {
    const raw = localStorage.getItem(key(source));
    if (raw == null) return null;
    const parsed = JSON.parse(raw) as Partial<ViewState>;
    // Hand-edited or written by an older version: take only what is usable
    // rather than letting a bad shape break opening the collection.
    return {
      ...(parsed.filters != null && typeof parsed.filters === 'object' ? { filters: durable(parsed.filters) } : {}),
      ...(typeof parsed.tileSize === 'number' && parsed.tileSize > 0 ? { tileSize: parsed.tileSize } : {}),
      ...(parsed.mode === 'grid' || parsed.mode === 'masonry' || parsed.mode === 'list' ? { mode: parsed.mode } : {}),
      ...(typeof parsed.expandStacks === 'boolean' ? { expandStacks: parsed.expandStacks } : {}),
    };
  } catch {
    return null;
  }
}
