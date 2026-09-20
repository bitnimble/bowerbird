// Shoot folder membership (DESIGN §4.3). folder_path is the full root-relative
// path; a file belongs to a shoot iff its file_path starts with folder_path + '/'
// (trailing slash required so `NYC` does not capture files in sibling `NYC2`).

export function shootContains(folderPath: string, filePath: string): boolean {
  return filePath.startsWith(`${folderPath}/`);
}

/**
 * The folders that are neither one of `away` nor inside one, for dropping a hidden shoot's subtree
 * out of a tree read off the disk (§12.4).
 *
 * `shootContains` plus the folder itself, because a folder is not "in" itself and this caller is
 * removing the shoot's own row as well as its contents. The trailing slash is what it borrows and
 * what matters: `Trip` must not take `Trip2` with it.
 */
export function foldersOutside(folders: readonly string[], away: readonly string[]): string[] {
  return folders.filter((folder) => !away.some((path) => folder === path || shootContains(path, folder)));
}

// The most-specific (longest folder_path) shoot whose folder contains filePath.
export function mostSpecificShoot<T extends { folder_path: string }>(filePath: string, shoots: readonly T[]): T | null {
  let best: T | null = null;
  for (const shoot of shoots) {
    if (shootContains(shoot.folder_path, filePath) && (best == null || shoot.folder_path.length > best.folder_path.length)) {
      best = shoot;
    }
  }
  return best;
}
