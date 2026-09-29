import * as stylex from '@stylexjs/stylex';
import { useEffect, useState } from 'react';
import { logsApi } from '../../api/logs';
import { CopyButton } from '../../ui/copy_button';
import { DialogActions, DialogBody } from '../../ui/dialog_layout';
import { Modal } from '../../ui/modal';
import { SegmentedControl } from '../../ui/segmented_control';
import { Text } from '../../ui/text';
import { focusRing } from '../../ui/focus_ring';
import { color, font, size } from '../../ui/tokens.stylex';
import { appLog } from './app_log';
import { LogsDialogStrings } from './logs_dialog.strings';

const styles = stylex.create({
  scroller: {
    display: 'flex',
    // column-reverse opens scrolled to the newest line
    flexDirection: 'column-reverse',
    flexGrow: 1,
    minHeight: 0,
    overflow: 'auto',
    backgroundColor: color.ink,
    borderRadius: size.radius,
    padding: '8px',
  },
  lines: {
    marginTop: 0,
    marginInline: 0,
    // holds a short log at the top rather than where column-reverse packs it
    marginBottom: 'auto',
    fontFamily: font.mono,
    fontSize: '11px',
    color: color.boneDim,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
});

interface Source {
  key: string;
  name: string;
  /** Null when they could not be read. */
  lines: readonly string[] | null;
  failure: string;
}

const SERVER = 'server';

export function LogsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const [server, setServer] = useState<Source | null>(null);
  const [peers, setPeers] = useState<Source[]>([]);
  const [app, setApp] = useState<Source | null>(null);
  const [chosen, setChosen] = useState(SERVER);

  useEffect(() => {
    if (!open) return;
    let current = true;
    const failure = LogsDialogStrings.couldNotLoad();
    void logsApi.server().then(
      ({ name, lines }) => current && setServer({ key: SERVER, name, lines, failure }),
      () =>
        current &&
        setServer({ key: SERVER, name: LogsDialogStrings.server(), lines: null, failure }),
    );
    void logsApi.peers().then(
      (logs) =>
        current &&
        setPeers(
          logs.peers.map(({ peer_id, name, lines }) => ({
            key: `peer:${peer_id}`,
            name,
            lines,
            failure: LogsDialogStrings.couldNotReach(name),
          })),
        ),
      () => {},
    );
    void appLog().then(
      (lines) =>
        current && setApp({ key: 'app', name: LogsDialogStrings.thisApp(), lines, failure }),
    );
    return () => {
      current = false;
      setServer(null);
      setPeers([]);
      setApp(null);
      setChosen(SERVER);
    };
  }, [open]);

  const sources = [server, ...peers, app].filter((source) => source != null);
  const shown = sources.find((source) => source.key === chosen);

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={LogsDialogStrings.logs()}>
      <DialogBody wide height="fixed">
        <SegmentedControl
          as="radio"
          label={LogsDialogStrings.logsFrom()}
          options={sources.map(({ key, name }) => ({ value: key, label: name }))}
          value={shown?.key ?? null}
          onChange={setChosen}
        />
        {shown != null && <Lines key={shown.key} source={shown} />}
      </DialogBody>
    </Modal>
  );
}

function Lines({ source }: { source: Source }): JSX.Element {
  if (source.lines == null) {
    return (
      <Text as="p" tone="error">
        {source.failure}
      </Text>
    );
  }
  if (source.lines.length === 0) {
    return (
      <Text as="p" variant="muted">
        {LogsDialogStrings.nothingLogged()}
      </Text>
    );
  }
  const text = source.lines.join('\n');
  return (
    <>
      <div
        {...stylex.props(styles.scroller, focusRing.ring)}
        role="log"
        aria-label={source.name}
        tabIndex={0}
      >
        <pre {...stylex.props(styles.lines)}>{text}</pre>
      </div>
      <DialogActions>
        <CopyButton text={text} />
      </DialogActions>
    </>
  );
}
