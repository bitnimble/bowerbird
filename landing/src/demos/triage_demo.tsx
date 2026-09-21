import * as stylex from '@stylexjs/stylex';
import { useState } from 'react';
import { Button, ButtonHint, buttonProps } from '../../../web/src/ui/button';
import { focusRing } from '../../../web/src/ui/focus_ring';
import { Row } from '../../../web/src/ui/row';
import { Text } from '../../../web/src/ui/text';
import { color } from '../../../web/src/ui/tokens.stylex';
import { DEMO } from '../features';
import { Badge } from './badge';
import { Demo, DemoBar } from './demo';
import { FramePhoto, type Frame } from './frame_photo';

const OPENERS: readonly [Frame, Frame] = [
  { name: 'DSC_4102', scene: 'arches', exposure: 0.8, zoom: 1.05, shift: 0 },
  { name: 'DSC_4103', scene: 'arches', exposure: 1, zoom: 1.12, shift: 2 },
];

const CHALLENGERS: readonly Frame[] = [
  { name: 'DSC_4104', scene: 'arches', exposure: 1.2, zoom: 1.2, shift: -3 },
  { name: 'DSC_4105', scene: 'arches', exposure: 0.95, zoom: 1.3, shift: 4 },
  { name: 'DSC_4106', scene: 'arches', exposure: 1.1, zoom: 1.08, shift: -2 },
];

const BURST: readonly Frame[] = [...OPENERS, ...CHALLENGERS];

type Side = 'a' | 'b';

/** The winner of a round keeps its side, and `CHALLENGERS[next]` takes the loser's. */
type Hill = { kind: 'round'; a: Frame; b: Frame; next: number } | { kind: 'done'; winner: Frame };

const START: Hill = { kind: 'round', a: OPENERS[0], b: OPENERS[1], next: 0 };

const TEXT_SHADOW = '0 1px 3px rgb(0 0 0 / 85%)';

const styles = stylex.create({
  pair: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: '12px',
  },
  frame: {
    position: 'relative',
    aspectRatio: '3 / 2',
    overflow: 'hidden',
    padding: 0,
    borderWidth: '2px',
    borderStyle: 'solid',
    borderRadius: '4px',
    backgroundColor: '#000',
    cursor: 'pointer',
  },
  frameA: { borderColor: color.rose },
  frameB: { borderColor: color.satin },
  slot: {
    position: 'absolute',
    top: '6px',
    left: '8px',
    textShadow: TEXT_SHADOW,
    pointerEvents: 'none',
  },
  inkA: { color: color.rose },
  inkB: { color: color.satin },
  markA: { boxShadow: `inset 2px 0 0 ${color.rose}` },
  markB: { boxShadow: `inset 2px 0 0 ${color.satin}` },
  hint: { opacity: 1 },
  name: {
    position: 'absolute',
    left: '8px',
    bottom: '6px',
    color: color.bone,
    textShadow: TEXT_SHADOW,
  },
  strip: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))',
    gap: '10px',
  },
  result: {
    margin: 0,
  },
  thumb: {
    display: 'block',
    aspectRatio: '3 / 2',
    overflow: 'hidden',
    borderWidth: '2px',
    borderStyle: 'solid',
    borderColor: 'transparent',
    borderRadius: '4px',
    opacity: 0.55,
  },
  winner: {
    borderColor: color.moss,
    opacity: 1,
  },
  caption: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '4px',
    marginTop: '4px',
  },
});

const SIDE_STYLE = {
  a: { frame: styles.frameA, ink: styles.inkA, mark: styles.markA },
  b: { frame: styles.frameB, ink: styles.inkB, mark: styles.markB },
} as const;

function judge(hill: Hill, side: Side): Hill {
  if (hill.kind === 'done') return hill;
  const incoming = CHALLENGERS[hill.next];
  if (incoming == null) return { kind: 'done', winner: side === 'a' ? hill.a : hill.b };
  const next = hill.next + 1;
  return side === 'a' ? { ...hill, b: incoming, next } : { ...hill, a: incoming, next };
}

export function TriageDemo(): JSX.Element {
  const [hill, setHill] = useState<Hill>(START);
  const pick = (side: Side): void => setHill((current) => judge(current, side));

  if (hill.kind === 'done') return <Result winner={hill.winner} onRestart={() => setHill(START)} />;

  const sides: [Side, Frame][] = [
    ['a', hill.a],
    ['b', hill.b],
  ];

  return (
    <Demo
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') pick('a');
        if (event.key === 'ArrowRight') pick('b');
      }}
    >
      <DemoBar>
        <Text variant="mono">{DEMO.triage.round(hill.next + 1, CHALLENGERS.length + 1)}</Text>
        <Row>
          <Button style={SIDE_STYLE.a.mark} onClick={() => pick('a')}>
            {DEMO.triage.pickA}
            <ButtonHint style={[SIDE_STYLE.a.ink, styles.hint]}>←</ButtonHint>
          </Button>
          <Button style={SIDE_STYLE.b.mark} onClick={() => pick('b')}>
            {DEMO.triage.pickB}
            <ButtonHint style={[SIDE_STYLE.b.ink, styles.hint]}>→</ButtonHint>
          </Button>
        </Row>
      </DemoBar>
      <div {...stylex.props(styles.pair)}>
        {sides.map(([side, frame]) => (
          <button
            key={side}
            type="button"
            {...stylex.props(styles.frame, SIDE_STYLE[side].frame, focusRing.ring)}
            aria-label={DEMO.triage.pickSide(side.toUpperCase(), frame.name)}
            onClick={() => pick(side)}
          >
            <FramePhoto key={frame.name} frame={frame} alt="" />
            <Text variant="mono" style={[styles.slot, SIDE_STYLE[side].ink]}>
              {side.toUpperCase()}
            </Text>
            <Text variant="mono" style={styles.name}>
              {frame.name}
            </Text>
          </button>
        ))}
      </div>
    </Demo>
  );
}

function Result({ winner, onRestart }: { winner: Frame; onRestart: () => void }): JSX.Element {
  return (
    <Demo>
      <DemoBar>
        <Text variant="mono">{DEMO.triage.winner}</Text>
        <button type="button" {...buttonProps('default', false)} autoFocus onClick={onRestart}>
          {DEMO.triage.restart}
        </button>
      </DemoBar>
      <div {...stylex.props(styles.strip)}>
        {BURST.map((frame) => (
          <figure key={frame.name} {...stylex.props(styles.result)}>
            <span {...stylex.props(styles.thumb, frame === winner && styles.winner)}>
              <FramePhoto frame={frame} alt={frame.name} />
            </span>
            <figcaption {...stylex.props(styles.caption)}>
              <Text variant="mono">{frame.name}</Text>
              <Badge tone={frame === winner ? 'pick' : 'reject'}>
                {frame === winner ? DEMO.triage.pick : DEMO.triage.reject}
              </Badge>
            </figcaption>
          </figure>
        ))}
      </div>
    </Demo>
  );
}
