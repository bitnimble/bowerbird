import * as stylex from '@stylexjs/stylex';
import { useState } from 'react';
import { HdrPicture } from '../../../web/src/avif/hdr_picture';
import type { HdrSource } from '../../../web/src/avif/hdr_pictures';
import { SegmentedControl } from '../../../web/src/ui/segmented_control';
import { DEMO } from '../features';
import { useHdrDisplay } from '../hdr_display';
import { PHOTOS, SCENES, hdrSource, type Scene } from '../photos';
import { Demo, DemoBar, DemoWarning } from './demo';
import { SplitFrame, splitImage } from './split_frame';

type View = 'sdr' | 'split' | 'hdr';

const NARROW = '@media (max-width: 345px)';

const DIVIDER: Record<View, number> = { sdr: 100, split: 50, hdr: 0 };

const VIEWS: { value: View; label: string }[] = [
  { value: 'sdr', label: DEMO.hdr.sdr },
  { value: 'split', label: DEMO.hdr.split },
  { value: 'hdr', label: DEMO.hdr.hdr },
];

const SCENE_OPTIONS = SCENES.map((value) => ({ value, label: DEMO.hdr.scenes[value] }));

const styles = stylex.create({
  control: {
    width: 'auto',
    maxWidth: '100%',
  },
  controlItem: {
    paddingInline: { default: '10px', [NARROW]: '6px' },
  },
});

function viewAt(divider: number): View | null {
  return VIEWS.find((view) => DIVIDER[view.value] === divider)?.value ?? null;
}

/**
 * One arm of a pair, reporting when it is on screen.
 *
 * `onReady` fires on a failure too: a pair that will never arrive has to stop the spinner
 * rather than turn under it forever.
 */
function Rendition({
  style,
  src,
  alt,
  onReady,
}: {
  style: stylex.StyleXStyles;
  src: string;
  alt: string;
  onReady: (src: string) => void;
}): JSX.Element {
  const ready = (): void => onReady(src);
  return (
    <img
      {...stylex.props(style)}
      src={src}
      alt={alt}
      // A cached file can be complete before React attaches the handler, and `load` never fires then.
      ref={(img) => {
        if (img?.complete) ready();
      }}
      onLoad={ready}
      onError={ready}
    />
  );
}

/** The HDR arm (`HdrPicture`), reported ready under its still's URL as the 8-bit arm is. */
function HdrRendition({
  style,
  source,
  alt,
  onReady,
}: {
  style: stylex.StyleXStyles;
  source: HdrSource;
  alt: string;
  onReady: (src: string) => void;
}): JSX.Element {
  const ready = (): void => onReady(source.still);
  return <HdrPicture source={source} alt={alt} style={style} onShown={ready} onError={ready} />;
}

export function HdrDemo(): JSX.Element {
  const [scene, setScene] = useState<Scene>('gamut');
  const [divider, setDivider] = useState(DIVIDER.split);
  const [shown, setShown] = useState<ReadonlySet<string>>(() => new Set());
  const hdrDisplay = useHdrDisplay();
  const title = DEMO.hdr.scenes[scene];
  const photo = PHOTOS[scene];
  // Both arms at once or neither: an 8-bit file lands well before its HDR twin, and a
  // frame that is half one picture and half the other reads as the demo being broken.
  const loading = !shown.has(photo.sdr) || !shown.has(photo.hdr);
  const markShown = (src: string): void =>
    setShown((was) => (was.has(src) ? was : new Set(was).add(src)));

  return (
    <Demo>
      <DemoBar>
        <SegmentedControl
          label={DEMO.hdr.sceneLabel}
          options={SCENE_OPTIONS}
          value={scene}
          onChange={(next) => {
            setScene(next);
            setDivider(DIVIDER.split);
          }}
          stretch
          style={styles.control}
          itemStyle={styles.controlItem}
        />
        <SegmentedControl
          label={DEMO.hdr.viewLabel}
          options={VIEWS}
          value={viewAt(divider)}
          onChange={(view) => setDivider(DIVIDER[view])}
          stretch
          style={styles.control}
          itemStyle={styles.controlItem}
        />
      </DemoBar>
      <SplitFrame
        before={
          <Rendition
            key={photo.sdr}
            style={splitImage.before}
            src={photo.sdr}
            alt={DEMO.hdr.sdrAlt(title)}
            onReady={markShown}
          />
        }
        after={
          <HdrRendition
            key={photo.hdr}
            style={splitImage.after}
            source={hdrSource(scene)}
            alt={DEMO.hdr.hdrAlt(title)}
            onReady={markShown}
          />
        }
        beforeLabel={DEMO.hdr.sdr}
        afterLabel={DEMO.hdr.hdr}
        label={DEMO.hdr.divider}
        value={divider}
        onChange={setDivider}
        loading={loading}
      />
      {!hdrDisplay && <DemoWarning>{DEMO.hdr.noHdrDisplay}</DemoWarning>}
    </Demo>
  );
}
