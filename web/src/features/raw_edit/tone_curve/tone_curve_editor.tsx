import * as stylex from '@stylexjs/stylex';
import { RotateCcw } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useRef } from 'react';
import type { ToneCurve } from '../../../../../src/schemas/photo_edits';
import { focusRing } from '../../../ui/focus_ring';
import type { EditStore } from '../edit/edit_store';
import type { RawEditPresenter } from '../stage/raw_edit_presenter';
import type { StageStore } from '../stage/stage_store';
import { IDENTITY_CURVE, evaluate, insertPoint, movePoint, nudgePoint, removePoint, tangents } from './tone_curve';
import { styles } from './tone_curve_editor.stylex';
import { ToneCurveEditorStrings as strings } from './tone_curve_editor.strings';

type CurvePresenter = Pick<RawEditPresenter, 'previewToneCurve' | 'settleToneCurve'>;
type Drag = { index: number; pointerId: number; changed: boolean; before: ToneCurve | null; bounds: DOMRect };
const clamp = (value: number): number => Math.max(0, Math.min(1, value));

export const ToneCurveEditor = observer(function ToneCurveEditor({ edit, stage, presenter }: {
  edit: EditStore;
  stage: StageStore;
  presenter: CurvePresenter;
}): JSX.Element {
  const drag = useRef<Drag | null>(null);
  const known = stage.detail != null;
  const disabled = !known || !stage.editable;
  const points = edit.doc?.toneCurve ?? (edit.doc?.colourProfile === 'none' ? null : stage.cameraCurve) ?? IDENTITY_CURVE;
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
    drag.current = { index, pointerId, changed, before, bounds };
    try {
      svg.setPointerCapture(pointerId);
    } catch {
      // The pointer may have left before capture.
    }
  };
  const release = (event: React.PointerEvent<SVGSVGElement>): Drag | null => {
    const active = drag.current;
    if (active == null || active.pointerId !== event.pointerId) return null;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    return active;
  };
  const end = (event: React.PointerEvent<SVGSVGElement>): void => {
    const active = release(event);
    if (active?.changed && edit.doc?.toneCurve != null) presenter.settleToneCurve(edit.doc.toneCurve);
  };
  const cancel = (event: React.PointerEvent<SVGSVGElement>): void => {
    const active = release(event);
    if (active?.changed) presenter.previewToneCurve(active.before);
  };

  return <div {...stylex.props(styles.editor)}>
    <div {...stylex.props(styles.header)}>
      <h3 {...stylex.props(styles.heading)}>{strings.heading()}</h3>
      {edit.doc?.toneCurve != null && <button
        type="button"
        {...stylex.props(styles.reset, focusRing.ring)}
        aria-label={strings.reset()}
        disabled={disabled}
        onClick={() => presenter.settleToneCurve(null)}
      ><RotateCcw size={14} /></button>}
    </div>
    <svg
      {...stylex.props(styles.plot, disabled && styles.disabled)}
      viewBox="0 0 100 100"
      role="group"
      aria-label={strings.heading()}
      aria-disabled={disabled}
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        if (!event.isPrimary || drag.current != null || disabled || event.button !== 0) return;
        const svg = event.currentTarget;
        const bounds = svg.getBoundingClientRect();
        const [x] = position(event, bounds);
        const inserted = insertPoint(points, x);
        if (inserted == null) return;
        const before = edit.doc?.toneCurve ?? null;
        presenter.previewToneCurve(inserted.points);
        start(svg, event.pointerId, inserted.index, true, before, bounds);
      }}
      onPointerMove={(event) => {
        const active = drag.current;
        if (active == null || active.pointerId !== event.pointerId || active.index < 0) return;
        const current = edit.doc?.toneCurve ?? points;
        const [x, y] = position(event, active.bounds);
        if (active.index > 0 && active.index < current.length - 1 && (x < -0.15 || x > 1.15 || y < -0.15 || y > 1.15)) {
          presenter.previewToneCurve(removePoint(current, active.index));
          active.index = -1;
        } else {
          const next = movePoint(current, active.index, clamp(x), clamp(y));
          if (next === current) return;
          presenter.previewToneCurve(next);
        }
        active.changed = true;
      }}
      onPointerUp={end}
      onPointerCancel={cancel}
      onLostPointerCapture={cancel}
    >
      <rect width="100" height="100" fill="transparent" />
      {[25, 50, 75].map((at) => <g key={at}>
        <line x1={at} y1="0" x2={at} y2="100" {...stylex.props(styles.grid)} />
        <line x1="0" y1={at} x2="100" y2={at} {...stylex.props(styles.grid)} />
      </g>)}
      {known && <>
        <path d="M0 100 L100 0" {...stylex.props(styles.reference)} />
        <line x1="50" y1="0" x2="50" y2="100" {...stylex.props(styles.white)} />
        <line x1="0" y1="50" x2="100" y2="50" {...stylex.props(styles.white)} />
        <path d={path} {...stylex.props(styles.curve)} />
      </>}
      {known && points.map(([x, y], index) => {
        const name = index === 0 ? strings.blackPoint()
          : index === points.length - 1 ? strings.whitePoint() : strings.curvePoint(index);
        return <g key={index}>
          <circle
            cx={x * 100}
            cy={(1 - y) * 100}
            r="11"
            {...stylex.props(styles.pointTarget, focusRing.ring)}
            role="button"
            tabIndex={disabled ? -1 : 0}
            aria-label={strings.pointPosition(name, x, y)}
            aria-disabled={disabled}
            onPointerDown={(event) => {
              event.stopPropagation();
              if (!event.isPrimary || drag.current != null || disabled || event.button !== 0) return;
              if (event.currentTarget.ownerSVGElement != null) {
                start(event.currentTarget.ownerSVGElement, event.pointerId, index, false, edit.doc?.toneCurve ?? null);
              }
            }}
            onDoubleClick={(event) => {
              event.stopPropagation();
              if (!disabled && index > 0 && index < points.length - 1) presenter.settleToneCurve(removePoint(points, index));
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (!disabled && index > 0 && index < points.length - 1) presenter.settleToneCurve(removePoint(points, index));
            }}
            onKeyDown={(event) => {
              if (disabled) return;
              if ((event.key === 'Delete' || event.key === 'Backspace') && index > 0 && index < points.length - 1) {
                event.preventDefault();
                presenter.settleToneCurve(removePoint(points, index));
              } else if (event.key.startsWith('Arrow')) {
                event.preventDefault();
                const next = nudgePoint(points, index, event.key, event.shiftKey ? 0.05 : 0.01);
                if (next !== points) presenter.settleToneCurve(next);
              }
            }}
          />
          <circle cx={x * 100} cy={(1 - y) * 100} r="3.5" {...stylex.props(styles.point)} />
        </g>;
      })}
    </svg>
  </div>;
});
