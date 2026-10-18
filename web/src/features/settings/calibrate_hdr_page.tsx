import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ownsArrows } from '../../app/remote_navigation';
import { SDR_WHITE_NITS } from '../../app/sdr_white';
import { useDeviceSettingsStore, usePresenters } from '../../app/stores_context';
import { focusRing } from '../../ui/focus_ring';
import { Heading } from '../../ui/heading';
import { Text } from '../../ui/text';
import { useShellStage } from '../photos/viewer/shell_stage';
import { CalibrateHdrPageStrings } from './calibrate_hdr_page.strings';
import { SettingsStrings } from './settings_page.strings';

const TENTHS = 10;
const LOWEST = 1;
const HIGHEST = 50;
/** Far past the patch, so it is drawn without the roll-off a photo's highlights get. */
const UNROLLED_HEADROOM = 100;

const styles = stylex.create({
  page: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '24px',
  },
  squares: {
    display: 'flex',
  },
  figure: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '8px',
  },
  // Small, so a TV limiting how much of the screen may be bright shows each at its full brightness.
  square: {
    width: '12vmin',
    height: '12vmin',
  },
  menuWhite: {
    backgroundColor: '#ffffff',
  },
});

/** Matches an HDR photo's white to the menus' on a TV whose screen Android does not measure. */
export const CalibrateHdrPage = observer(function CalibrateHdrPage(): JSX.Element {
  const device = useDeviceSettingsStore();
  const { deviceSettings } = usePresenters();
  const navigate = useNavigate();
  const [white, setWhite] = useState(device.hdrWhite);
  // The stage compiles a pipeline per white, so the patch's light moves instead of the white.
  const [drawnAt] = useState(device.hdrWhite);
  const page = useRef<HTMLDivElement>(null);
  const patch = useRef<HTMLDivElement>(null);

  useEffect(() => page.current?.focus({ preventScroll: true }), []);
  useShellStage(
    patch,
    {
      source: `pattern:${((SDR_WHITE_NITS * white) / drawnAt).toFixed(1)}`,
      headroom: UNROLLED_HEADROOM,
      white: drawnAt,
    },
    () => undefined,
  );

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const step = e.key === 'ArrowRight' ? 1 : -1;
      setWhite((was) =>
        Math.min(HIGHEST, Math.max(LOWEST, (Math.round(was * TENTHS) + step) / TENTHS)),
      );
    } else if (e.key === 'Enter') {
      deviceSettings.setHdrWhite(white);
      navigate(-1);
    } else if (e.key === 'Escape') {
      navigate(-1);
    } else return;
    e.preventDefault();
  };

  return (
    <div
      ref={page}
      tabIndex={-1}
      {...ownsArrows('all')}
      onKeyDown={onKey}
      {...stylex.props(styles.page, focusRing.none)}
    >
      <Heading>{CalibrateHdrPageStrings.title()}</Heading>
      <Text as="p">{CalibrateHdrPageStrings.match()}</Text>
      <div {...stylex.props(styles.squares)}>
        <div {...stylex.props(styles.figure)}>
          <div {...stylex.props(styles.square, styles.menuWhite)} />
          <Text variant="muted">{CalibrateHdrPageStrings.sdrWhite()}</Text>
        </div>
        <div {...stylex.props(styles.figure)}>
          <div ref={patch} {...stylex.props(styles.square)} />
          <Text variant="muted">{CalibrateHdrPageStrings.hdrWhite()}</Text>
        </div>
      </div>
      <Text variant="mono">{SettingsStrings.hdrWhiteScale(white)}</Text>
      <Text as="p" variant="muted">
        {CalibrateHdrPageStrings.finish()}
      </Text>
    </div>
  );
});
