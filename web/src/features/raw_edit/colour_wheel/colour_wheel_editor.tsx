import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useRef } from 'react';
import type { ColourNode } from '../../../../../src/schemas/photo_edits';
import { focusRing } from '../../../ui/focus_ring';
import { Slider } from '../../../ui/slider';
import { Text } from '../../../ui/text';
import { EditControl, ResetButton } from '../edit_control';
import { reading } from '../edit_sliders';
import { RawEditPanelStrings } from '../raw_edit_panel.strings';
import { styles as panelStyles } from '../raw_edit_panel.stylex';
import type { StageStore } from '../stage/stage_store';
import {
  CHANNELS,
  CHROMA_REACH,
  HUE_REACH,
  LIGHTNESS_REACH,
  MOST_HUE_REACH,
  type Channel,
  type Hued,
  type Point,
  edgePath,
  huedAt,
  lightnessOf,
  pointOf,
  reachPath,
} from './colour_wheel';
import { ColourWheelStrings as strings } from './colour_wheel.strings';
import { type ColourWheelPresenter, type Handle, WHEEL_SIDE } from './colour_wheel_presenter';
import type { ColourWheelStore } from './colour_wheel_store';
import { styles } from './colour_wheel_editor.stylex';

const CHANNEL_NAMES: { channel: Channel; name: () => string }[] = [
  { channel: CHANNELS[0], name: strings.shadows },
  { channel: CHANNELS[1], name: strings.darks },
  { channel: CHANNELS[2], name: strings.midtones },
  { channel: CHANNELS[3], name: strings.lights },
  { channel: CHANNELS[4], name: strings.highlights },
  { channel: null, name: strings.all },
];

const MOST_TARGET_LIGHTNESS = 150;
const MOST_LIGHTNESS_REACH = 60;
const SHORTEST_FIELD_ARROW = 0.01;

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
        <ResetButton
          label={strings.reset()}
          reset={disabled || store.nodes.length === 0 ? null : presenter.removeAll}
        />
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
          {strings.hint()}
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
      {CHANNEL_NAMES.map(({ channel, name }) => {
        const edited = store.edited.has(channel);
        return (
          <button
            key={channel ?? 'all'}
            type="button"
            role="radio"
            aria-checked={store.channel === channel}
            aria-label={edited ? strings.channelEdited(name()) : name()}
            {...stylex.props(
              styles.channel,
              focusRing.ring,
              store.channel === channel && styles.channelChosen,
            )}
            onClick={() => presenter.selectChannel(channel)}
          >
            {name()}
            <span {...stylex.props(styles.dot, edited && styles.dotShown)} aria-hidden="true" />
          </button>
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
        if (Math.hypot(point.x, point.y) <= 1) presenter.add(huedAt(point, rim));
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
          refX="8"
          refY="5"
          markerWidth="4"
          markerHeight="4"
          orient="auto-start-reverse"
        >
          <path d="M0 0 L10 5 L0 10 Z" {...stylex.props(styles.head)} />
        </marker>
      </defs>
      <path d={edgePath(store.drawn?.edge ?? [], rim)} {...stylex.props(styles.edge)} />
      {store.channelField.map(({ from, to }, index) => {
        const [a, b] = [place(from), place(to)];
        if (Math.hypot(b.x - a.x, b.y - a.y) < SHORTEST_FIELD_ARROW) return null;
        return (
          <line key={index} x1={a.x} y1={a.y} x2={b.x} y2={b.y} {...stylex.props(styles.field)} />
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
}: {
  node: ColourNode;
  index: number;
  rim: number;
  disabled: boolean;
  start: (event: React.PointerEvent<SVGElement>, index: number, handle: Handle) => void;
}): JSX.Element {
  const from = pointOf(node, rim);
  const to = pointOf({ hue: node.targetHue, chroma: node.targetChroma }, rim);
  const outer = pointOf({ hue: node.hue, chroma: node.chroma + node.chromaReach }, rim);
  const side = pointOf({ hue: node.hue + node.hueReach, chroma: node.chroma }, rim);
  const handle = (point: Point, label: string, kind: Handle): JSX.Element => (
    <circle
      cx={point.x}
      cy={point.y}
      {...stylex.props(styles.handle, kind === 'target' && styles.target)}
      role="img"
      aria-label={label}
      tabIndex={-1}
      onPointerDown={(event) => start(event, index, kind)}
    />
  );
  return (
    <g aria-disabled={disabled}>
      <path d={reachPath(node, rim)} {...stylex.props(styles.reach)} />
      <line
        x1={from.x}
        y1={from.y}
        x2={to.x}
        y2={to.y}
        markerEnd="url(#colour-wheel-head)"
        {...stylex.props(styles.arrow)}
      />
      {handle(outer, strings.saturationRange(), 'chromaReach')}
      {node.hueReach < MOST_HUE_REACH && handle(side, strings.hueRange(), 'hueReach')}
      {handle(to, strings.newColour(), 'target')}
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
  const chroma = { min: 0, max: Math.round(rim), step: 0.1 };
  return (
    <div {...stylex.props(styles.controls)}>
      <Text as="span" style={styles.subheading}>
        {strings.newColour()}
      </Text>
      {row(strings.hue(), 'targetHue', { min: 0, max: 360, step: 1 }, node.hue, '°')}
      {row(strings.saturation(), 'targetChroma', chroma, node.chroma)}
      {row(
        strings.lightness(),
        'targetLightness',
        { min: 0, max: MOST_TARGET_LIGHTNESS, step: 1 },
        lightnessOf(node.lightness),
      )}
      {row(
        strings.hueRange(),
        'hueReach',
        { min: 1, max: MOST_HUE_REACH, step: 1 },
        HUE_REACH,
        '°',
      )}
      {row(strings.saturationRange(), 'chromaReach', chroma, CHROMA_REACH)}
      {node.lightness != null &&
        row(
          strings.lightnessRange(),
          'lightnessReach',
          { min: 0, max: MOST_LIGHTNESS_REACH, step: 1 },
          LIGHTNESS_REACH,
        )}
      <button
        type="button"
        {...stylex.props(styles.remove, focusRing.ring)}
        disabled={disabled}
        onClick={() => presenter.remove(index)}
      >
        {strings.remove()}
      </button>
    </div>
  );
});
