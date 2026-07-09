// Shoot folder membership (DESIGN §4.3). folder_path is the full root-relative
// path; a file belongs to a shoot iff its file_path starts with folder_path + '/'
// (trailing slash required so `NYC` does not capture files in sibling `NYC2`).

export function shootContains(folderPath: string, filePath: string): boolean {
  return filePath.startsWith(`${folderPath}/`);
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
