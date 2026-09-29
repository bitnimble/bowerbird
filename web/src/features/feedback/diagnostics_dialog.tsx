import * as stylex from '@stylexjs/stylex';
import { Fragment, useEffect, useState } from 'react';
import { CopyButton } from '../../ui/copy_button';
import { DialogActions, DialogBody } from '../../ui/dialog_layout';
import { MetaList, MetaTerm, MetaValue } from '../../ui/meta_list';
import { Modal } from '../../ui/modal';
import { type Diagnostics, readDiagnostics } from './diagnostics';
import { DiagnosticsStrings } from './diagnostics_dialog.strings';

const styles = stylex.create({
  list: {
    gridTemplateColumns: '150px 1fr',
  },
});

export function DiagnosticsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const [read, setRead] = useState<Diagnostics | null>(null);

  useEffect(() => {
    if (!open) return;
    setRead(null);
    let current = true;
    void readDiagnostics().then((next) => current && setRead(next));
    return () => {
      current = false;
    };
  }, [open]);

  const rows = read == null ? [] : described(read);

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={DiagnosticsStrings.diagnostics()}>
      <DialogBody>
        <MetaList style={styles.list}>
          {rows.map(([term, value]) => (
            <Fragment key={term}>
              <MetaTerm>{term}</MetaTerm>
              <MetaValue>{value}</MetaValue>
            </Fragment>
          ))}
        </MetaList>
        <DialogActions>
          <CopyButton text={rows.map(([term, value]) => `${term}: ${value}`).join('\n')} />
        </DialogActions>
      </DialogBody>
    </Modal>
  );
}

function described(read: Diagnostics): [string, string][] {
  const answer = (yes: boolean): string =>
    yes ? DiagnosticsStrings.yes() : DiagnosticsStrings.no();
  return [
    [DiagnosticsStrings.display(), read.display],
    [DiagnosticsStrings.browser(), read.browser],
    [DiagnosticsStrings.origin(), read.origin],
    [DiagnosticsStrings.gpuAdapter(), read.adapter],
    [DiagnosticsStrings.hdrDisplay(), answer(read.hdrDisplay)],
    [DiagnosticsStrings.imageDecoder(), answer(read.imageDecoder)],
    [DiagnosticsStrings.crossOriginIsolated(), answer(read.crossOriginIsolated)],
    [DiagnosticsStrings.secureContext(), answer(read.secureContext)],
    [DiagnosticsStrings.sharedMemory(), answer(read.sharedMemory)],
  ];
}
