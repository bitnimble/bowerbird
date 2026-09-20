const OPTIONS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
};

// Server-side instants are genuinely UTC, so they are shown in the viewer's own
// zone: "when did this happen to me" is read against the clock on the wall here.
const FORMAT = new Intl.DateTimeFormat(undefined, OPTIONS);

// A capture time is not an instant: EXIF carries no zone, so ingest stores the
// camera's wall clock re-encoded as UTC (§11.1). Reading it back in the viewer's
// zone would slide every photo by that offset - a Sydney afternoon frame reads
// as 4am - so it is formatted in UTC and comes out exactly as the camera wrote it.
const CAPTURE_FORMAT = new Intl.DateTimeFormat(undefined, { ...OPTIONS, timeZone: 'UTC' });

function format(formatter: Intl.DateTimeFormat, iso: string | null): string | null {
  if (iso == null) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : formatter.format(date);
}

export function localDateTime(iso: string | null): string | null {
  return format(FORMAT, iso);
}

export function captureDateTime(iso: string | null): string | null {
  return format(CAPTURE_FORMAT, iso);
}
