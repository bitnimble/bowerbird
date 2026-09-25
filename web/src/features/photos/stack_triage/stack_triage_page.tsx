import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { PathSegment, route } from '../../../../../src/schemas/route';
import {
  useListingStore,
  usePresenters,
  useStackTriageStore,
  useViewerStore,
} from '../../../app/stores_context';
import { Button } from '../../../ui/button';
import { EmptyState } from '../../../ui/empty_state';
import { Page, PageHead } from '../../../ui/page';
import { Text } from '../../../ui/text';
import { photoPath, sourceOfPath } from '../photos_store';
import { pairKey } from './stack_triage';
import { StackTriageStrings } from './stack_triage_page.strings';
import { styles } from './stack_triage_page.stylex';
import { Header, nameOf } from './triage_controls';
import { Flip, Split, ViewSwitch } from './triage_stage';
import { TriageKeys } from './triage_keys';

// Stack triage (DESIGN §20): one stack, judged two photos at a time.

export const StackTriagePage = observer(function StackTriagePage(): JSX.Element {
  const { stackId = '' } = useParams();
  const store = useStackTriageStore();
  // What this stack lies between, and the sort the session is seeded in.
  const listing = useListingStore();
  const viewer = useViewerStore();
  const { photos: photosPresenter, stackTriage, toasts } = usePresenters();
  const navigate = useNavigate();
  const [peeking, setPeeking] = useState(false);
  const [decoded, setDecoded] = useState<ReadonlySet<string>>(new Set());

  const location = useLocation();
  const entryPhotoId = (location.state as { entryPhotoId?: string } | null)?.entryPhotoId ?? null;

  // The collection this session is nested under, opened as the viewer opens it. A
  // reload straight onto a triage URL has none loaded, and then nothing can say how
  // the stack is sorted, or what it lies between for the jump out (§20.6).
  const collection = useMemo(() => sourceOfPath(location.pathname), [location.pathname]);
  useEffect(() => {
    if (collection != null) void photosPresenter.open(collection);
  }, [photosPresenter, collection]);

  // Which waits on that, the sort being the collection's to state.
  const ordering = listing.ordering;
  useEffect(() => {
    if (ordering == null) return;
    void stackTriage.open(
      stackId,
      entryPhotoId,
      ordering,
      collection?.kind === 'shoot' ? collection.shootId : undefined,
      viewer.boundsOfStack(stackId),
    );
  }, [stackId, entryPhotoId, stackTriage, viewer, ordering, collection]);

  const onDecoded = useCallback((source: string) => {
    setDecoded((previous) => (previous.has(source) ? previous : new Set(previous).add(source)));
  }, []);

  // Per round, not for the life of the page. Kept, a round whose frames were ever
  // decoded reads as ready the instant it renders - before the stage has painted
  // anything for it - which is every undo, every jump through the queue, and every
  // switch between the two presentations. That is exactly the "cast a verdict
  // against a stage that is still building" case the gate exists to stop.
  const roundKey = store.round == null ? '' : `${store.mode}:${pairKey(store.round.a, store.round.b)}`;
  useEffect(() => setDecoded(new Set()), [roundKey]);

  // An explicit route rather than navigate(-1): nothing in the app uses history
  // depth, and it strands anyone who refreshed or opened the URL directly on a
  // history stack with nothing behind it. Which photograph it lands on is
  // `returnTarget`'s to answer, and depends on whether the session is over.
  const leave = useCallback(() => {
    void stackTriage.returnTarget().then((back) => {
      if (back != null) {
        // Under the collection this session was entered from, so the viewer it
        // returns to still knows which grid the reader is in.
        navigate(photoPath(back, sourceOfPath(location.pathname)));
        return;
      }
      // Nothing survived, so there is no photograph to go back to.
      const library = store.members.values().next().value?.library_id;
      navigate(library == null ? route() : route(PathSegment.libraries(), library));
    });
  }, [navigate, location.pathname, store, stackTriage]);

  // **A session this screen has actually judged**, which is not the same as one
  // the store says has ended. Nothing clears the store when the page unmounts, so
  // re-opening the stack a moment after finishing it mounts against that finished
  // session - and leaving on it would send the reader straight back out of a
  // tournament they had just asked for. Written during the render that sees a
  // round, so it is idempotent under a double-invoked mount.
  const judgedHere = useRef(false);
  if (store.stackId === stackId && store.status === 'running') judgedHere.current = true;

  // Nothing left to decide, so the session is over and the reader goes back to the
  // viewer on one of the survivors. `busy` because the closing `picked` writes are
  // in flight until it drops - leaving on the first of them would report failures
  // that had not happened yet.
  const over = judgedHere.current && store.stackId === stackId && store.status === 'ended' && !store.busy;
  useEffect(() => {
    if (!over) return;
    // The one moment a session's failed writes can still be reported: there is no
    // screen after this one to put them on, and `setTriage` is asked to stay quiet
    // per verdict precisely so they can be gathered here. Against this stack by
    // name, because the offer outlives the route - and it does not expire, since a
    // verdict that never reached the server is not a thing to hide on a clock.
    const failed = store.failed.size;
    if (failed > 0 && stackId !== '') {
      const report = (count: number): void => {
        toasts.showFailure(StackTriageStrings.notSaved(count), StackTriageStrings.retry(), async () => {
          await stackTriage.retryFailed(stackId);
          if (store.stackId === stackId && store.failed.size > 0) report(store.failed.size);
        });
      };
      report(failed);
    }
    leave();
  }, [over, stackId, store, stackTriage, toasts, leave]);

  const sides = store.sides;
  const shown = store.shown;

  if (store.status === 'loading') {
    return (
      <Page>
        <PageHead withSidebarButton>
          <Text variant="muted">{StackTriageStrings.loadingTheStack()}</Text>
        </PageHead>
      </Page>
    );
  }

  if (store.status === 'error' || store.status === 'too-few') {
    return (
      <Page>
        <PageHead withSidebarButton />
        <EmptyState
          title={store.status === 'error' ? StackTriageStrings.couldNotOpenTheStack() : StackTriageStrings.nothingToCompare()}
        >
          <Text as="p" variant="muted">
            {store.loadError ?? StackTriageStrings.tooFewPhotos()}
          </Text>
          <Button onClick={leave}>{StackTriageStrings.back()}</Button>
        </EmptyState>
      </Page>
    );
  }

  // Both frames of the round have to be up before a verdict can be cast, or a
  // photograph could be rejected against a stage that is still building it.
  const ready = shown != null && shown.every((photo) => decoded.has(store.srcOf(photo.id)));

  return (
    <Page fill style={styles.page}>
      <TriageKeys peeking={peeking} ready={ready} onPeek={setPeeking} onLeave={leave} />
      <Header onLeave={leave} ready={ready} />

      {sides == null || shown == null ? (
        <Text variant="muted">{StackTriageStrings.finishing()}</Text>
      ) : (
        <>
          {store.mode === 'flip' ? (
            <>
              <Flip sides={sides} peeking={peeking} onDecoded={onDecoded} />
              <ViewSwitch peeking={peeking} onPeek={setPeeking} />
            </>
          ) : (
            <Split onDecoded={onDecoded} />
          )}
          {/* Announced, because the screen replaces its entire content on a
              keystroke and would otherwise change in silence. The round's own
              photographs, not just the count: a draw keeps the pool the same size,
              so a count alone says nothing happened. */}
          <div {...stylex.props(styles.visuallyHidden)} aria-live="polite">
            {StackTriageStrings.round(store.history.length + 1, nameOf(shown[0]), nameOf(shown[1]), store.pool.length)}
          </div>
          {/* The pool, fetched ahead so the bytes are in cache when a round asks
              for them. Only fetched: a clipped element paints nothing, so nothing
              here is decoded, and drawing them at stage size would either be
              ignored or cost a full-resolution raster each.

              Only once this round is up, for the reason PhotoStage gates the mounting
              of its own neighbours: started earlier they compete for the connection
              with the two frames the verdict bar is waiting on. */}
          {ready && (
            <div {...stylex.props(styles.warm)} aria-hidden>
              {store.warm.map((id) => (
                <img key={id} src={store.srcOf(id)} alt="" {...stylex.props(styles.warmImage)} />
              ))}
            </div>
          )}
        </>
      )}
    </Page>
  );
});
