import * as stylex from '@stylexjs/stylex';
import { useState } from 'react';
import { DEMO } from '../features';
import { DUST_PHOTO } from '../photos';
import { Demo } from './demo';
import { SplitFrame, splitImage } from './split_frame';

export function DustDemo(): JSX.Element {
  const [divider, setDivider] = useState(50);
  return (
    <Demo>
      <SplitFrame
        before={<img {...stylex.props(splitImage.before)} src={DUST_PHOTO.before} alt={DEMO.dust.alt} />}
        after={<img {...stylex.props(splitImage.after)} src={DUST_PHOTO.after} alt="" />}
        beforeLabel={DEMO.dust.before}
        afterLabel={DEMO.dust.after}
        label={DEMO.dust.divider}
        value={divider}
        onChange={setDivider}
      />
    </Demo>
  );
}
