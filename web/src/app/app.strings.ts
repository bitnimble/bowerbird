// The sidebar names destinations, and a destination owns its own name: everything the
// links here read is imported from the page they lead to.
export const AppStrings = {
  addALibrary: () => 'Add library',
  photos: () => 'Photos',
  editsToChoose: () => 'Edits to choose',
  syncErrors: () => 'Sync errors',
  updateThisDevice: () => 'Update Bowerbird',
  updateDevice: (name: string) => `Update ${name}`,
  brand: () => 'Bowerbird',
  sidebar: () => 'Sidebar',
  hideSidebar: () => 'Hide sidebar',
  resizeSidebar: () => 'Resize sidebar',
  /** A sidebar row read aloud: its name, and how many photographs are behind it. */
  rowHolding: (name: string, photoCount: number) => `${name}, ${photoCount} ${photoCount === 1 ? 'photo' : 'photos'}`,
  readOnly: () => 'Read-only',
  readOnlyName: (name: string) => `${name}, read-only`,
  catalogue: () => 'Catalogue',
};
