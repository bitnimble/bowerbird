import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { EXPORT_FORMATS, writesSdr, type ExportFormat } from '../../../../src/schemas/export';
import { FileRenderingIntentSchema, type FileRenderingIntent } from '../../../../src/schemas/rendering_intent';
import { IntentChoiceStrings } from '../raw_edit/proof/intent_choice.strings';
import type { ReactNode } from 'react';
import { useExportStore, usePresenters } from '../../app/stores_context';
import { Button } from '../../ui/button';
import { focusRing } from '../../ui/focus_ring';
import { fileSizeLabel } from '../../ui/format';
import { Modal } from '../../ui/modal';
import { ModalStrings } from '../../ui/modal.strings';
import type { Option } from '../../ui/option';
import { Select } from '../../ui/select';
import { Slider } from '../../ui/slider';
import { color } from '../../ui/tokens.stylex';
import { ExportStrings } from './export.strings';

const styles = stylex.create({
  dialog: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    minWidth: '420px',
    maxWidth: '520px',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '16px',
    paddingBlock: '8px',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: color.slate,
  },
  label: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    minWidth: 0,
  },
  hint: {
    fontSize: '12px',
    color: color.boneDim,
  },
  control: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
  },
  reading: {
    minWidth: '24px',
    fontVariantNumeric: 'tabular-nums',
    textAlign: 'right',
    color: color.boneDim,
    fontSize: '13px',
  },
  foot: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    paddingTop: '14px',
  },
  estimate: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  error: {
    margin: 0,
    color: color.rose,
    fontSize: '13px',
  },
  actions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '8px',
  },
});

const FORMAT_LABELS: Record<ExportFormat, string> = {
  jpeg: ExportStrings.formatJpeg(),
  avif: ExportStrings.formatAvif(),
  jxl: ExportStrings.formatJxl(),
  png: ExportStrings.formatPng(),
  tiff: ExportStrings.formatTiff(),
};

// Only what this build can write. A format offered here and refused by the route would be a
// dialog that fails after the reader has waited for a render.
const FORMATS: Option<ExportFormat>[] = (Object.keys(FORMAT_LABELS) as ExportFormat[])
  .filter((format) => EXPORT_FORMATS[format].encoder)
  .map((format) => ({ value: format, label: FORMAT_LABELS[format] }));

// The sizes a reader actually asks for, plus the frame as shot. Long edges rather than
// dimensions, since a portrait and a landscape frame want the same longest side.
const LONG_EDGES: Option<string>[] = [
  { value: '0', label: ExportStrings.resolutionFull() },
  ...[4096, 3840, 2560, 1920, 1280].map((px) => ({ value: String(px), label: ExportStrings.resolutionLongEdge(px) })),
];

const INTENTS: Option<FileRenderingIntent>[] = FileRenderingIntentSchema.options
  .map((intent) => ({ value: intent, label: IntentChoiceStrings[intent]() }));

function hdrHint(unavailable: boolean, gainMappable: boolean, format: ExportFormat): string {
  if (!unavailable) return ExportStrings.exportHdrHint();
  const named = FORMAT_LABELS[format];
  return gainMappable ? ExportStrings.exportHdrNeedsGainMap(named) : ExportStrings.exportHdrUnavailable(named);
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }): JSX.Element {
  return (
    <div {...stylex.props(styles.row)}>
      <div {...stylex.props(styles.label)}>
        <span>{label}</span>
        {hint == null ? null : <span {...stylex.props(styles.hint)}>{hint}</span>}
      </div>
      <div {...stylex.props(styles.control)}>{children}</div>
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}): JSX.Element {
  return (
    <Row label={label} hint={hint}>
      <input
        {...stylex.props(focusRing.ring)}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={label}
      />
    </Row>
  );
}

export const ExportDialog = observer(function ExportDialog(): JSX.Element | null {
  const store = useExportStore();
  const { export: presenter } = usePresenters();
  if (!store.open) return null;

  const options = store.options;
  const effective = store.effective;
  const format = EXPORT_FORMATS[options.format];
  const mappable = format.gainMap && format.gainMapEncoder;
  const count = store.count;
  const estimate = store.estimateBytes;

  return (
    <Modal open={store.open} onOpenChange={(open) => (open ? undefined : presenter.close())} title={count > 1 ? ExportStrings.titleMany(count) : ExportStrings.title()}>
      <div {...stylex.props(styles.dialog)}>
        <Row label={ExportStrings.format()}>
          <Select options={FORMATS} value={options.format} onChange={(value) => presenter.set('format', value)} label={ExportStrings.format()} />
        </Row>

        <Row label={ExportStrings.resolution()}>
          <Select
            options={LONG_EDGES}
            value={String(options.longEdge)}
            onChange={(value) => presenter.set('longEdge', Number(value))}
            label={ExportStrings.resolution()}
          />
        </Row>

        {format.lossless ? null : (
          <Row label={ExportStrings.quality()}>
            {/* The number as well as the track: `Slider`'s `valueText` is announced and not drawn,
                and a quality nobody can read is one nobody can come back to. */}
            <span {...stylex.props(styles.reading)}>{ExportStrings.qualityValue(options.quality)}</span>
            <Slider
              value={options.quality}
              onChange={(value) => presenter.set('quality', value)}
              min={0}
              max={100}
              step={1}
              label={ExportStrings.quality()}
              valueText={ExportStrings.qualityValue}
            />
          </Row>
        )}

        <Toggle
          label={ExportStrings.includeEdits()}
          hint={ExportStrings.includeEditsHint()}
          checked={options.includeEdits}
          onChange={(value) => presenter.set('includeEdits', value)}
        />

        <Toggle
          label={ExportStrings.halfSize()}
          hint={ExportStrings.halfSizeHint()}
          checked={options.halfSize}
          onChange={(value) => presenter.set('halfSize', value)}
        />

        <Toggle
          label={ExportStrings.exportHdr()}
          // Says *why* it cannot, rather than greying out silently: the reason is the format
          // the reader picked, and it is one control away from being fixable.
          hint={hdrHint(store.hdrUnavailable, mappable, options.format)}
          checked={effective.exportHdr}
          disabled={!format.hdr && !mappable}
          onChange={(value) => presenter.set('exportHdr', value)}
        />

        {/* Gone rather than greyed where it can do nothing. What it is asked against is the
            requested HDR rather than the honoured one: in a JPEG the map is *how* the range gets
            carried, so reading the honoured value would hide the one control that turns HDR on. */}
        {mappable && options.exportHdr ? (
          <Toggle
            label={ExportStrings.gainMap()}
            hint={ExportStrings.gainMapHint()}
            checked={effective.gainMap}
            onChange={(value) => presenter.set('gainMap', value)}
          />
        ) : null}

        {writesSdr(options) ? (
          <Row label={IntentChoiceStrings.renderingIntent()}>
            <Select
              options={INTENTS}
              value={options.renderingIntent}
              onChange={(value) => presenter.set('renderingIntent', value)}
              label={IntentChoiceStrings.renderingIntent()}
            />
          </Row>
        ) : null}

        <div {...stylex.props(styles.foot)}>
          <div {...stylex.props(styles.estimate)}>
            <span>{estimate == null ? ExportStrings.estimateUnknown() : ExportStrings.estimate(fileSizeLabel(estimate))}</span>
          </div>
          {store.error == null ? null : <p {...stylex.props(styles.error)}>{store.error}</p>}
          <div {...stylex.props(styles.actions)}>
            <Button variant="ghost" onClick={presenter.close}>
              {ModalStrings.cancel()}
            </Button>
            {/* The run goes to the queue and this closes: a selection is one render per
                photograph, so a modal held over the page is minutes of the library being
                unusable. Where it got to is on the sidebar and on the Exports page. */}
            <Button onClick={() => void presenter.run()}>
              {count > 1 ? ExportStrings.titleMany(count) : ExportStrings.title()}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
});
