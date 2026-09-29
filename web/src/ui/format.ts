import { FormatStrings } from './format.strings';

// "3 minutes ago" answers "is my catalogue stale?" at a glance; a timestamp does not.
export function relativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return FormatStrings.justNow();
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return FormatStrings.minutesAgo(minutes);
  const hours = Math.round(minutes / 60);
  if (hours < 24) return FormatStrings.hoursAgo(hours);
  return FormatStrings.daysAgo(Math.round(hours / 24));
}

export function durationLabel(seconds: number): string {
  if (seconds < 60) return FormatStrings.seconds(Math.max(1, Math.round(seconds)));
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return FormatStrings.minutes(minutes);
  return FormatStrings.hours(Math.round(minutes / 60));
}

export function fileSizeLabel(bytes: number): string {
  const tb = bytes / 1024 ** 4;
  if (tb >= 1) return FormatStrings.terabytes(tb.toFixed(1));
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return FormatStrings.gigabytes(gb.toFixed(1));
  const mb = bytes / (1024 * 1024);
  return mb >= 1
    ? FormatStrings.megabytes(mb.toFixed(1))
    : FormatStrings.kilobytes(Math.round(bytes / 1024));
}
