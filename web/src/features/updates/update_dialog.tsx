import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { Download, Sparkles } from 'lucide-react';
import { Button } from '../../ui/button';
import { ErrorBanner } from '../../ui/error_banner';
import { relativeTime } from '../../ui/format';
import { ICON } from '../../ui/icon';
import { Modal } from '../../ui/modal';
import { PageHead } from '../../ui/page';
import { Spacer } from '../../ui/row';
import { Text } from '../../ui/text';
import { color } from '../../ui/tokens.stylex';
import { usePresenters, useUpdatesStore } from '../../app/stores_context';
import { ReleaseNotes } from './release_notes';
import { UpdatesStrings } from './updates.strings';

const styles = stylex.create({
  // Its own scroll rather than the modal's, so the install button stays on screen however many releases were skipped.
  scroll: {
    width: 'min(620px, 82vw)',
    maxHeight: 'min(52vh, 480px)',
    overflowY: 'auto',
    marginTop: '12px',
  },
  release: {
    marginTop: { default: null, ':not(:first-child)': '18px' },
    paddingTop: { default: null, ':not(:first-child)': '14px' },
    borderTopWidth: { default: 0, ':not(:first-child)': '1px' },
    borderTopStyle: 'solid',
    borderTopColor: color.slate,
  },
  title: {
    fontSize: '15px',
    fontWeight: 600,
    color: color.bone,
  },
});

/** Every release between the one running and the newest one, newest first (§23.1). */
export const UpdateDialog = observer(function UpdateDialog(): JSX.Element | null {
  const store = useUpdatesStore();
  const { updates } = usePresenters();
  const newest = store.available;
  const current = store.current;
  if (newest == null || current == null) return null;

  return (
    <Modal open={store.dialogOpen} onOpenChange={updates.setDialogOpen} title={UpdatesStrings.whatsNew()}>
      <PageHead>
        <Text variant="mono">{UpdatesStrings.fromVersion(current, newest.version)}</Text>
        <Spacer />
        {store.canInstall ? (
          <Button variant="primary" disabled={store.installing} onClick={() => void updates.install()}>
            <Sparkles size={ICON} />
            {store.installing ? UpdatesStrings.installing() : UpdatesStrings.updateNow()}
          </Button>
        ) : (
          <DownloadInstead />
        )}
      </PageHead>

      {store.failure != null && (
        <ErrorBanner>
          <span>{store.failure}</span>
        </ErrorBanner>
      )}

      <div {...stylex.props(styles.scroll)}>
        {store.newer.map((release) => (
          <section key={release.tag} {...stylex.props(styles.release)}>
            {/* Not `Text variant="label"`: that is the uppercased, letter-spaced face the
                section headings wear, and a release is called what its author called it. */}
            <div {...stylex.props(styles.title)}>{release.name}</div>
            {release.published_at != null && (
              <Text variant="mono" as="div">
                {UpdatesStrings.releasedOn(relativeTime(release.published_at))}
              </Text>
            )}
            <ReleaseNotes markdown={release.notes} />
          </section>
        ))}
      </div>
    </Modal>
  );
});

/**
 * Where the install cannot replace itself: an Android build, a container, or a server
 * somebody started by hand with no supervisor in front of it.
 *
 * A container gets a sentence rather than a link, because there is no file to fetch -
 * what it needs is a `docker pull` and a recreate, which is the operator's to run.
 */
const DownloadInstead = observer(function DownloadInstead(): JSX.Element | null {
  const store = useUpdatesStore();
  const hint = store.installHint;
  if (hint == null) return null;
  if (!/^https?:\/\//i.test(hint)) {
    return <Text variant="mono">{UpdatesStrings.dockerPullHint(hint)}</Text>;
  }
  return (
    <Button render={<a href={hint} target="_blank" rel="noreferrer noopener" />}>
      <Download size={ICON} />
      {UpdatesStrings.download()}
    </Button>
  );
});
