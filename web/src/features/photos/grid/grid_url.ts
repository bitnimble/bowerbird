// What a reload brings back and a fresh visit does not: where the reader had got
// to, and the question they were narrowing the collection with. The other half of
// how a collection is being looked at - the one a knob is *set* to rather than
// asked in the moment - is `view_state`, saved per device.
import type { PhotoFilters } from './photo_filters';

/** The filters that travel in the URL; the rest of `PhotoFilters` is saved per device. */
export type AskedFilters = Pick<PhotoFilters, 'search' | 'takenFrom' | 'takenTo'>;

export interface GridUrl {
  /** Position of the photo the viewport starts on, or 0 for the top. */
  at: number;
  filters: AskedFilters;
}

const AT = 'at';
const SEARCH = 'q';
const FROM = 'from';
const TO = 'to';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function readGridUrl(search: string): GridUrl {
  const params = new URLSearchParams(search);
  const at = Number(params.get(AT));
  const day = (name: string): string | undefined => {
    const value = params.get(name);
    // Hand-edited: a date the calendar cannot parse would reach it as an Invalid
    // Date, and reach the server as a range it has no answer for.
    return value != null && DAY.test(value) ? value : undefined;
  };
  return {
    at: Number.isFinite(at) && at > 0 ? Math.floor(at) : 0,
    filters: { search: params.get(SEARCH) ?? undefined, takenFrom: day(FROM), takenTo: day(TO) },
  };
}

/** Whether a URL asks anything of the collection, and so has a filter to restore. */
export function asksAnything(filters: AskedFilters): boolean {
  return (filters.search ?? '') !== '' || filters.takenFrom != null || filters.takenTo != null;
}

export function gridUrlHref(href: string, state: GridUrl): string {
  const url = new URL(href);
  const put = (name: string, value: string | undefined): void => {
    if (value == null || value === '') url.searchParams.delete(name);
    else url.searchParams.set(name, value);
  };
  put(AT, state.at > 0 ? String(state.at) : undefined);
  put(SEARCH, state.filters.search);
  put(FROM, state.filters.takenFrom);
  put(TO, state.filters.takenTo);
  return url.href;
}
