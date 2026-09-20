// A row's affordances, shared by the Shoots and Albums lists and by the sidebar that
// nests the same collections: they stay learnable as one thing only if they are
// named as one thing.
export const CollectionListStrings = {
  renameField: (name: string) => `Rename ${name}`,
  rename: () => 'Rename',
  delete: () => 'Delete',

  rowsLabel: (count: number) => `${count} rows`,
  actionsFor: (name: string) => `Actions for ${name}`,
  collapse: (name: string) => `Collapse ${name}`,
  expand: (name: string) => `Expand ${name}`,

  /** What a row holds, after whatever the name could not say - a folder, an ordering. */
  subtitle: (prefix: string, photoCount: number) => {
    const photos = `${photoCount} ${photoCount === 1 ? 'photo' : 'photos'}`;
    return prefix === '' ? photos : `${prefix} · ${photos}`;
  },

  // Said on the row as well as drawn into it: dimming alone is what an empty shoot, an untracked
  // folder and a hidden one all look like, and only one of them is undone by a menu item.
  hiddenSubtitle: (subtitle: string) => `Hidden · ${subtitle}`,
};
