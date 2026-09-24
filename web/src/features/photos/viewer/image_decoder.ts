// WebCodecs, which TypeScript's DOM library does not describe. Only what is used here.
interface ImageDecoderInit {
  data: ArrayBuffer | Uint8Array<ArrayBuffer>;
  type: string;
  desiredWidth?: number;
  desiredHeight?: number;
}
interface ImageDecoderResult {
  image: VideoFrame;
}
interface ImageDecoderLike {
  decode(): Promise<ImageDecoderResult>;
  close(): void;
}
type ImageDecoderConstructor = new (init: ImageDecoderInit) => ImageDecoderLike;

export const WebCodecs = (globalThis as { ImageDecoder?: ImageDecoderConstructor }).ImageDecoder;
