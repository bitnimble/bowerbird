import * as stylex from '@stylexjs/stylex';
import { useState } from 'react';
import { DEMO } from '../features';
import { PHOTOS } from '../photos';
import { Demo, DemoNote } from './demo';
import { SplitFrame, splitImage } from './split_frame';

// Percentages of the frame, all over the sky.
const SPECKS = [
  { x: 12, y: 14, size: 3.2 },
  { x: 31, y: 8, size: 2.2 },
  { x: 46, y: 22, size: 4 },
  { x: 63, y: 11, size: 2.6 },
  { x: 72, y: 27, size: 3.4 },
  { x: 86, y: 16, size: 2 },
  { x: 22, y: 30, size: 2.4 },
];

const styles = stylex.create({
  dust: {
    position: 'relative',
  },
  speck: {
    position: 'absolute',
    aspectRatio: 1,
    transform: 'translate(-50%, -50%)',
    borderRadius: '50%',
    backgroundImage: 'radial-gradient(circle, rgb(18 14 10 / 55%) 0, rgb(18 14 10 / 30%) 45%, transparent 70%)',
  },});

export function DustDemo(): JSX.Element {
  const [divider, setDivider] = useState(50);
  return (
    <Demo>
      <SplitFrame
        before={
          <div {...stylex.props(styles.dust)}>
            <img {...stylex.props(splitImage.before)} src={PHOTOS.sunset.sdr} alt={DEMO.dust.alt} />
            {SPECKS.map((speck) => (
              <span
                key={`${speck.x},${speck.y}`}
                {...stylex.props(styles.speck)}
                style={{ left: `${speck.x}%`, top: `${speck.y}%`, width: `${speck.size}%` }}
              />
            ))}
          </div>
        }
        after={<img {...stylex.props(splitImage.after)} src={PHOTOS.sunset.sdr} alt="" />}
        beforeLabel={DEMO.dust.before}
        afterLabel={DEMO.dust.after}
        label={DEMO.dust.divider}
        value={divider}
        onChange={setDivider}
      />
      <DemoNote>{DEMO.dust.note}</DemoNote>
    </Demo>
  );
}
