export const AddReplicaStrings = {
  /** The dialog's title, and the button in Settings that opens it. */
  title: () => 'Connect to another Bowerbird',

  otherDevice: () => 'Other device',
  deviceAddress: () => 'Device address',
  deviceAddressPlaceholder: () => 'http://bowerbird.local:5173',
  addressHint: () => 'Connect both devices to the same network or VPN.',
  connecting: () => 'Connecting…',
  next: () => 'Next',

  librariesOn: (deviceName: string) => `Libraries on ${deviceName}`,
  clockSkew: (minutes: number) => `Your devices' clocks differ by ${minutes} minutes. Correct the time and try again.`,
  noLibraries: () => 'No libraries on that device',
  photoCount: (count: string, isOne: boolean) => `${count} ${isOne ? 'photo' : 'photos'}`,
  readOnly: () => ' · read-only, sync unavailable',
  alreadySynced: () => ' · already synced with another device',
  /** The wizard's previous step, which is not the way out of a page. */
  back: () => 'Back',

  folderOnThisDevice: () => 'Folder on this device',
  rootPlaceholder: () => '/photos/trip',
  folderHint: () => 'Choose a new or empty folder.',

  originals: () => 'Originals',

  settingUp: () => 'Setting up…',
  add: (libraryName: string) => `Add "${libraryName}"`,
};
