function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export const ReplicationPresenterStrings = {
  couldNotReadDevices: () => "We couldn't load this library's devices. Try again.",
  couldNotChangeWhatIsKept: () => "We couldn't change what this device keeps. Try again.",
  stoppedIncoming: (cancelled: number) =>
    `Stopped ${plural(cancelled, 'original', 'originals')} that were still on their way here.`,
  couldNotRenameDevice: () => "We couldn't rename that device. Try again.",
  couldNotWorkOutSoleHoldings: (name: string) => `We couldn't check which originals ${name} holds. Try again.`,
  couldNotForget: (name: string) => `We couldn't stop syncing with ${name}. Try again.`,
  couldNotWorkOutAddress: () => "We couldn't find this device's address. Check its network connection.",
  syncedLibraryAdded: (applied: number) => `Synced library added with ${plural(applied, 'change', 'changes')} so far.`,
  noDeviceReachable: () => "We couldn't reach another device. Check its network connection.",
  couldNotSync: () => "We couldn't sync this library. Try again.",
  couldNotReadConflicts: () => "We couldn't load edits from both devices. Try again.",
  couldNotResolveConflicts: () => "We couldn't save your chosen edits. Try again.",

  otherDeviceHoldsEverything: (name: string) => `${name} already holds every original this device has.`,
  queuedToSend: (queued: number, name: string) => `Queued ${plural(queued, 'original', 'originals')} to send to ${name}.`,
  couldNotQueueForDevice: (name: string) => `We couldn't queue originals for ${name}. Try again.`,

  thisDeviceHoldsEverything: (name: string) => `This device already holds every original ${name} has.`,
  queuedToFetch: (queued: number, name: string) => `Queued ${plural(queued, 'original', 'originals')} to fetch from ${name}.`,
  couldNotQueueFromDevice: (name: string) => `We couldn't queue originals from ${name}. Try again.`,

  couldNotRemoveLocalCopies: () => "We couldn't remove those local copies. Try again.",
  removedLocalCopies: (gone: number, name: string) => `Removed ${plural(gone, 'local copy', 'local copies')}; originals remain on ${name}.`,
  noneConfirmed: (name: string, refused: number) => `${name} could not confirm a copy of ${plural(refused, 'photo', 'photos')}.`,
  someConfirmed: (gone: number, refused: number, name: string) =>
    `Removed ${plural(gone, 'local copy', 'local copies')}; kept ${plural(refused, 'local copy', 'local copies')} because ${name} couldn't confirm ${refused === 1 ? 'a matching copy' : 'matching copies'}.`,

  couldNotFetchOriginal: () => "We couldn't fetch that original. Check the other device.",
  couldNotChangeTransfer: () => "We couldn't change that transfer. Try again.",
  couldNotReadTransferQueue: () => "We couldn't load transfers. Try again.",
};
