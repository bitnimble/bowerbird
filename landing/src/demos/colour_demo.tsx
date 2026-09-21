import * as stylex from '@stylexjs/stylex';
import { useState } from 'react';
import { SegmentedControl } from '../../../web/src/ui/segmented_control';
import { DEMO } from '../features';
import { COLOUR_PHOTO } from '../photos';
import { Demo, DemoBar } from './demo';

type Profile = keyof typeof COLOUR_PHOTO;

const OPTIONS: { value: Profile; label: string }[] = [
  { value: 'matched', label: DEMO.colour.matched },
  { value: 'none', label: DEMO.colour.neutral },
];

const styles = stylex.create({
  frame: {
    position: 'relative',
    width: 'fit-content',
    marginInline: 'auto',
    borderRadius: '4px',
    overflow: 'hidden',
    backgroundColor: '#000',
  },
  photo: {
    display: 'block',
    width: 'auto',
    height: 'auto',
    maxWidth: '100%',
    maxHeight: '760px',
  },
  // Both decoded and swapped by opacity, so the comparison is instant rather than a reload.
  over: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    opacity: 0,
  },
  overUp: {
    opacity: 1,
  },
});

export function ColourDemo(): JSX.Element {
  const [profile, setProfile] = useState<Profile>('matched');
  return (
    <Demo>
      <DemoBar>
        <SegmentedControl label={DEMO.colour.label} options={OPTIONS} value={profile} onChange={setProfile} />
      </DemoBar>
      <div {...stylex.props(styles.frame)}>
        <img {...stylex.props(styles.photo)} src={COLOUR_PHOTO.none} alt={DEMO.colour.neutralAlt} />
        <img
          {...stylex.props(styles.photo, styles.over, profile === 'matched' && styles.overUp)}
          src={COLOUR_PHOTO.matched}
          alt={DEMO.colour.matchedAlt}
        />
      </div>
    </Demo>
  );
}
