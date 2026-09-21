import * as stylex from '@stylexjs/stylex';
import { useState } from 'react';
import { SegmentedControl } from '../../../web/src/ui/segmented_control';
import { DEMO } from '../features';
import { PHOTOS, SCENES, type Scene } from '../photos';
import { Demo, DemoBar, DemoNote } from './demo';
import { SplitFrame, splitImage } from './split_frame';

type View = 'sdr' | 'split' | 'hdr';

const DIVIDER: Record<View, number> = { sdr: 100, split: 50, hdr: 0 };

const VIEWS: { value: View; label: string }[] = [
  { value: 'sdr', label: DEMO.hdr.sdr },
  { value: 'split', label: DEMO.hdr.split },
  { value: 'hdr', label: DEMO.hdr.hdr },
];

const SCENE_OPTIONS = SCENES.map((value) => ({ value, label: DEMO.hdr.scenes[value] }));

function viewAt(divider: number): View | null {
  return VIEWS.find((view) => DIVIDER[view.value] === divider)?.value ?? null;
}

export function HdrDemo(): JSX.Element {
  const [scene, setScene] = useState<Scene>('gamut');
  const [divider, setDivider] = useState(50);
  const title = DEMO.hdr.scenes[scene];

  return (
    <Demo>
      <DemoBar>
        <SegmentedControl label={DEMO.hdr.sceneLabel} options={SCENE_OPTIONS} value={scene} onChange={setScene} />
        <SegmentedControl
          label={DEMO.hdr.viewLabel}
          options={VIEWS}
          value={viewAt(divider)}
          onChange={(view) => setDivider(DIVIDER[view])}
        />
      </DemoBar>
      <SplitFrame
        before={<img {...stylex.props(splitImage.before)} src={PHOTOS[scene].sdr} alt={DEMO.hdr.sdrAlt(title)} />}
        after={<img {...stylex.props(splitImage.after)} src={PHOTOS[scene].hdr} alt={DEMO.hdr.hdrAlt(title)} />}
        beforeLabel={DEMO.hdr.sdr}
        afterLabel={DEMO.hdr.hdr}
        label={DEMO.hdr.divider}
        value={divider}
        onChange={setDivider}
      />
      <DemoNote>{DEMO.hdr.note}</DemoNote>
    </Demo>
  );
}
