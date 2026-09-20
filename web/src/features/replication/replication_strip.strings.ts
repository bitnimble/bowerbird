export const ReplicationStripStrings = {
  neverSynced: () => 'Never synced',
  syncedAt: (relative: string) => `Synced ${relative}`,
  deviceLine: (name: string, when: string) => `${name} · ${when}`,
  deviceError: (error: string) => ` · ${error}`,
  sending: (count: number) => ` · sending ${count}`,
  fetching: (count: number) => ` · fetching ${count}`,
  failed: (count: number) => ` · ${count} failed`,

  sendOriginals: () => 'Send originals',
  sendOriginalsTitle: (name: string) => `Queue the originals ${name} lacks`,
  sendOriginalsRefused: (name: string) => `${name} keeps the catalogue only`,

  fetchOriginals: () => 'Fetch originals',
  fetchOriginalsTitle: (name: string) => `Queue the originals ${name} holds that this device lacks`,
  fetchOriginalsRefused: () => 'Turn on "Keep originals on this device" first.',

  stopSyncing: () => 'Stop syncing',
  stopSyncingTitle: (name: string) => `Stop syncing with ${name}. Your files stay where they are.`,
  stopSyncingWarning: (libraryName: string, deviceName: string, sole: number) =>
    `Stop syncing "${libraryName}" with ${deviceName}?\n\n` +
    (sole === 0
      ? 'Your files stay where they are. You can pair them again.'
      : `${sole} ${sole === 1 ? 'photo exists' : 'photos exist'} only on ${deviceName}. Fetch the originals before you stop syncing. Your files stay where they are.`),
};
