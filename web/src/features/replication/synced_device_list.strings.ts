import { plural } from '../photos/photos_presenter.strings';

export const SyncedDeviceListStrings = {
  neverSynced: () => 'Never synced',
  syncedAt: (relative: string) => `Synced ${relative}`,
  deviceError: () => " · couldn't sync",
  deviceErrorTitle: () => "We couldn't sync with this device. Try again.",
  updatePeer: (name: string) => ` · update Bowerbird on ${name} to sync`,
  updateThisDevice: () => ' · update Bowerbird on this device to sync',
  sending: (count: number) => ` · sending ${count}`,
  fetching: (count: number) => ` · fetching ${count}`,
  failed: (count: number) => ` · ${count} failed`,

  syncRaws: () => 'Sync RAWs',
  syncRawsTitle: () => 'Send and fetch the RAWs either device lacks',
  cannotReach: (name: string) => `${name} connects to this device, so only it can sync RAWs.`,

  removeDevice: () => 'Remove device',
  removeDeviceTitle: (name: string) => `Stop syncing with ${name}. Your files stay where they are.`,
  removeDeviceQuestion: (libraryName: string, deviceName: string) =>
    `Remove ${deviceName} from "${libraryName}"?`,
  remove: () => 'Remove',
  removeDeviceWarning: (deviceName: string, sole: number) =>
    sole === 0
      ? 'Your files stay where they are. You can pair them again.'
      : `${plural(sole, 'photo exists', 'photos exist')} only on ${deviceName}. Sync RAWs before you remove it. Your files stay where they are.`,
};
