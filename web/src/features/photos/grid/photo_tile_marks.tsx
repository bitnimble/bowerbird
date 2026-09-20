import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { type PhotoSummary } from '../../../../../src/schemas/photos';
import { useListingStore, useMarksStore, usePresenters } from '../../../app/stores_context';
import { Rating, Verdict } from '../marks';

const COARSE = '@media (pointer: coarse)';

const styles = stylex.create({
  // Not under a finger: a thumb big enough to hit one covers the photograph it decides about.
  marks: {
    display: { default: 'flex', [COARSE]: 'none' },
    alignItems: 'center',
    gap: '8px',
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
  },
  list: {
    pointerEvents: 'auto',
  },
});

// Rating and verdict are set straight from the tile: a cull is mostly these two
// decisions, and making them cost a round trip through the detail view is what
// turns a ten-minute pass into an hour.
export const PhotoTileMarks = observer(function PhotoTileMarks({ photo }: { photo: PhotoSummary }): JSX.Element {
  const listing = useListingStore();
  const marks = useMarksStore();
  const { photos } = usePresenters();
  return (
    <span {...stylex.props(styles.marks, listing.mode === 'list' && styles.list)}>
      {marks.showTriage && <Verdict triage={photo.triage} onSet={(triage) => void photos.setTriage(photo.id, triage)} />}
      {marks.showRating && (
        <Rating rating={photo.rating} onSet={(rating) => void photos.setRating(photo.id, rating)} small />
      )}
    </span>
  );
});
