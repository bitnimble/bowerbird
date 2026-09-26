import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useRef, useState } from 'react';
import { DIFFUSE_WHITE_CODE, TONE_CURVE_KIND, type ToneCurve, type ToneCurvePoints } from '../../../../../src/schemas/photo_edits';
import { focusRing } from '../../../ui/focus_ring';
import type { EditStore } from '../edit/edit_store';
import { ResetButton } from '../edit_control';
import type { RawEditPresenter } from '../stage/raw_edit_presenter';
import type { StageStore } from '../stage/stage_store';
import { IDENTITY_CURVE, clamp, evaluate, insertInWidestGap, insertPoint, movePoint, nudgePoint, removePoint, tangents } from './tone_curve';
import { pointMarker, styles } from './tone_curve_editor.stylex';
import { ToneCurveEditorStrings as strings } from './tone_curve_editor.strings';

type CurvePresenter = Pick<RawEditPresenter, 'previewToneCurve' | 'settleToneCurve'>;
type Drag = { index: number; pointerId: number; svg: SVGSVGElement; changed: boolean; before: ToneCurve | null; bounds: DOMRect };
const storedCurve = (points: ToneCurvePoints): ToneCurve => ({ kind: TONE_CURVE_KIND, points });

export const ToneCurveEditor = observer(function ToneCurveEditor({ edit, stage, presenter }: {
  edit: EditStore;
  stage: StageStore;
  presenter: CurvePresenter;
}): JSX.Element {
  const drag = useRef<Drag | null>(null);
  const lastPressed = useRef<number | null>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const headerKnown = stage.headerKnown;
  const disabled = !headerKnown || !stage.editable;
  const points = edit.doc?.toneCurve?.points ?? stage.cameraCurve?.points ?? IDENTITY_CURVE;
  const remove = (index: number | null): void => {
    if (disabled || drag.current != null || index == null) return;
    const next = removePoint(points, index);
    if (next !== points) presenter.settleToneCurve(storedCurve(next));
  };
  const add = (): void => {
    if (disabled || drag.current != null) return;
    const inserted = insertInWidestGap(points);
    if (inserted != null) presenter.settleToneCurve(storedCurve(inserted.points));
  };
  const slopes = tangents(points);
  const path = Array.from({ length: 129 }, (_, index) => {
    const x = index / 128;
    return `${index === 0 ? 'M' : 'L'}${x * 100} ${100 - evaluate(points, x, slopes) * 100}`;
  }).join(' ');
  const position = (event: React.PointerEvent<SVGSVGElement>, bounds: DOMRect): [number, number] => [
    (event.clientX - bounds.left) / bounds.width,
    1 - (event.clientY - bounds.top) / bounds.height,
  ];
  const start = (svg: SVGSVGElement, pointerId: number, index: number, changed: boolean,
    before: ToneCurve | null, bounds = svg.getBoundingClientRect()): void => {
    drag.current = { index, pointerId, svg, changed, before, bounds };
    setActiveIndex(index);
    try {
      svg.setPointerCapture(pointerId);
    } catch {
      drag.current = null;
      setActiveIndex(null);
      if (changed) presenter.previewToneCurve(before);
    }
  };
  const release = useCallback((pointerId: number): Drag | null => {
    const active = drag.current;
    if (active == null || active.pointerId !== pointerId) return null;
    drag.current = null;
    setActiveIndex(null);
    if (active.svg.hasPointerCapture(pointerId)) active.svg.releasePointerCapture(pointerId);
    return active;
  }, []);
  const end = (event: React.PointerEvent<SVGSVGElement>): void => {
    const active = release(event.pointerId);
    if (active?.changed && edit.doc?.toneCurve != null) presenter.settleToneCurve(edit.doc.toneCurve);
  };
  const cancel = useCallback((pointerId: number): void => {
    const active = release(pointerId);
    if (active?.changed) presenter.previewToneCurve(active.before);
  }, [presenter, release]);

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

  return <div {...stylex.props(styles.editor)}>
    <div {...stylex.props(styles.header)}>
      <h3 {...stylex.props(styles.heading)}>{strings.heading()}</h3>
      <ResetButton
        label={strings.reset()}
        reset={disabled || edit.doc?.toneCurve == null ? null : () => presenter.settleToneCurve(null)}
      />
    </div>
    <svg
      {...stylex.props(styles.plot, focusRing.ring, disabled && styles.disabled)}
      role="group"
      aria-label={strings.heading()}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      onContextMenu={(event) => event.preventDefault()}
      onDoubleClick={() => remove(lastPressed.current)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === 'Insert' || event.key === ' ') {
          event.preventDefault();
          add();
        }
      }}
      onPointerDown={(event) => {
        if (!event.isPrimary || drag.current != null || disabled || event.button !== 0) return;
        event.preventDefault();
        lastPressed.current = null;
        const svg = event.currentTarget;
        const bounds = svg.getBoundingClientRect();
        const [x] = position(event, bounds);
        const inserted = insertPoint(points, x);
        if (inserted == null) return;
        const before = edit.doc?.toneCurve ?? null;
        presenter.previewToneCurve(storedCurve(inserted.points));
        start(svg, event.pointerId, inserted.index, true, before, bounds);
      }}
      onPointerMove={(event) => {
        const active = drag.current;
        if (active == null || active.pointerId !== event.pointerId || active.index < 0) return;
        const current = edit.doc?.toneCurve?.points ?? points;
        if (active.index >= current.length) return;
        const [x, y] = position(event, active.bounds);
        if (active.index > 0 && active.index < current.length - 1 && (x < -0.15 || x > 1.15 || y < -0.15 || y > 1.15)) {
          presenter.previewToneCurve(storedCurve(removePoint(current, active.index)));
          active.index = -1;
          setActiveIndex(null);
        } else {
          const next = movePoint(current, active.index, clamp(x, 0, 1), clamp(y, 0, 1));
          if (next === current) return;
          presenter.previewToneCurve(storedCurve(next));
        }
        active.changed = true;
      }}
      onPointerUp={end}
      onPointerCancel={(event) => cancel(event.pointerId)}
      onLostPointerCapture={(event) => cancel(event.pointerId)}
    >
      <svg viewBox="0 0 100 100">
        <rect width="100" height="100" fill="transparent" />
        {[25, 50, 75].map((at) => <g key={at}>
          <line x1={at} y1="0" x2={at} y2="100" {...stylex.props(styles.grid)} />
          <line x1="0" y1={at} x2="100" y2={at} {...stylex.props(styles.grid)} />
        </g>)}
        {headerKnown && <>
          <path d="M0 100 L100 0" {...stylex.props(styles.reference)} />
          <line x1={DIFFUSE_WHITE_CODE * 100} y1="0" x2={DIFFUSE_WHITE_CODE * 100} y2="100" {...stylex.props(styles.white)} />
          <line x1="0" y1={DIFFUSE_WHITE_CODE * 100} x2="100" y2={DIFFUSE_WHITE_CODE * 100} {...stylex.props(styles.white)} />
          <path d={path} {...stylex.props(styles.curve)} />
        </>}
      </svg>
      {headerKnown && points.map(([x, y], index) => {
        const name = index === 0 ? strings.blackPoint()
          : index === points.length - 1 ? strings.whitePoint() : strings.curvePoint(index);
        const cx = `${x * 100}%`;
        const cy = `${(1 - y) * 100}%`;
        return <g key={index} {...stylex.props(pointMarker)}>
          <circle
            cx={cx}
            cy={cy}
            r="11%"
            {...stylex.props(styles.pointTarget)}
            role="slider"
            tabIndex={disabled ? -1 : 0}
            aria-label={strings.pointPosition(name, x, y)}
            aria-disabled={disabled}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(y * 100)}
            aria-valuetext={strings.pointPosition(name, x, y)}
            onPointerDown={(event) => {
              event.stopPropagation();
              if (!event.isPrimary || drag.current != null || disabled || event.button !== 0) return;
              event.preventDefault();
              lastPressed.current = index;
              event.currentTarget.focus();
              if (event.currentTarget.ownerSVGElement != null) {
                start(event.currentTarget.ownerSVGElement, event.pointerId, index, false, edit.doc?.toneCurve ?? null);
              }
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              remove(index);
            }}
            onKeyDown={(event) => {
              if (disabled) return;
              if (event.key === 'Delete' || event.key === 'Backspace') {
                event.preventDefault();
                remove(index);
              } else if (event.key === 'Enter' || event.key === 'Insert' || event.key === ' ') {
                event.preventDefault();
                add();
              } else if (event.key.startsWith('Arrow') && drag.current == null) {
                event.preventDefault();
                const next = nudgePoint(points, index, event.key, event.shiftKey ? 0.05 : 0.01);
                if (next !== points) presenter.settleToneCurve(storedCurve(next));
              }
            }}
          />
          <circle
            cx={cx}
            cy={cy}
            {...stylex.props(styles.point, activeIndex === index && styles.pointActive)}
            aria-hidden="true"
          />
        </g>;
      })}
    </svg>
  </div>;
});
