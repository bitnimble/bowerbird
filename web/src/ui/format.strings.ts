export const FormatStrings = {
  justNow: () => 'just now',
  minutesAgo: (minutes: number) => `${minutes} min ago`,
  hoursAgo: (hours: number) => `${hours} h ago`,
  daysAgo: (days: number) => `${days} ${days === 1 ? 'day' : 'days'} ago`,
  seconds: (seconds: number) => `${seconds} s`,
  minutes: (minutes: number) => `${minutes} min`,
  hours: (hours: number) => `${hours} h`,
  megabytes: (megabytes: string) => `${megabytes} MB`,
  kilobytes: (kilobytes: number) => `${kilobytes} KB`,
};
