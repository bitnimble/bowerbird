import { useState } from 'react';
import { SegmentedControl } from '../../../web/src/ui/segmented_control';
import { DEMO } from '../features';
import { Shot } from '../shot';
import { Demo, DemoBar } from './demo';

type Profile = keyof typeof DEMO.colour.shots;

const OPTIONS: { value: Profile; label: string }[] = [
  { value: 'matched', label: DEMO.colour.matched },
  { value: 'neutral', label: DEMO.colour.neutral },
];

export function ColourDemo(): JSX.Element {
  const [profile, setProfile] = useState<Profile>('matched');
  const shot = DEMO.colour.shots[profile];
  return (
    <Demo>
      <DemoBar>
        <SegmentedControl label={DEMO.colour.label} options={OPTIONS} value={profile} onChange={setProfile} />
      </DemoBar>
      <Shot key={shot.src} shot={shot} />
    </Demo>
  );
}
