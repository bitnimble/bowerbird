import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FolderPlus, Link2 } from 'lucide-react';
import { route } from '../../../../src/schemas/route';
import { useLibrariesStore, useOnboardingStore, usePresenters } from '../../app/stores_context';
import { Button } from '../../ui/button';
import { Heading } from '../../ui/heading';
import { ICON } from '../../ui/icon';
import { List, ListBody, ListMeta, ListName, ListRow } from '../../ui/list';
import { Page } from '../../ui/page';
import { Panel } from '../../ui/panel';
import { Row, Spacer } from '../../ui/row';
import { ProgressBar } from '../../ui/progress_bar';
import { Text } from '../../ui/text';
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
  centred: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '12px',
    position: 'relative',
  },
  footnote: {
    position: 'absolute',
    insetInline: 0,
    bottom: '32px',
    textAlign: 'center',
  },
  progress: {
    width: '280px',
  },
});

type Step = 'library' | 'preferences';

const STEPS: Step[] = ['library', 'preferences'];

export const OnboardingPage = observer(function OnboardingPage(): JSX.Element {
  const store = useLibrariesStore();
  const { pipelinesReady } = useOnboardingStore();
  const { libraries, onboarding } = usePresenters();
  const write = useSettingWriter();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('library');

  useEffect(() => {
    void libraries.load();
  }, [libraries]);
  useEffect(onboarding.preparePipelines, [onboarding]);

  if (!pipelinesReady) return <PreparingPipelines />;

  const index = STEPS.indexOf(step);
  const previous = STEPS[index - 1];
  const next = STEPS[index + 1];
  const skipping = step === 'library' && store.libraries.length === 0;

  async function finish(): Promise<void> {
    if (await write({ onboarding_complete: true })) navigate(route(), { replace: true });
  }

  return (
    <div {...stylex.props(styles.scroll)}>
      <Page style={styles.page}>
        <Text variant="label" as="p">
          {OnboardingStrings.stepOf(index + 1, STEPS.length)}
        </Text>

        {step === 'library' && <LibraryStep />}
        {step === 'preferences' && <PreferencesStep />}

        <Row style={styles.actions}>
          {previous != null && (
            <Button onClick={() => setStep(previous)}>{AddReplicaStrings.back()}</Button>
          )}
          <Spacer />
          {next == null ? (
            <Button variant="primary" onClick={() => void finish()}>
              {OnboardingStrings.finish()}
            </Button>
          ) : (
            <Button variant={skipping ? 'default' : 'primary'} onClick={() => setStep(next)}>
              {skipping ? OnboardingStrings.skip() : AddReplicaStrings.next()}
            </Button>
          )}
        </Row>
      </Page>
    </div>
  );
});

const PreparingPipelines = observer(function PreparingPipelines(): JSX.Element {
  const { pipelinesCompiled, pipelinesToCompile } = useOnboardingStore();
  return (
    <div {...stylex.props(styles.centred)}>
      <Heading>{OnboardingStrings.preparing()}</Heading>
      <Text variant="muted" as="p" style={styles.footnote}>
        {OnboardingStrings.precompiling()}
      </Text>
      <ProgressBar
        label={OnboardingStrings.preparing()}
        value={pipelinesCompiled}
        // Zero until the worker has counted what it will compile, and `<progress>` needs a positive max.
        max={Math.max(pipelinesToCompile, 1)}
        style={styles.progress}
      />
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
      {none ? (
        <Text variant="muted" as="p">
          {SettingsStrings.noLibrariesHint()}
        </Text>
      ) : (
        <List label={SettingsStrings.libraries()}>
          {store.libraries.map((library) => (
            <ListRow key={library.id}>
              <ListBody>
                <ListName>{libraryLabel(library)}</ListName>
                <ListMeta>{library.root_path}</ListMeta>
              </ListBody>
            </ListRow>
          ))}
        </List>
      )}
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
