import * as stylex from '@stylexjs/stylex';
import { useState } from 'react';
import { focusRing } from '../../../web/src/ui/focus_ring';
import { color, derivedSize, font, size } from '../../../web/src/ui/tokens.stylex';
import { DEMO } from '../features';
import { Demo } from './demo';
import { FramePhoto, type Frame } from './frame_photo';

// Every photograph appears once, so the grid reads as a library rather than as a demo with
//4 pictures in it. The stack is the one place a scene repeats, which is the point of it.
const BEFORE: readonly Frame[] = [
  { name: 'DSC_3782', scene: 'gamut', exposure: 1, zoom: 1.2, shift: 4 },
  { name: 'DSC_3796', scene: 'sun', exposure: 1.05, zoom: 1.1, shift: -3 },
  { name: 'DSC_3810', scene: 'sunset', exposure: 1, zoom: 1, shift: 0 },
];

const STACK: readonly [Frame, ...Frame[]] = [
  { name: 'DSC_3901', scene: 'arches', exposure: 1, zoom: 1, shift: 0 },
  { name: 'DSC_3902', scene: 'arches', exposure: 1.1, zoom: 1.12, shift: 4 },
  { name: 'DSC_3903', scene: 'arches', exposure: 0.9, zoom: 1.25, shift: -3 },
  { name: 'DSC_3904', scene: 'arches', exposure: 1.05, zoom: 1.4, shift: 6 },
  { name: 'DSC_3905', scene: 'arches', exposure: 0.95, zoom: 1.55, shift: -6 },
];

const AFTER: readonly Frame[] = [
  { name: 'DSC_3928', scene: 'rapids', exposure: 0.9, zoom: 1, shift: 0 },
  { name: 'DSC_3940', scene: 'whites', exposure: 1, zoom: 1.25, shift: 0 },
  { name: 'DSC_3951', scene: 'street', exposure: 1.05, zoom: 1.2, shift: -4 },
  { name: 'DSC_3962', scene: 'saturated', exposure: 0.95, zoom: 1.3, shift: 6 },
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
