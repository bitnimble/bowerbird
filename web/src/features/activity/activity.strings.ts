import type { Activity, ActivityKind } from '../../../../src/schemas/activity';

const labels: Record<ActivityKind, (count: number) => string> = {
  syncing: () => 'syncing',
  fetching: () => 'fetching',
  sending: (count) => `sending ${count} ${count === 1 ? 'original' : 'originals'}`,
  sending_renditions: () => 'sending renditions',
  sending_to_tv: (count) => `sending ${count} ${count === 1 ? 'photo' : 'photos'} to TV`,
  receiving: () => 'receiving originals',
  backing_up: () => 'backing up originals',
  restoring_backup: () => 'fetching originals from backup',
  rendering: (count) => `rendering ${count} ${count === 1 ? 'photo' : 'photos'}`,
  local_rendering: (count) => `rendering ${count} ${count === 1 ? 'photo' : 'photos'} on this device`,
  preparing: (count) => `preparing ${count} ${count === 1 ? 'photo' : 'photos'}`,
  merging: () => 'merging photos',
  exporting: (count) => `exporting ${count} ${count === 1 ? 'photo' : 'photos'}`,
  sharing: () => 'preparing photos to share',
  refreshing_metadata: () => 'refreshing photo details',
  grouping: () => 'grouping similar photos',
  checking_files: () => 'checking files',
  reconciling: () => 'checking local copies',
  offloading: () => 'removing local copies',
  catalogue_backup: () => 'backing up catalogue',
  pruning: () => 'cleaning up generated files',
  measuring: () => 'measuring rendition stages',
  checking_quality: () => 'checking image quality',
};

export const ActivityStrings = {
  label: ({ kind, count }: Activity) => labels[kind](count),
};
