import { PhotoStageStrings } from '../../photos/viewer/photo_stage.strings';
import type { OpenStep } from './stage_store';

export const RawEditStageStrings = {
  picture: () => 'Edit preview',

  step: (step: OpenStep): string => {
    switch (step) {
      case 'preparing': return 'Preparing…';
      case 'rendering': return PhotoStageStrings.rendering();
      case 'decoding': return 'Decoding…';
      case 'measuring-noise': return 'Measuring noise…';
      case 'finding-dust': return 'Finding sensor dust…';
      case 'denoising': return 'Reducing noise…';
      case 'demosaicing': return 'Demosaicing…';
      case 'matching': return 'Matching colour and lens distortion…';
      case 'correcting': return 'Correcting the lens and sharpening…';
    }
  },
  couldNotShow: () => "We couldn't show this photo. Open it again to retry.",
};
