import * as stylex from '@stylexjs/stylex';
import { MoveUpRight, Sparkles } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { Fragment, useCallback, useEffect, useRef } from 'react';
import { COLOUR_NODES_MAX, type ColourNode } from '../../../../../src/schemas/photo_edits';
import { Button } from '../../../ui/button';
import { MenuCheckItem } from '../../../ui/check_menu';
import { focusRing } from '../../../ui/focus_ring';
import { ICON } from '../../../ui/icon';
import { menuSection } from '../../../ui/menu_section';
import { OverflowMenu } from '../../../ui/overflow_menu';
import { Slider } from '../../../ui/slider';
import { Text } from '../../../ui/text';
import { Tooltip } from '../../../ui/tooltip';
import { EditControl, ResetButton } from '../edit_control';
import { reading } from '../edit_sliders';
import { RawEditPanelStrings } from '../raw_edit_panel.strings';
import { styles as panelStyles } from '../raw_edit_panel.stylex';
import type { StageStore } from '../stage/stage_store';
import {
  CHANNELS,
  LIGHTNESS_REACH,
  type Channel,
  LEAST_HUE_REACH,
  MOST_HUE_REACH,
  type Hued,
  type Point,
  type Reach,
  chromaReached,
  edgePath,
  huedAt,
  lightnessOf,
  pointOf,
  reachPath,
  reachesEveryHue,
} from './colour_wheel';
import { ColourWheelStrings as strings } from './colour_wheel.strings';
import { type ColourWheelPresenter, type Handle, WHEEL_SIDE } from './colour_wheel_presenter';
import type { ColourWheelStore } from './colour_wheel_store';
import { styles } from './colour_wheel_editor.stylex';

const CHANNEL_POTS: { channel: Channel; name: () => string; pot: stylex.StyleXStyles }[] = [
  { channel: null, name: strings.all, pot: styles.all },
  { channel: CHANNELS[0], name: strings.shadows, pot: styles.shadows },
  { channel: CHANNELS[1], name: strings.darks, pot: styles.darks },
  { channel: CHANNELS[2], name: strings.midtones, pot: styles.midtones },
  { channel: CHANNELS[3], name: strings.lights, pot: styles.lights },
  { channel: CHANNELS[4], name: strings.highlights, pot: styles.highlights },
];

const MOST_TARGET_LIGHTNESS = 150;
const MOST_LIGHTNESS_REACH = 60;
const FIELD_HEAD = 0.04;
const SHORTEST_FIELD_ARROW = 2 * FIELD_HEAD;
const NODE_RADIUS = 0.045;
const TARGET_RADIUS = 0.04;
const HANDLE_GRAB = 0.05;
const REACH_STEPS: Record<Reach, number> = { hueReach: 1, chromaReach: 0.5 };
const KEY_DIRECTIONS: Partial<Record<string, number>> = {
  ArrowUp: 1,
  ArrowRight: 1,
  ArrowDown: -1,
  ArrowLeft: -1,
};
const TWO_WAY =
  'M-0.045 0 H0.045 M-0.045 0 l0.018 -0.016 M-0.045 0 l0.018 0.016 M0.045 0 l-0.018 -0.016 M0.045 0 l-0.018 0.016';

type Drag = {
  index: number;
  handle: Handle;
  pointerId: number;
  svg: SVGSVGElement;
  bounds: DOMRect;
};

function pointAt(event: React.PointerEvent, bounds: DOMRect): Point {
  return {
    x: ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
    y: ((event.clientY - bounds.top) / bounds.height) * 2 - 1,
  };
}

export const ColourWheelEditor = observer(function ColourWheelEditor({
  store,
  stage,
  presenter,
}: {
  store: ColourWheelStore;
  stage: StageStore;
  presenter: ColourWheelPresenter;
}): JSX.Element {
  const disabled = !stage.editable;
  const rim = store.drawn?.chroma ?? null;
  const selected = store.selectedNode;
  return (
    <div {...stylex.props(styles.editor)}>
      <div {...stylex.props(styles.header)}>
        <h3 {...stylex.props(styles.heading)}>{strings.heading()}</h3>
        <div {...stylex.props(styles.headerActions)}>
          <OverflowMenu
            label={strings.options()}
            sections={[
              menuSection({
                content: (
                  <>
                    <MenuCheckItem
                      icon={<Sparkles size={ICON} />}
                      label={strings.showPhotoColours()}
                      checked={store.showDots}
                      onCheckedChange={presenter.setShowDots}
                    />
                    <MenuCheckItem
                      icon={<MoveUpRight size={ICON} />}
                      label={strings.showProfileArrows()}
                      checked={store.showField}
                      onCheckedChange={presenter.setShowField}
                    />
                  </>
                ),
              }),
            ]}
          />
          <ResetButton
            label={strings.reset()}
            reset={disabled || store.nodes.length === 0 ? null : presenter.removeAll}
          />
        </div>
      </div>
      <Channels store={store} presenter={presenter} />
      <div {...stylex.props(styles.wheel)}>
        <canvas
          key={presenter.key}
          ref={presenter.attach}
          {...stylex.props(styles.layer, styles.backdrop)}
          aria-hidden="true"
        />
        <Dots store={store} rim={rim} />
        {rim != null && (
          <Overlay store={store} presenter={presenter} rim={rim} disabled={disabled} />
        )}
      </div>
      {selected != null && store.selectedIndex != null && rim != null ? (
        <NodeControls
          node={selected}
          index={store.selectedIndex}
          rim={rim}
          presenter={presenter}
          disabled={disabled}
        />
      ) : (
        <Text variant="muted" as="p" style={styles.hint}>
          {store.nodes.length >= COLOUR_NODES_MAX ? strings.full(COLOUR_NODES_MAX) : strings.hint()}
        </Text>
      )}
    </div>
  );
});

const Channels = observer(function Channels({
  store,
  presenter,
}: {
  store: ColourWheelStore;
  presenter: ColourWheelPresenter;
}): JSX.Element {
  return (
    <div {...stylex.props(styles.channels)} role="radiogroup" aria-label={strings.lightness()}>
      {CHANNEL_POTS.map(({ channel, name, pot }) => {
        const edited = store.edited.has(channel);
        const label = edited ? strings.channelEdited(name()) : name();
        const pick = (
          <Tooltip label={label}>
            <button
              type="button"
              role="radio"
              aria-checked={store.channel === channel}
              aria-label={label}
              {...stylex.props(
                styles.pot,
                pot,
                store.channel === channel && styles.potChosen,
                focusRing.ring,
              )}
              onClick={() => presenter.selectChannel(channel)}
            >
              <span {...stylex.props(styles.dot, edited && styles.dotShown)} aria-hidden="true" />
            </button>
          </Tooltip>
        );
        return (
          <Fragment key={channel ?? 'all'}>
            {pick}
            {channel == null && <span {...stylex.props(styles.divider)} aria-hidden="true" />}
          </Fragment>
        );
      })}
    </div>
  );
});

const Dots = observer(function Dots({
  store,
  rim,
}: {
  store: ColourWheelStore;
  rim: number | null;
}): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null);
  const dots = store.channelDots;
  useEffect(() => {
    const context = canvas.current?.getContext('2d');
    if (context == null) return;
    context.clearRect(0, 0, WHEEL_SIDE, WHEEL_SIDE);
    if (rim == null) return;
    context.fillStyle = 'rgba(255, 255, 255, 0.55)';
    for (const dot of dots) {
      const { x, y } = pointOf(dot, rim);
      context.fillRect(((x + 1) / 2) * WHEEL_SIDE - 1, ((y + 1) / 2) * WHEEL_SIDE - 1, 2, 2);
    }
  }, [dots, rim]);
  return (
    <canvas
      ref={canvas}
      width={WHEEL_SIDE}
      height={WHEEL_SIDE}
      {...stylex.props(styles.layer)}
      aria-hidden="true"
    />
  );
});

const Overlay = observer(function Overlay({
  store,
  presenter,
  rim,
  disabled,
}: {
  store: ColourWheelStore;
  presenter: ColourWheelPresenter;
  rim: number;
  disabled: boolean;
}): JSX.Element {
  const drag = useRef<Drag | null>(null);
  const at = (event: React.PointerEvent, bounds: DOMRect): Hued =>
    huedAt(pointAt(event, bounds), rim);
  const start = (event: React.PointerEvent<SVGElement>, index: number, handle: Handle): void => {
    event.stopPropagation();
    const svg = event.currentTarget.ownerSVGElement;
    if (!event.isPrimary || event.button !== 0 || disabled || drag.current != null || svg == null)
      return;
    event.preventDefault();
    presenter.beginDrag(index);
    drag.current = {
      index,
      handle,
      pointerId: event.pointerId,
      svg,
      bounds: svg.getBoundingClientRect(),
    };
    try {
      svg.setPointerCapture(event.pointerId);
    } catch {
      drag.current = null;
      presenter.cancelDrag();
    }
  };
  const release = useCallback((pointerId: number): boolean => {
    const active = drag.current;
    if (active == null || active.pointerId !== pointerId) return false;
    drag.current = null;
    if (active.svg.hasPointerCapture(pointerId)) active.svg.releasePointerCapture(pointerId);
    return true;
  }, []);
  const cancel = useCallback(
    (pointerId: number): void => {
      if (release(pointerId)) presenter.cancelDrag();
    },
    [presenter, release],
  );
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const active = drag.current;
      if (event.key !== 'Escape' || active == null) return;
      event.preventDefault();
      event.stopPropagation();
      cancel(active.pointerId);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [cancel]);

  const selected = store.selectedNode;
  const place = (hued: Hued): Point => pointOf(hued, rim);
  return (
    <svg
      viewBox="-1 -1 2 2"
      {...stylex.props(styles.layer, styles.overlay, disabled && styles.disabled)}
      role="group"
      aria-label={strings.wheel()}
      aria-disabled={disabled}
      onPointerDown={(event) => {
        if (!event.isPrimary || event.button !== 0 || disabled || drag.current != null) return;
        const point = pointAt(event, event.currentTarget.getBoundingClientRect());
        presenter.press(Math.hypot(point.x, point.y) <= 1 ? huedAt(point, rim) : null);
      }}
      onPointerMove={(event) => {
        const active = drag.current;
        if (active == null || active.pointerId !== event.pointerId) return;
        presenter.drag(active.index, active.handle, at(event, active.bounds));
      }}
      onPointerUp={(event) => {
        if (release(event.pointerId)) presenter.endDrag();
      }}
      onPointerCancel={(event) => cancel(event.pointerId)}
      onLostPointerCapture={(event) => cancel(event.pointerId)}
    >
      <defs>
        <marker
          id="colour-wheel-head"
          viewBox="0 0 10 10"
          refX="10"
          refY="5"
          markerWidth="4"
          markerHeight="4"
          orient="auto-start-reverse"
        >
          <path d="M0 0 L10 5 L0 10 Z" {...stylex.props(styles.head)} />
        </marker>
        <marker
          id="colour-wheel-field-head"
          viewBox="0 0 10 10"
          refX="10"
          refY="5"
          markerUnits="userSpaceOnUse"
          markerWidth={FIELD_HEAD}
          markerHeight={FIELD_HEAD}
          orient="auto-start-reverse"
        >
          <path d="M0 0 L10 5 L0 10 Z" {...stylex.props(styles.fieldHead)} />
        </marker>
      </defs>
      <path d={edgePath(store.drawn?.edge ?? [], rim)} {...stylex.props(styles.edge)} />
      {store.channelField.map(({ from, to }, index) => {
        const [a, b] = [place(from), place(to)];
        if (Math.hypot(b.x - a.x, b.y - a.y) < SHORTEST_FIELD_ARROW) return null;
        return (
          <line
            key={index}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            markerEnd="url(#colour-wheel-field-head)"
            {...stylex.props(styles.field)}
          />
        );
      })}
      {store.shown.map(({ node, index }) => {
        const { x, y } = place(node);
        const chosen = index === store.selectedIndex;
        return (
          <circle
            key={index}
            cx={x}
            cy={y}
            {...stylex.props(styles.node, chosen && styles.nodeChosen, focusRing.ring)}
            role="button"
            tabIndex={disabled ? -1 : 0}
            aria-label={strings.edit(node.hue)}
            aria-pressed={chosen}
            onPointerDown={(event) => start(event, index, 'source')}
            onKeyDown={(event) => {
              if (disabled) return;
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                presenter.select(index);
              } else if (event.key === 'Delete' || event.key === 'Backspace') {
                event.preventDefault();
                presenter.remove(index);
              }
            }}
          />
        );
      })}
      {/* Over the nodes: a new edit's target starts on its own node, and must be grabbable there. */}
      {selected != null && store.selectedIndex != null && (
        <Selected
          node={selected}
          index={store.selectedIndex}
          rim={rim}
          disabled={disabled}
          start={start}
          step={presenter.stepReach}
        />
      )}
    </svg>
  );
});

function Selected({
  node,
  index,
  rim,
  disabled,
  start,
  step,
}: {
  node: ColourNode;
  index: number;
  rim: number;
  disabled: boolean;
  start: (event: React.PointerEvent<SVGElement>, index: number, handle: Handle) => void;
  step: (index: number, reach: Reach, by: number) => void;
}): JSX.Element {
  const from = pointOf(node, rim);
  const to = pointOf({ hue: node.targetHue, chroma: node.targetChroma }, rim);
  const reached = chromaReached(node);
  const edgeMiddle = (reached.inner + reached.outer) / 2;
  const sides = [
    { side: 'after', hue: node.hue + node.hueReach },
    { side: 'before', hue: node.hue - node.hueReach },
  ].slice(0, reachesEveryHue(node) ? 1 : 2);
  const handle = { index, disabled, start, step };
  return (
    <g aria-disabled={disabled}>
      <path d={reachPath(node, rim)} {...stylex.props(styles.reach)} />
      <Arrow from={from} to={to} />
      <TwoWay
        {...handle}
        at={pointOf({ hue: node.hue, chroma: reached.outer }, rim)}
        turn={-node.hue}
        label={strings.saturationRange()}
        reach="chromaReach"
        value={node.chromaReach}
        range={{ min: 0, max: rim }}
      />
      {sides.map(({ side, hue }) => (
        <TwoWay
          key={side}
          {...handle}
          at={pointOf({ hue, chroma: edgeMiddle }, rim)}
          turn={90 - hue}
          label={strings.hueRange()}
          reach="hueReach"
          value={node.hueReach}
          range={{ min: LEAST_HUE_REACH, max: MOST_HUE_REACH }}
        />
      ))}
      <circle
        cx={to.x}
        cy={to.y}
        r={TARGET_RADIUS}
        {...stylex.props(styles.target)}
        role="img"
        aria-label={strings.outputColour()}
        onPointerDown={(event) => start(event, index, 'target')}
      />
    </g>
  );
}

function Arrow({ from, to }: { from: Point; to: Point }): JSX.Element | null {
  const apart = Math.hypot(to.x - from.x, to.y - from.y);
  if (apart <= NODE_RADIUS + TARGET_RADIUS) return null;
  const short = (gap: number): Point => ({
    x: to.x - ((to.x - from.x) / apart) * gap,
    y: to.y - ((to.y - from.y) / apart) * gap,
  });
  const tail = short(apart - NODE_RADIUS);
  const tip = short(TARGET_RADIUS);
  return (
    <line
      x1={tail.x}
      y1={tail.y}
      x2={tip.x}
      y2={tip.y}
      markerEnd="url(#colour-wheel-head)"
      {...stylex.props(styles.arrow)}
    />
  );
}

function TwoWay({
  index,
  disabled,
  start,
  step,
  at,
  turn,
  label,
  reach,
  value,
  range,
}: {
  index: number;
  disabled: boolean;
  start: (event: React.PointerEvent<SVGElement>, index: number, handle: Handle) => void;
  step: (index: number, reach: Reach, by: number) => void;
  at: Point;
  turn: number;
  label: string;
  reach: Reach;
  value: number;
  range: { min: number; max: number };
}): JSX.Element {
  return (
    <g
      transform={`translate(${at.x} ${at.y}) rotate(${turn})`}
      {...stylex.props(focusRing.ring)}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={range.min}
      aria-valuemax={range.max}
      onPointerDown={(event) => start(event, index, reach)}
      onKeyDown={(event) => {
        const direction = KEY_DIRECTIONS[event.key];
        if (disabled || direction == null) return;
        event.preventDefault();
        step(index, reach, direction * REACH_STEPS[reach] * (event.shiftKey ? 10 : 1));
      }}
    >
      <circle r={HANDLE_GRAB} {...stylex.props(styles.grab)} />
      <path d={TWO_WAY} {...stylex.props(styles.twoWay)} />
    </g>
  );
}

const NodeControls = observer(function NodeControls({
  node,
  index,
  rim,
  presenter,
  disabled,
}: {
  node: ColourNode;
  index: number;
  rim: number;
  presenter: ColourWheelPresenter;
  disabled: boolean;
}): JSX.Element {
  const row = (
    label: string,
    key: keyof ColourNode,
    range: { min: number; max: number; step: number },
    neutral: number,
    unit = '',
  ): JSX.Element => {
    const value = Number(node[key] ?? 0);
    const format = (at: number): string =>
      RawEditPanelStrings.valueWithUnit(reading(at, range), unit);
    return (
      <EditControl
        key={key}
        label={label}
        value={format(value)}
        reset={
          disabled || value === neutral
            ? null
            : () => presenter.settleNode(index, { [key]: neutral })
        }
        typing={
          disabled
            ? null
            : { ...range, set: (typed) => presenter.settleNode(index, { [key]: typed }) }
        }
      >
        <Slider
          style={panelStyles.slider}
          value={value}
          onChange={(next) => presenter.previewNode(index, { [key]: next })}
          onCommit={(next) => presenter.settleNode(index, { [key]: next })}
          min={range.min}
          max={range.max}
          step={range.step}
          snap={[neutral]}
          label={label}
          valueText={format}
          disabled={disabled}
        />
      </EditControl>
    );
  };
  return (
    <div {...stylex.props(styles.controls)}>
      {node.lightness != null &&
        row(
          strings.lightnessRange(),
          'lightnessReach',
          { min: 0, max: MOST_LIGHTNESS_REACH, step: 1 },
          LIGHTNESS_REACH,
        )}
      {row(strings.outputHue(), 'targetHue', { min: 0, max: 360, step: 1 }, node.hue, '°')}
      {row(
        strings.outputSaturation(),
        'targetChroma',
        { min: 0, max: Math.round(rim), step: 0.1 },
        node.chroma,
      )}
      {row(
        strings.outputLightness(),
        'targetLightness',
        { min: 0, max: MOST_TARGET_LIGHTNESS, step: 1 },
        lightnessOf(node.lightness),
      )}
      <Button style={styles.remove} disabled={disabled} onClick={() => presenter.remove(index)}>
        {strings.remove()}
      </Button>
    </div>
  );
});
