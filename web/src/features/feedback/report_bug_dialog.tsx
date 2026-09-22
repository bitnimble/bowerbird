import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState } from 'react';
import { useFeedbackStore, usePresenters, useUpdatesStore } from '../../app/stores_context';
import { Button } from '../../ui/button';
import { DialogActions, DialogBody } from '../../ui/dialog_layout';
import { ErrorBanner } from '../../ui/error_banner';
import { Field } from '../../ui/field';
import { focusRing } from '../../ui/focus_ring';
import { Modal } from '../../ui/modal';
import { ModalStrings } from '../../ui/modal.strings';
import { Row } from '../../ui/row';
import { Text } from '../../ui/text';
import { TextArea } from '../../ui/text_area';
import { TextField } from '../../ui/text_field';
import { rawFits } from './photo_attachments';
import { bugReporter } from './report_bug';
import { ReportBugStrings } from './report_bug_dialog.strings';
import { color } from '../../ui/tokens.stylex';

const styles = stylex.create({
  required: {
    color: color.rose,
    marginLeft: '3px',
  },
});

/**
 * The form, mounted at the root rather than beside whichever control opened it: the sidebar's
 * entry and the photo menu's are the same dialog, and only one of them knows a photograph.
 */
export const ReportBugDialog = observer(function ReportBugDialog(): JSX.Element | null {
  const store = useFeedbackStore();
  const updates = useUpdatesStore();
  const { feedback } = usePresenters();
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [includePhoto, setIncludePhoto] = useState(false);
  const [includeRaw, setIncludeRaw] = useState(false);
  const [strip, setStrip] = useState(true);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // Nothing here unmounts, so a send started before a close is still in flight after the next
  // open, and which open a result belongs to is the only thing that can tell them apart.
  const opening = useRef(0);

  const photo = store.photo;
  const fits = photo != null && rawFits(photo);

  useEffect(() => {
    if (!store.open) return;
    opening.current++;
    setIncludePhoto(false);
    setIncludeRaw(false);
    setStrip(true);
    setSending(false);
    setFailure(null);
  }, [store.open]);

  if (!bugReporter.canSend()) return null;

  async function send(): Promise<void> {
    const mine = opening.current;
    setSending(true);
    setFailure(null);
    const sent = await feedback.send({
      message: message.trim(),
      email: email.trim(),
      version: updates.status?.current,
      includePhoto,
      raw: includeRaw,
      strip,
    });
    // A close and a second open while that was in flight: this answer belongs to a form the
    // reader has already left.
    if (mine !== opening.current) return;
    setSending(false);
    if (sent === 'too-large') {
      setFailure(includeRaw ? ReportBugStrings.tooLargeWithRaw() : ReportBugStrings.tooLarge());
      return;
    }
    if (sent === 'failed') {
      setFailure(ReportBugStrings.couldNotSend());
      return;
    }
    // Only once it is sent: a report the reader has to write again is worse than a form that
    // is still holding what they wrote.
    setMessage('');
    setEmail('');
  }

  return (
    <Modal
      open={store.open}
      onOpenChange={(next) => (next ? undefined : feedback.close())}
      title={ReportBugStrings.reportABug()}
    >
      <DialogBody height="capped">
        <Field>
          <Text variant="label" as="span">
            {ReportBugStrings.yourEmail()}
          </Text>
          <TextField grow label={ReportBugStrings.yourEmail()} value={email} onChange={setEmail} />
        </Field>

        <Field>
          <Text variant="label" as="span">
            {ReportBugStrings.whatHappened()}
            <span {...stylex.props(styles.required)} aria-hidden="true">
              *
            </span>
          </Text>
          <TextArea
            required
            label={ReportBugStrings.whatHappened()}
            value={message}
            placeholder={ReportBugStrings.whatHappenedPlaceholder()}
            onChange={setMessage}
          />
        </Field>

        {photo != null && (
          <Field>
            <Text variant="label" as="span">
              {ReportBugStrings.thisPhoto()}
            </Text>
            <Row as="label">
              <input
                {...stylex.props(focusRing.ring)}
                type="checkbox"
                aria-label={ReportBugStrings.includePhoto()}
                checked={includePhoto}
                onChange={(e) => setIncludePhoto(e.currentTarget.checked)}
              />
              <Text as="span">{ReportBugStrings.includePhoto()}</Text>
            </Row>

            {includePhoto && (
              <>
                <Row as="label" title={fits ? undefined : ReportBugStrings.rawTooLarge()}>
                  <input
                    {...stylex.props(focusRing.ring)}
                    type="checkbox"
                    aria-label={ReportBugStrings.attachRaw()}
                    disabled={!fits}
                    checked={includeRaw && fits}
                    onChange={(e) => setIncludeRaw(e.currentTarget.checked)}
                  />
                  <Text as="span" variant={fits ? 'body' : 'muted'}>
                    {ReportBugStrings.attachRaw()}
                  </Text>
                </Row>
                <Row as="label">
                  <input
                    {...stylex.props(focusRing.ring)}
                    type="checkbox"
                    aria-label={ReportBugStrings.stripIdentifying()}
                    checked={strip}
                    onChange={(e) => setStrip(e.currentTarget.checked)}
                  />
                  <Text as="span">{ReportBugStrings.stripIdentifying()}</Text>
                </Row>
              </>
            )}
          </Field>
        )}

        <Text variant="muted" as="p">
          {ReportBugStrings.whatWeSend()}
        </Text>

        {failure != null && <ErrorBanner>{failure}</ErrorBanner>}

        <DialogActions>
          <Button onClick={feedback.close}>{ModalStrings.cancel()}</Button>
          <Button variant="primary" disabled={message.trim() === '' || sending} onClick={() => void send()}>
            {sending ? ReportBugStrings.sending() : ReportBugStrings.send()}
          </Button>
        </DialogActions>
      </DialogBody>
    </Modal>
  );
});
