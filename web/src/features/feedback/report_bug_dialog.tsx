import { useRef, useState } from 'react';
import { Bug } from 'lucide-react';
import { SidebarButton } from '../../app/sidebar_link';
import { usePresenters, useUpdatesStore } from '../../app/stores_context';
import { Button } from '../../ui/button';
import { DialogActions, DialogBody } from '../../ui/dialog_layout';
import { ErrorBanner } from '../../ui/error_banner';
import { Field } from '../../ui/field';
import { Modal } from '../../ui/modal';
import { ModalStrings } from '../../ui/modal.strings';
import { Text } from '../../ui/text';
import { TextArea } from '../../ui/text_area';
import { TextField } from '../../ui/text_field';
import { bugReporter } from './report_bug';
import { ReportBugStrings } from './report_bug_dialog.strings';

/** The sidebar's entry, and the form behind it: the only thing in the app that reaches Sentry. */
export function ReportBug(): JSX.Element | null {
  const updates = useUpdatesStore();
  const { toasts } = usePresenters();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  // Nothing here unmounts - the dialog is always mounted and only toggled open - so a send
  // started before a close is still in flight after the next open, and which open a result
  // belongs to is the only thing that can tell them apart.
  const opening = useRef(0);

  if (!bugReporter.canSend()) return null;

  function show(next: boolean): void {
    if (next) {
      opening.current++;
      setSending(false);
    }
    setFailed(false);
    setOpen(next);
  }

  async function send(): Promise<void> {
    const mine = opening.current;
    setSending(true);
    setFailed(false);
    try {
      await bugReporter.send({
        message: message.trim(),
        email: email.trim(),
        version: updates.status?.current,
      });
    } catch {
      if (mine === opening.current) setFailed(true);
      return;
    } finally {
      if (mine === opening.current) setSending(false);
    }
    if (mine !== opening.current) return;
    // Only once it is sent: a report the reader has to write again is worse than a form
    // that is still holding what they wrote.
    setMessage('');
    setEmail('');
    setOpen(false);
    toasts.show(ReportBugStrings.sent());
  }

  return (
    <>
      <SidebarButton icon={Bug} onClick={() => show(true)}>
        {ReportBugStrings.reportABug()}
      </SidebarButton>
      <Modal open={open} onOpenChange={show} title={ReportBugStrings.reportABug()}>
        <DialogBody>
          <Field>
            <Text variant="label" as="span">
              {ReportBugStrings.whatHappened()}
            </Text>
            <TextArea
              label={ReportBugStrings.whatHappened()}
              value={message}
              placeholder={ReportBugStrings.whatHappenedPlaceholder()}
              onChange={setMessage}
            />
          </Field>

          <Field>
            <Text variant="label" as="span">
              {ReportBugStrings.yourEmail()}
            </Text>
            <TextField grow label={ReportBugStrings.yourEmail()} value={email} onChange={setEmail} />
            <Text variant="mono" as="p">
              {ReportBugStrings.emailHint()}
            </Text>
          </Field>

          <Text variant="muted" as="p">
            {ReportBugStrings.whatWeSend()}
          </Text>

          {failed && <ErrorBanner>{ReportBugStrings.couldNotSend()}</ErrorBanner>}

          <DialogActions>
            <Button onClick={() => show(false)}>{ModalStrings.cancel()}</Button>
            <Button variant="primary" disabled={message.trim() === '' || sending} onClick={() => void send()}>
              {sending ? ReportBugStrings.sending() : ReportBugStrings.send()}
            </Button>
          </DialogActions>
        </DialogBody>
      </Modal>
    </>
  );
}
