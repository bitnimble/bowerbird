export const SidebarRowStrings = {
  /** A sidebar row read aloud: its name, and how many photographs are behind it. */
  rowHolding: (name: string, photoCount: number) => `${name}, ${photoCount} ${photoCount === 1 ? 'photo' : 'photos'}`,
  readOnly: () => 'Read-only',
  readOnlyName: (name: string) => `${name}, read-only`,
  originalsElsewhere: () => 'Originals are on synced devices',
  originalsElsewhereName: (name: string) => `${name}, originals on synced devices`,
};
