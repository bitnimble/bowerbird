import * as stylex from '@stylexjs/stylex';
import { useState } from 'react';
import { focusRing } from '../../../web/src/ui/focus_ring';
import { color, derivedSize, font, size } from '../../../web/src/ui/tokens.stylex';
import { DEMO } from '../features';
import { Demo, DemoNote } from './demo';
import { FramePhoto, type Frame } from './frame_photo';

const BEFORE: readonly Frame[] = [
  { name: 'DSC_3810', scene: 'sunset', exposure: 1, zoom: 1, shift: 0 },
  { name: 'DSC_3822', scene: 'arches', exposure: 1.1, zoom: 1.3, shift: 6 },
];

const STACK: readonly [Frame, ...Frame[]] = [
  { name: 'DSC_3901', scene: 'rapids', exposure: 1, zoom: 1, shift: 0 },
  { name: 'DSC_3902', scene: 'rapids', exposure: 1.1, zoom: 1.08, shift: 2 },
  { name: 'DSC_3903', scene: 'rapids', exposure: 0.9, zoom: 1.15, shift: -2 },
  { name: 'DSC_3904', scene: 'rapids', exposure: 1.05, zoom: 1.25, shift: 3 },
  { name: 'DSC_3905', scene: 'rapids', exposure: 0.95, zoom: 1.4, shift: -4 },
];

const AFTER: readonly Frame[] = [
  { name: 'DSC_3940', scene: 'sunset', exposure: 1.2, zoom: 1.5, shift: -8 },
  { name: 'DSC_3951', scene: 'arches', exposure: 0.9, zoom: 1, shift: 0 },
  { name: 'DSC_3957', scene: 'arches', exposure: 1.2, zoom: 1.6, shift: -10 },
  { name: 'DSC_3962', scene: 'sunset', exposure: 0.85, zoom: 1.2, shift: 5 },
  { name: 'DSC_3970', scene: 'rapids', exposure: 1, zoom: 1.7, shift: 12 },
];

const BAND = '#9d7ce8';

const bandOpen = stylex.keyframes({ from: { opacity: 0 } });

const styles = stylex.create({
  grid: {
    display: 'grid',
    gridTemplateColumns: { default: 'repeat(4, minmax(0, 1fr))', '@media (max-width: 600px)': 'repeat(3, minmax(0, 1fr))' },
    gridAutoFlow: 'row dense',
    gap: size.gridGap,
  },
  tile: {
    position: 'relative',
    aspectRatio: '3 / 2',
    display: 'block',
    width: '100%',
    padding: size.tilePad,
    borderWidth: 0,
    borderRadius: derivedSize.cellRadius,
    backgroundColor: 'transparent',
    overflow: 'hidden',
    cursor: 'pointer',
  },
  tileBand: {
    '::before': {
      content: '""',
      position: 'absolute',
      inset: 0,
      pointerEvents: 'none',
      zIndex: 2,
      borderRadius: 'inherit',
      boxShadow: `inset 0 0 0 ${size.ring} ${BAND}`,
    },
  },
  photo: {
    position: 'absolute',
    inset: size.tilePad,
    borderRadius: size.radius,
    overflow: 'hidden',
    backgroundColor: '#090b0e',
  },
  foot: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: '14px',
    paddingInline: '7px',
    paddingBottom: '5px',
    backgroundImage: 'linear-gradient(transparent, rgba(6, 8, 11, 0.9))',
    display: 'flex',
    justifyContent: 'space-between',
    minHeight: '18px',
    alignItems: 'center',
    gap: '6px',
  },
  name: {
    fontFamily: font.mono,
    fontSize: '10px',
    color: '#b9bcc4',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  stack: {
    pointerEvents: 'none',
    position: 'absolute',
    inset: 0,
    zIndex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    backgroundColor: 'rgba(10, 12, 16, 0.35)',
    color: color.bone,
    fontFamily: font.mono,
    fontSize: '20px',
  },
  stackOpen: {
    backgroundColor: 'rgba(10, 12, 16, 0.62)',
  },
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '6px',
    minWidth: '72px',
    height: '34px',
    paddingBlock: 0,
    paddingInline: '10px',
    lineHeight: 1,
    borderRadius: '4px',
    backgroundColor: 'rgba(10, 12, 16, 0.66)',
  },
  count: {
    fontVariantNumeric: 'tabular-nums',
    minWidth: '2ch',
    textAlign: 'center',
  },
  band: {
    gridColumn: '1 / -1',
    position: 'relative',
    animationName: bandOpen,
    animationDuration: '220ms',
    animationTimingFunction: 'ease',
    backgroundColor: 'rgba(120, 140, 180, 0.1)',
    borderRadius: derivedSize.cellRadius,
    '::after': {
      content: '""',
      position: 'absolute',
      inset: 0,
      pointerEvents: 'none',
      borderWidth: size.ring,
      borderStyle: 'solid',
      borderColor: BAND,
      borderRadius: 'inherit',
    },
  },
});

export function StacksDemo(): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <Demo>
      <div {...stylex.props(styles.grid)}>
        {BEFORE.map((frame) => (
          <Tile key={frame.name} frame={frame} />
        ))}
        <button
          type="button"
          {...stylex.props(styles.tile, open && styles.tileBand, focusRing.ring)}
          aria-expanded={open}
          aria-label={DEMO.stacks.toggle(STACK.length, open)}
          onClick={() => setOpen((was) => !was)}
        >
          <span {...stylex.props(styles.photo)}>
            <FramePhoto frame={STACK[0]} alt="" />
          </span>
          <span {...stylex.props(styles.stack, open && styles.stackOpen)}>
            <span {...stylex.props(styles.chip)}>
              {open ? (
                <Icon path="M18 15l-6-6-6 6" />
              ) : (
                <>
                  <Icon path="M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5M3 17.5l9 5 9-5" />
                  <span {...stylex.props(styles.count)}>{STACK.length}</span>
                </>
              )}
            </span>
          </span>
        </button>
        {open && (
          <div {...stylex.props(styles.band)}>
            <div {...stylex.props(styles.grid)}>
              {STACK.map((frame) => (
                <Tile key={frame.name} frame={frame} />
              ))}
            </div>
          </div>
        )}
        {AFTER.map((frame) => (
          <Tile key={frame.name} frame={frame} />
        ))}
      </div>
      <DemoNote>{DEMO.stacks.hint}</DemoNote>
    </Demo>
  );
}

function Tile({ frame }: { frame: Frame }): JSX.Element {
  return (
    <div {...stylex.props(styles.tile)}>
      <div {...stylex.props(styles.photo)}>
        <FramePhoto frame={frame} alt={DEMO.stacks.alt(frame.name)} />
        <div {...stylex.props(styles.foot)}>
          <span {...stylex.props(styles.name)}>{frame.name}</span>
        </div>
      </div>
    </div>
  );
}

function Icon({ path }: { path: string }): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={path} />
    </svg>
  );
}
