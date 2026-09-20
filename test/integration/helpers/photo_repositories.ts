import type { Database } from '../../../src/db/driver';
import { PhotoCompositesRepository } from '../../../src/services/photos/composites/photo_composites_repository';
import { PhotoListingRepository } from '../../../src/services/photos/listing/photo_listing_repository';
import { PhotoNavigationRepository } from '../../../src/services/photos/listing/photo_navigation_repository';
import { PhotoMetadataRepository } from '../../../src/services/photos/metadata/photo_metadata_repository';
import { PhotoStateRepository } from '../../../src/services/photos/mutations/photo_state_repository';
import { PhotoPathsRepository } from '../../../src/services/photos/paths/photo_paths_repository';
import { PhotoProcessingRepository } from '../../../src/services/photos/renditions/photo_processing_repository';
import { PhotoScanRepository } from '../../../src/services/photos/scan/photo_scan_repository';
import { RenditionsRepository } from '../../../src/services/processing/renditions/renditions_repository';
import { StackMembership } from '../../../src/services/stacks/stack_membership';

export const photoListing = (db: Database): PhotoListingRepository => new PhotoListingRepository(db);

export const photoNavigation = (db: Database): PhotoNavigationRepository => new PhotoNavigationRepository(db);

export const photoState = (db: Database): PhotoStateRepository => new PhotoStateRepository(db, new StackMembership(db));

export const photoPaths = (db: Database): PhotoPathsRepository => new PhotoPathsRepository(db, new StackMembership(db));

export const photoProcessing = (db: Database): PhotoProcessingRepository =>
  new PhotoProcessingRepository(db, new RenditionsRepository(db));

export const photoScan = (db: Database, processing = photoProcessing(db)): PhotoScanRepository =>
  new PhotoScanRepository(db, processing);

export const photoMetadata = (db: Database, processing = photoProcessing(db)): PhotoMetadataRepository =>
  new PhotoMetadataRepository(db, processing);

export function photoComposites(db: Database): PhotoCompositesRepository {
  const stacks = new StackMembership(db);
  return new PhotoCompositesRepository(db, stacks, new PhotoPathsRepository(db, stacks));
}
