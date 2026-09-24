import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { Fragment, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FolderPlus, Link2 } from 'lucide-react';
import { route } from '../../../../src/schemas/route';
import { useAppSettingsStore, useLibrariesStore, usePresenters } from '../../app/stores_context';
import { Button } from '../../ui/button';
import { Heading } from '../../ui/heading';
import { ICON } from '../../ui/icon';
import { List, ListBody, ListMeta, ListName, ListRow } from '../../ui/list';
import { Page } from '../../ui/page';
import { Panel } from '../../ui/panel';
import { Row, Spacer } from '../../ui/row';
import { Text } from '../../ui/text';
import { BackupPanel } from '../backup/backup_panel';
import { AddLibraryDialog } from '../libraries/add_library_dialog';
import { AddLibraryStrings } from '../libraries/add_library_dialog.strings';
import { libraryLabel } from '../libraries/library_label';
import { AddReplicaDialog } from '../replication/add_replica_dialog';
import { AddReplicaStrings } from '../replication/add_replica_dialog.strings';
import { ToggleSetting, useSettingWriter } from '../settings/settings_controls';
import { SettingsStrings } from '../settings/settings_page.strings';
import { OnboardingStrings } from './onboarding_page.strings';

const styles = stylex.create({
  scroll: {
    height: '100%',
    overflow: 'auto',
  },
  page: {
    maxWidth: '560px',
    marginInline: 'auto',
    paddingTop: '48px',
  },
  section: {
    display: 'grid',
    gap: '12px',
  },
  actions: {
    marginTop: '20px',
  },
});

type Step = 'library' | 'backup' | 'preferences';

export const OnboardingPage = observer(function OnboardingPage(): JSX.Element {
  const store = useLibrariesStore();
  const settings = useAppSettingsStore();
  const { libraries, backup } = usePresenters();
  const write = useSettingWriter();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('library');

  useEffect(() => {
    void libraries.load();
    void backup.load();
  }, [libraries, backup]);

  const none = store.libraries.length === 0;
  const steps: Step[] = none ? ['library', 'preferences'] : ['library', 'backup', 'preferences'];
  const index = steps.indexOf(step);
  const skipping = step === 'library' && none;

  async function finish(): Promise<void> {
    await write({ onboarding_complete: true });
    if (settings.onboardingComplete === true) navigate(route(), { replace: true });
  }

  return (
    <div {...stylex.props(styles.scroll)}>
      <Page style={styles.page}>
        <Text variant="label" as="p">
          {OnboardingStrings.stepOf(index + 1, steps.length)}
        </Text>

        {step === 'library' && <LibraryStep />}
        {step === 'backup' && <BackupStep />}
        {step === 'preferences' && <PreferencesStep />}

        <Row style={styles.actions}>
          {index > 0 && <Button onClick={() => setStep(steps[index - 1] ?? step)}>{AddReplicaStrings.back()}</Button>}
          <Spacer />
          {index === steps.length - 1 ?
            <Button variant="primary" onClick={() => void finish()}>
              {OnboardingStrings.finish()}
            </Button>
          : <Button variant={skipping ? 'default' : 'primary'} onClick={() => setStep(steps[index + 1] ?? step)}>
              {skipping ? OnboardingStrings.skip() : AddReplicaStrings.next()}
            </Button>
          }
        </Row>
      </Page>
    </div>
  );
});

const LibraryStep = observer(function LibraryStep(): JSX.Element {
  const store = useLibrariesStore();
  const [adding, setAdding] = useState(false);
  const [joining, setJoining] = useState(false);
  const none = store.libraries.length === 0;

  return (
    <div {...stylex.props(styles.section)}>
      <Heading>{OnboardingStrings.welcome()}</Heading>
      {none ?
        <Text variant="muted" as="p">
          {SettingsStrings.noLibrariesHint()}
        </Text>
      : <List label={SettingsStrings.libraries()}>
          {store.libraries.map((library) => (
            <ListRow key={library.id}>
              <ListBody>
                <ListName>{libraryLabel(library)}</ListName>
                <ListMeta>{library.root_path}</ListMeta>
              </ListBody>
            </ListRow>
          ))}
        </List>
      }
      <Row>
        <Button variant={none ? 'primary' : 'default'} onClick={() => setAdding(true)}>
          <FolderPlus size={ICON} />
          {AddLibraryStrings.title()}
        </Button>
        <Button onClick={() => setJoining(true)}>
          <Link2 size={ICON} />
          {AddReplicaStrings.title()}
        </Button>
      </Row>
      <AddLibraryDialog open={adding} onOpenChange={setAdding} />
      <AddReplicaDialog open={joining} onOpenChange={setJoining} />
    </div>
  );
});

const BackupStep = observer(function BackupStep(): JSX.Element {
  const store = useLibrariesStore();

  return (
    <div {...stylex.props(styles.section)}>
      {store.libraries.map((library) => (
        <Fragment key={library.id}>
          <Heading>{libraryLabel(library)}</Heading>
          <BackupPanel library={library} />
        </Fragment>
      ))}
    </div>
  );
});

function PreferencesStep(): JSX.Element {
  return (
    <div {...stylex.props(styles.section)}>
      <Heading>{OnboardingStrings.preferences()}</Heading>
      <Panel flush>
        <ToggleSetting field="watch_enabled" label={SettingsStrings.watchEnabled()} />
        <ToggleSetting
          field="frame_tv_enabled"
          label={SettingsStrings.frameTvEnabled()}
          hint={SettingsStrings.frameTvEnabledHint()}
        />
      </Panel>
    </div>
  );
}
