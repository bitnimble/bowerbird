export interface ProcessingJob {
  photoId: string;
  rawFilePath: string;
  smallOutputPath: string;
  fullOutputPath: string;
  smallSize: number;
  fullSize: number;
  smallQuality: number;
  fullQuality: number;
}

export type ProcessingResult =
  | { photoId: string; success: true }
  | { photoId: string; success: false; error: string };
