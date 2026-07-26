import type { Ordering } from '../../api/client';
import type { PhotoFilters, PhotoSource, ViewMode } from './photos_store';

// How a collection was last being looked at. Persisted per collection, so
// returning to a shoot finds the sort, filter and tile size you left it with.
export interface ViewState {
  ordering: Ordering;
  filters: PhotoFilters;
  thumbSize: number;
  mode: ViewMode;
}

const PREFIX = 'bowerbird.view.';

function key(source: PhotoSource): string {
  switch (source.kind) {
    case 'library':
      return `${PREFIX}library.${source.libraryId}`;
    case 'shoot':
      return `${PREFIX}shoot.${source.shootId}`;
    case 'album':
      return `${PREFIX}album.${source.albumId}`;
    case 'bin':
      return `${PREFIX}bin.${source.libraryId}`;
    case 'missing':
      return `${PREFIX}missing.${source.libraryId}`;
  }
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
      ...(typeof parsed.ordering === 'string' ? { ordering: parsed.ordering } : {}),
      ...(parsed.filters != null && typeof parsed.filters === 'object' ? { filters: durable(parsed.filters) } : {}),
      ...(typeof parsed.thumbSize === 'number' && parsed.thumbSize > 0 ? { thumbSize: parsed.thumbSize } : {}),
      ...(parsed.mode === 'grid' || parsed.mode === 'masonry' || parsed.mode === 'list' ? { mode: parsed.mode } : {}),
    };
  } catch {
    return null;
  }
}
