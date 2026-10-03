import { observer } from 'mobx-react-lite';
import type { ReactNode } from 'react';
import type { Fit, Margin } from '../../../../src/schemas/print_layout';
import {
  keywordName,
  PRINT_COPIES_MAX,
  pwgMediaName,
  type ColourPath,
} from '../../../../src/schemas/printing';
import {
  RenderingIntentSchema,
  type RenderingIntent,
} from '../../../../src/schemas/rendering_intent';
import { usePresenters, usePrintDialogStore } from '../../app/stores_context';
import { Button } from '../../ui/button';
import { DialogActions, DialogBody, DialogColumns } from '../../ui/dialog_layout';
import { ErrorBanner } from '../../ui/error_banner';
import { Field } from '../../ui/field';
import { Modal } from '../../ui/modal';
import { ModalStrings } from '../../ui/modal.strings';
import type { Option } from '../../ui/option';
import { Row } from '../../ui/row';
import { Select } from '../../ui/select';
import { Spinner } from '../../ui/spinner';
import { Text } from '../../ui/text';
import { TextField } from '../../ui/text_field';
import { IntentChoiceStrings } from '../raw_edit/proof/intent_choice.strings';
import { PrintDialogStrings as strings } from './print_dialog.strings';

const FITS: Option<Fit>[] = [
  { value: 'fit', label: strings.fitToPaper() },
  { value: 'fill', label: strings.fillPaper() },
];

const INTENTS: Option<RenderingIntent>[] = RenderingIntentSchema.options.map((intent) => ({
  value: intent,
  label: IntentChoiceStrings[intent](),
}));

const COLOUR_NOTE: Record<ColourPath['kind'], () => string> = {
  profile: strings.matchedToPaper,
  'adobe-rgb': strings.printerConverts,
  srgb: strings.srgbLimits,
};

function marginLabel(margin: Margin): string {
  if (margin === 'borderless') return strings.borderless();
  if (margin === 'minimum') return strings.smallest();
  return strings.millimetres(margin);
}

function marginOf(value: string): Margin {
  return value === 'borderless' || value === 'minimum' ? value : Number(value);
}

const profileKey = (profile: { from: string; name: string }): string =>
  `${profile.from}:${profile.name}`;

function Labelled({
  label,
  busy = false,
  children,
}: {
  label: string;
  busy?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <Field>
      <Text variant="label" as="span">
        {label}
      </Text>
      {busy ? (
        <Row>
          <Spinner small />
          <Text variant="muted" as="span">
            {strings.loading()}
          </Text>
        </Row>
      ) : (
        children
      )}
    </Field>
  );
}

export const PrintDialog = observer(function PrintDialog(): JSX.Element | null {
  const store = usePrintDialogStore();
  const { printing: presenter } = usePresenters();
  if (!store.open) return null;

  const { printers, capabilities, settings, described } = store;
  const describing = capabilities.kind === 'loading' && store.printerId != null;
  const media = described?.media ?? [];
  const profiles = store.profiles;

  return (
    <Modal
      open={store.open}
      onOpenChange={(open) => (open ? undefined : presenter.close())}
      title={strings.print()}
    >
      <DialogBody height="capped">
        <Labelled label={strings.printer()} busy={printers.kind === 'loading'}>
          {printers.kind === 'failed' ? (
            <ErrorBanner>{strings.printersFailed()}</ErrorBanner>
          ) : printers.kind === 'ready' && printers.value.length === 0 ? (
            <Text as="p">{strings.noPrinters()}</Text>
          ) : (
            <Row>
              <Select
                label={strings.printer()}
                options={
                  printers.kind === 'ready'
                    ? printers.value.map((printer) => ({ value: printer.id, label: printer.name }))
                    : []
                }
                value={store.printerId ?? ''}
                onChange={presenter.choosePrinter}
              />
              {store.printer != null && (
                <Button variant="ghost" onClick={() => void presenter.openPrinterSettings()}>
                  {strings.printerSettings()}
                </Button>
              )}
            </Row>
          )}
        </Labelled>

        {capabilities.kind === 'failed' && (
          <ErrorBanner>{strings.capabilitiesFailed()}</ErrorBanner>
        )}

        {(describing || described != null) && (
          <DialogColumns ruled>
            <Labelled label={strings.paperSize()} busy={describing}>
              <Select
                label={strings.paperSize()}
                options={media.map((each) => ({
                  value: each.key,
                  label:
                    each.name ??
                    pwgMediaName(each.key) ??
                    strings.paperDimensions(each.widthMm, each.heightMm),
                }))}
                value={settings.media ?? ''}
                onChange={(value) => presenter.set('media', value)}
              />
            </Labelled>

            {(describing || (described?.mediaTypes.length ?? 0) > 0) && (
              <Labelled label={strings.paperType()} busy={describing}>
                <Select
                  label={strings.paperType()}
                  options={(described?.mediaTypes ?? []).map((each) => ({
                    value: each.key,
                    label: each.name ?? keywordName(each.key),
                  }))}
                  value={settings.mediaType ?? ''}
                  onChange={(value) => presenter.set('mediaType', value)}
                />
              </Labelled>
            )}

            <Labelled label={strings.margins()} busy={describing}>
              <Select
                label={strings.margins()}
                options={store.margins.map((margin) => ({
                  value: String(margin),
                  label: marginLabel(margin),
                }))}
                value={String(settings.margin)}
                onChange={(value) => presenter.set('margin', marginOf(value))}
              />
            </Labelled>

            <Labelled label={strings.fit()}>
              <Select
                label={strings.fit()}
                options={FITS}
                value={settings.fit}
                onChange={(value) => presenter.set('fit', value)}
              />
            </Labelled>

            <Labelled label={strings.copies()} busy={describing}>
              <TextField
                type="number"
                label={strings.copies()}
                min={1}
                max={Math.min(described?.copiesMax ?? PRINT_COPIES_MAX, PRINT_COPIES_MAX)}
                step={1}
                value={store.copiesTyped}
                onChange={presenter.typeCopies}
              />
            </Labelled>

            <Labelled label={IntentChoiceStrings.renderingIntent()}>
              <Select
                label={IntentChoiceStrings.renderingIntent()}
                options={INTENTS}
                value={settings.intent}
                onChange={(value) => presenter.set('intent', value)}
              />
            </Labelled>

            {profiles.length > 0 && (
              <Labelled label={strings.colourProfile()}>
                <Select
                  label={strings.colourProfile()}
                  options={profiles.map((profile) => ({
                    value: profileKey(profile),
                    label: profile.name,
                  }))}
                  value={settings.profile == null ? '' : profileKey(settings.profile)}
                  onChange={(value) =>
                    presenter.set(
                      'profile',
                      profiles.find((profile) => profileKey(profile) === value) ?? null,
                    )
                  }
                />
              </Labelled>
            )}

            <Labelled label={strings.colour()} busy={describing}>
              {store.colour != null && (
                <Text variant="muted" as="p">
                  {COLOUR_NOTE[store.colour.kind]()}
                </Text>
              )}
            </Labelled>
          </DialogColumns>
        )}

        {store.error != null && <ErrorBanner>{store.error}</ErrorBanner>}

        <DialogActions>
          <Button onClick={presenter.close}>{ModalStrings.cancel()}</Button>
          <Button
            variant="primary"
            disabled={store.request == null || store.submitting}
            onClick={() => void presenter.print()}
          >
            {store.submitting ? strings.sending() : strings.print()}
          </Button>
        </DialogActions>
      </DialogBody>
    </Modal>
  );
});
