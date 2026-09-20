import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { usePresenters, useViewerStore } from '../../../app/stores_context';
import { Rating } from '../marks';

// The sheet shows the stars under a label, the overflow menu as a section of its own.
export const DetailRating = observer(function DetailRating({
  photoId,
  focusable = true,
  style,
}: {
  photoId: string;
  focusable?: boolean;
  style?: stylex.StyleXStyles;
}): JSX.Element {
  const store = useViewerStore();
  const { photos } = usePresenters();

  return (
    <Rating
      rating={store.photoFor(photoId)?.rating ?? null}
      onSet={(rating) => void photos.setRating(photoId, rating)}
      focusable={focusable}
      style={style}
    />
  );
});
