import type React from 'react';
import { type PhotoDetail } from '../../../../../src/schemas/photos';
import { captureDateTime } from '../../../api/dates';
import { PhotoDetailStrings } from './photo_detail_page.strings';

// Stands in for a field until the detail fetch lands, so every panel is its
// final height from the first frame.
export const PENDING = PhotoDetailStrings.pending();

// The panel strip is a grid track the stage is sized against, so it has to hold
// its height across the detail fetch. Every field that fetch answers renders as
// PENDING until it lands rather than the panel not rendering at all: an empty
// strip let the photo paint full-size and then shrink under itself when the
// panels appeared.
export function pendingUntil(photo: PhotoDetail | null) {
  return (value: (p: PhotoDetail) => React.ReactNode): React.ReactNode => (photo == null ? PENDING : value(photo));
}

// 1/250 reads as a shutter speed; 0.004 does not.
export function shutterLabel(seconds: number): string {
  return seconds >= 1
    ? PhotoDetailStrings.shutterSeconds(seconds.toFixed(1))
    : PhotoDetailStrings.shutterFraction(Math.round(1 / seconds));
}

// "Sony ILCE-7CR", but not "Sony Sony A7": models often already carry the brand.
export function bodyLabel(make: string | null, model: string | null): string {
  if (model == null) return make ?? PhotoDetailStrings.notRecorded();
  if (make == null || model.toLowerCase().startsWith(make.toLowerCase())) return model;
  return PhotoDetailStrings.body(make, model);
}

// Empty once both passes have landed, which is the usual state.
export function stageLabel(photo: PhotoDetail): string {
  if (photo.needs_tile) return PhotoDetailStrings.buildingGridRendition();
  return photo.needs_renditions ? PhotoDetailStrings.buildingViewRendition() : '';
}

// "+11:00" reads as UTC+11 to anyone who has not just been staring at EXIF.
export function takenLabel(iso: string | null, offset: string | null): string {
  const wallClock = captureDateTime(iso);
  if (wallClock == null) return PhotoDetailStrings.notRecorded();
  return offset == null ? wallClock : PhotoDetailStrings.taken(wallClock, offset.replace(/:00$/, ''));
}

