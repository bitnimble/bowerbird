import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { PhotoStrip } from '../grid/photo_strip';
import type { Edge } from './viewer_edges';
import type { StripViewPresenter } from './strip_view_presenter';
import type { StripViewStore } from './strip_view_store';

export type StripView = { view: StripViewStore; presenter: StripViewPresenter };

/**
 * The collection the reader is in, along the edge of the viewer.
 *
 * The gallery's own grid at a column count of one (`PhotoStrip`), over the whole
 * collection rather than the run the arrows step through: seeking to a photograph
 * ten thousand frames away is the thing a strip is for, and the run is a window of
 * fifty.
 */
export const DetailFilmstrip = observer(function DetailFilmstrip({
  photoId,
  strip,
  edge,
}: {
  photoId: string;
  /** Built by the page, which needs its thickness to place it (`stripEdge`). */
  strip: StripView;
  /** Which side the page gave it. */
  edge: Edge;
}): JSX.Element {
  useEffect(() => {
    strip.presenter.watch();
    return () => strip.presenter.stop();
  }, [strip]);
  useEffect(() => strip.presenter.setAxis(edge === 'beside' ? 'y' : 'x'), [strip, edge]);

  // Once the strip can place the open photograph, which is not the render the
  // route changed on: its row may still be in flight. On the pitch as well as the
  // cell, because a cell is a different size after a resize, a zoom or a change of
  // edge, and the reader's place is a cell rather than a number of pixels.
  const cell = strip.view.cellOf(photoId);
  const pitch = strip.view.pitch;
  useEffect(() => {
    if (cell != null && pitch > 0) strip.presenter.reveal(photoId);
  }, [cell, pitch, photoId, strip]);

  return <PhotoStrip view={strip.view} presenter={strip.presenter} />;
});

