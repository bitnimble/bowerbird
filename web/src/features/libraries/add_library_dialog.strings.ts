export const AddLibraryStrings = {
  /** The dialog's title, and the button in Settings that opens it. */
  title: () => 'Add library',

  folder: () => 'Folder',
  /** The folder a library is rooted at, asked for here and when joining a remote one. */
  libraryRootPath: () => 'Library root',
  rootPlaceholder: () => '/photos',

  /** What to call the thing being created, in the new-shoot and new-album dialogs. */
  name: () => 'Name',

  unwritableHint: () => "Bowerbird can't write to this folder. Choose another folder.",

  binExistsWarning: (rootPath: string, binName: string) =>
    `${rootPath} already has a folder called "${binName}". Its photos will appear in the Bin.`,

  sortPhotosBy: () => 'Sort photos by',

  advancedSettings: () => 'Advanced settings',
};
