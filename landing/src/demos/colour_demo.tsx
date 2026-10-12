import { useState } from 'react';
import { SegmentedControl } from '../../../web/src/ui/segmented_control';
import { DEMO } from '../features';
import { COLOUR_PHOTO } from '../photos';
import { Demo, DemoBar } from './demo';
import { SwapFrame } from './swap_frame';

type Profile = keyof typeof COLOUR_PHOTO;

const OPTIONS: { value: Profile; label: string }[] = [
  { value: 'matched', label: DEMO.colour.matched },
  { value: 'none', label: DEMO.colour.neutral },
];

const PHOTOS = [
  { value: 'none', src: COLOUR_PHOTO.none, alt: DEMO.colour.neutralAlt },
  { value: 'matched', src: COLOUR_PHOTO.matched, alt: DEMO.colour.matchedAlt },
] as const;

export function ColourDemo(): JSX.Element {
  const [profile, setProfile] = useState<Profile>('matched');
  return (
    <Demo>
      <DemoBar>
        <SegmentedControl
          label={DEMO.colour.label}
          options={OPTIONS}
          value={profile}
          onChange={setProfile}
        />
      </DemoBar>
      <SwapFrame photos={PHOTOS} shown={profile} />
    </Demo>
  );
}
