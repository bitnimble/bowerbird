import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { type EditConflict } from '../../../../src/schemas/photo_edits';
import { renditionsApi } from '../../api/renditions';
import { usePresenters, useReplicationStore } from '../../app/stores_context';
import { Button } from '../../ui/button';
import { EmptyState } from '../../ui/empty_state';
import { relativeTime } from '../../ui/format';
import { Heading } from '../../ui/heading';
import { List, ListBody, ListMeta, ListRow } from '../../ui/list';
import { Page, PageHead } from '../../ui/page';
import { Text } from '../../ui/text';
import { color } from '../../ui/tokens.stylex';
import { ConflictsPageStrings } from './conflicts_page.strings';

const styles = stylex.create({
  candidates: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '10px',
    marginTop: '8px',
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: '5px',
    alignItems: 'flex-start',
    padding: '8px',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: color.slate,
    borderRadius: '6px',
    backgroundColor: color.slateSoft,
    width: '180px',
  },
  thumb: {
    width: '100%',
    height: '110px',
    objectFit: 'cover',
    borderRadius: '3px',
    backgroundColor: color.slate,
  },
});

// Where two devices edited the same photograph while apart (§5.3). Both sides
// are kept and the newer one is what the picture currently shows; this is the
// only merge in Bowerbird that waits on a person.
export const ConflictsPage = observer(function ConflictsPage(): JSX.Element {
  const store = useReplicationStore();
  const { replication } = usePresenters();

  useEffect(() => {
    void replication.loadConflicts();
  }, [replication]);

  const photos = store.conflictedPhotos;

  return (
    <Page>
      <PageHead withSidebarButton>
        <Heading>{ConflictsPageStrings.heading()}</Heading>
      </PageHead>

      {photos.length === 0 ? (
        <EmptyState title={ConflictsPageStrings.nothingToDecide()}>
          <Text as="p" variant="muted">
            {ConflictsPageStrings.nothingToDecideHint()}
          </Text>
        </EmptyState>
      ) : (
        <List label={ConflictsPageStrings.heading()}>
          {photos.map(({ photoId, candidates }) => (
            <ListRow key={photoId}>
              <ListBody>
                <ListMeta>{candidates[0]?.file_path ?? photoId}</ListMeta>
                <div {...stylex.props(styles.candidates)}>
                  {candidates.map((candidate) => (
                    <Candidate
                      key={candidate.session_id}
                      candidate={candidate}
                      onKeep={() => void replication.keep(photoId, candidate.session_id)}
                    />
                  ))}
                </div>
              </ListBody>
            </ListRow>
          ))}
        </List>
      )}
    </Page>
  );
});

// The picture is the one currently stored, the same for every card: a thumbnail
// per candidate would mean rendering each candidate's document, which needs the
// original, which a replica holding no RAWs does not have (§7.9).
const Candidate = observer(function Candidate({
  candidate,
  onKeep,
}: {
  candidate: EditConflict;
  onKeep: () => void;
}): JSX.Element {
  return (
    <div {...stylex.props(styles.card)}>
      <img {...stylex.props(styles.thumb)} src={renditionsApi.url(candidate.photo_id, 'grid')} alt="" loading="lazy" />
      <Text variant="label" as="div">
        {candidate.device}
      </Text>
      <Text variant="muted" as="div">
        {ConflictsPageStrings.candidateMeta(relativeTime(candidate.edited_at), candidate.edits)}
      </Text>
      <Button variant="primary" onClick={onKeep}>
        {ConflictsPageStrings.keepThese()}
      </Button>
    </div>
  );
});
