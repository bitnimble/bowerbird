import { observer } from 'mobx-react-lite';
import { useEffect, useRef } from 'react';
import type { RawEditStore } from './raw_edit_store';

/**
 * The graded frame in the detail stage's slot. Same img/video wiring as the editor
 * needs, without PhotoStage's zoom/pan (those are for judging stored renditions).
 */
export const RawEditStage = observer(function RawEditStage({ store }: { store: RawEditStore }): JSX.Element {
  const video = useRef<HTMLVideoElement>(null);
  const route = store.route;
  const track = store.track;

  // Attached from the store rather than at construction: Chromium's generator exists
  // immediately, Safari's is built worker-side and its track arrives by transfer.
  //
  // Cleared on the routes that have no track, and that is load-bearing rather than tidy:
  // `srcObject` wins over `src`, so a leftover one from a previous route leaves the
  // element playing the old stream while the new route's blob URLs go nowhere.
  useEffect(() => {
    const element = video.current;
    if (element == null) return;
    element.srcObject = route === 'track' && track != null ? new MediaStream([track]) : null;
  }, [track, route]);

  const ready = store.live && (store.moving ? store.track != null || store.fileUrl !== '' : store.fileUrl !== '');

  return (
    <div className="stage raw-edit-stage">
      <div className="stage__viewport">
        {/* Two of the three routes end at a `<video>`, and they feed it differently: the
            track is attached as a `srcObject` above, the rewrap swaps a blob URL per frame.
            Muted and autoplay because either way the gesture policy has to be satisfied
            before a video element will render, audio or no audio. */}
        {store.moving === false ? (
          <img
            className="stage__content is-ready raw-edit__stage"
            src={store.fileUrl || undefined}
            alt=""
          />
        ) : (
          <video
            ref={video}
            className="stage__content is-ready raw-edit__stage"
            src={route === 'rewrap' ? store.fileUrl || undefined : undefined}
            autoPlay
            muted
            playsInline
          />
        )}
      </div>
      {!ready && store.status !== 'failed' && (
        <div className="stage__busy">
          <div className="stage__spinner" />
        </div>
      )}
    </div>
  );
});
