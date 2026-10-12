import { useState } from 'react';
import { SegmentedControl } from '../../../web/src/ui/segmented_control';
import { DEMO } from '../features';
import { DENOISE_PHOTO } from '../photos';
import { Demo, DemoBar } from './demo';
import { SwapFrame } from './swap_frame';

type Denoiser = keyof typeof DENOISE_PHOTO;

const OPTIONS: { value: Denoiser; label: string }[] = [
  { value: 'original', label: DEMO.denoise.original },
  { value: 'fast', label: DEMO.denoise.fast },
  { value: 'best', label: DEMO.denoise.best },
];

const PHOTOS = [
  { value: 'original', src: DENOISE_PHOTO.original, alt: DEMO.denoise.alt },
  { value: 'fast', src: DENOISE_PHOTO.fast, alt: DEMO.denoise.alt },
  { value: 'best', src: DENOISE_PHOTO.best, alt: DEMO.denoise.alt },
] as const;

export function DenoiseDemo(): JSX.Element {
  const [denoiser, setDenoiser] = useState<Denoiser>('best');
  return (
    <Demo>
      <DemoBar>
        <SegmentedControl
          label={DEMO.denoise.label}
          options={OPTIONS}
          value={denoiser}
          onChange={setDenoiser}
        />
      </DemoBar>
      <SwapFrame photos={PHOTOS} shown={denoiser} />
    </Demo>
  );
}
