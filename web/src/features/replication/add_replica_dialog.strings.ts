export const AddReplicaStrings = {
  /** The dialog's title, and the button in Settings that opens it. */
  title: () => 'Connect to another device',

  otherDevice: () => 'Other device',
  deviceAddress: () => 'Device address',
  deviceAddressPlaceholder: () => 'bowerbird.local:5173',
  addressHint: () => 'Connect both devices to the same network or VPN.',
  connecting: () => 'Connecting…',
  next: () => 'Next',

  librariesOn: (deviceName: string) => `Libraries on ${deviceName}`,
  clockSkew: (minutes: number) =>
    `Your devices' clocks differ by ${minutes} minutes. Correct the time and try again.`,
  noLibraries: () => 'No libraries on that device',
  photoCount: (count: string, isOne: boolean, readOnly: boolean) =>
    `${count} ${isOne ? 'photo' : 'photos'}${readOnly ? ' · read-only' : ''}`,
  alreadyHere: () => 'Already on this device',
  /** The wizard's previous step, which is not the way out of a page. */
  back: () => 'Back',

  configure: () => 'Configure',
  configured: () => 'Configured',
  added: () => 'Added',

  chooseFolder: () => 'Select a folder on this device for this library.',
  rootPlaceholder: () => '/photos/trip',

  save: () => 'Save',
  settingUp: () => 'Setting up…',
  add: (libraryName: string) => `Add "${libraryName}"`,
  finish: () => 'Finish',
};
