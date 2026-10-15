import type { Library } from '../../../src/schemas/libraries';
import { inMobileApp } from '../api/transport';
import type { DevicePhotosStore } from '../features/device_photos/device_photos_store';

/** Whether this device has no folder to pick, so adds only the phone's photos or a synced library. */
export function isThinShell(): boolean {
  return inMobileApp();
}

/** Whether `library` has no folder on this device, so its folder, scan and backup settings go. */
export function isSyncedCopy(
  library: Pick<Library, 'root_path'>,
  devicePhotos: DevicePhotosStore,
): boolean {
  return isThinShell() && devicePhotos.read && !devicePhotos.holds(library);
}
