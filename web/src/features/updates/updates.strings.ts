export const UpdatesStrings = {
  // The sidebar's badge. The version is the whole message: a reader who wants to know what
  // is in it clicks, and one who does not should not have to read a sentence.
  updateAvailable: (version: string) => `Update to ${version}`,

  whatsNew: () => "What's new",
  // Said in the dialog's head, under the title, so the cumulative changelog below has
  // somewhere to start from.
  fromVersion: (current: string, next: string) => `${current} → ${next}`,
  releasedOn: (when: string) => `Released ${when}`,

  updateNow: () => 'Update now',
  installing: () => 'Installing…',
  // Where the install cannot replace itself: a phone, or a container the reader pulls.
  download: () => 'Download',
  dockerPullHint: (image: string) => `Pull ${image} and recreate the container.`,

  checkNow: () => 'Check now',
  checking: () => 'Checking…',
  lastChecked: (when: string) => `Checked ${when}`,
  neverChecked: () => 'Not checked yet',
  // The one thing the page can say when the new version has not come back: everything
  // is installed, and the reader has to start the app again themselves.
  restartTookTooLong: () => "Bowerbird was updated but didn't restart. Open it again.",

  version: () => 'Version',
  updates: () => 'Updates',
};
