// Timestamps arrive as UTC ISO strings and are shown in the viewer's own zone:
// a capture time is only meaningful against the clock the reader is reading by.
const FORMAT = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export function localDateTime(iso: string | null): string | null {
  if (iso == null) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : FORMAT.format(date);
}
