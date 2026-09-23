import { useRef } from 'react';
import { observer } from 'mobx-react-lite';
import { type ViewerRendition } from '../../../../../src/schemas/settings';
import { usePresenters, useViewerStore } from '../../../app/stores_context';
import { useHdrVideo } from './hdr_video';
import { PhotoDetailStrings } from './photo_detail_page.strings';
import { PhotoStage, type StagePicture } from './photo_stage';
import { decodedFrame } from './stage_bitmaps';
import { renditionLabel } from '../renditions';
import { nameOf, useStep } from './detail_navigation';
import { useNamedRendition } from '../named_rendition';
import { PhotoStageStrings } from './photo_stage.strings';

// How many photographs either side the stage holds ready, of the one open and the one
// before it both (`ViewerStore.runCovering`).
const NEIGHBOURS_HELD = 1;

// The picture on screen and the one held either side of it. Everything here is about which
// file to ask for, so it re-renders when that changes and not when a panel's data does.
export const DetailFrame = observer(function DetailFrame({
  photoId,
  toolsInto,
  zoomInto,
  fullscreenRef,
}: {
  photoId: string;
  toolsInto: HTMLElement | null;
  zoomInto: HTMLElement | null;
  fullscreenRef: (element: HTMLDivElement | null) => void;
}): JSX.Element {
  const store = useViewerStore();
  const { photos } = usePresenters();
  const step = useStep();
  const photo = store.detailFor(photoId);
  // Which rendition this photograph is drawn from and the file that is, from the one call
  // that pairs them - the same one every neighbour goes through below. Asked of the id in
  // the route rather than read off `store.showing`, which answers for whatever `open` names:
  // that lags the route by a render, so on the first render after a step it described the
  // photograph just left, and this one was mounted at a rendition chosen for that one.
  const { rendition: showing, source: stillSrc } = store.frameOf(photoId);
  // Every field comes from the same entry, so what is on screen, whether it is
  // HDR and where its bytes live can no longer disagree (§10.2).
  const shownFile = photo?.renditions?.[showing];

  // Firefox renders an HDR still dark - it applies a PQ transfer to nothing but
  // video - so there the same AVIF is rewrapped as one and shown through a
  // `<video>` (§10.7). The camera's JPEG never needs it, being 8-bit SDR with no
  // headroom to carry, so its still is already right.
  // A proof is drawn by the stage's shader, which a `<video>` never passes through.
  const proof = store.showsHdr(photoId) && store.proofOf(photoId) === 'srgb' ? store.proofTone : null;
  const hdrVideo = useHdrVideo(photoId, stillSrc, shownFile?.hdr === true && showing !== 'embedded' && proof == null);

  // Every rendition this photo has already decoded stays mounted, with the one
  // being asked for on the end. Comparing the camera's JPEG against a render is
  // what the picker is for, and going back to one the reader has already seen is
  // then an opacity change: no request for bytes the page is holding, and no
  // decode of them. One element per source, so what each decoded is what gets
  // painted - a single element re-pointed is a fetch and a decode every time.
  //
  // Only the ones whose frames are actually still decoded. `shownImages` is a record of what
  // has been shown and outlives leaving the viewer, so re-entering it would otherwise mount
  // every rendition the photo was ever read at - fetching and decoding the library default a
  // reader moved away from, which is exactly what opening at their own choice avoids. Held,
  // this is free; released, it is the whole file again.
  const decoded = store
    .renditionsShownOf(photoId)
    .filter((rendition) => decodedFrame(store.sourceOf(photoId, rendition)) != null);
  const held = decoded.includes(showing) ? decoded : [...decoded, showing];
  // Firefox's twin is a frame of its rendition like any other, not a replacement for the
  // list: the rendition it stands for is still one of `held`, so the camera's JPEG beside it
  // keeps its element and its raster, and the flip onto it is the opacity change every other
  // pair of renditions gets. Matched on the still it was rewrapped from rather than on
  // whichever rendition is being asked for - the twin is state and lags that by a render, so
  // keyed on the latter it stands in for the rendition the reader has just moved *to*.
  const sources = held.map((each) => {
    const still = store.sourceOf(photoId, each);
    return hdrVideo?.still === still ? hdrVideo.url : still;
  });

  // Stepping through frames is the whole job, so both neighbours are pictures of this
  // stage rather than frames warmed beside it: mounted, decoded, and held on their own
  // layer, so a step is the opacity change stack triage's flip already is - no element to
  // mount, nothing to ask the server for, and nothing to decode. Backwards through a cull
  // is as common as forwards, so both sides.
  //
  // The renditions on screen are what they are held at, so a reader set to the camera's
  // JPEG never pays for a render they will not see. Holding the still holds Firefox's
  // video too, that being the same file read out of the cache.
  //
  // **At every rendition this photo has been read at, not only the one on screen.** Those
  // URLs move with the rendition, so holding one set meant every swap unmounted a pair and
  // mounted the other - and it cost most in the case the neighbours exist for: comparing
  // two renditions and then stepping on, where the frame arrived at had been fetched
  // already and was fetched again.
  // The photograph stepped away from, kept so its own neighbours are held too: without it
  // the run slides, and a reader flipping between two frames remounts a third on every
  // press. Written during the render that first sees a new id, so it is one behind by
  // construction and needs no effect to keep it there.
  const cameFrom = useRef<string | null>(null);
  const standingOn = useRef(photoId);
  if (standingOn.current !== photoId) {
    cameFrom.current = standingOn.current;
    standingOn.current = photoId;
  }

  const run = store.runCovering([photoId, cameFrom.current], NEIGHBOURS_HELD);
  // The one open is every rendition of it the reader has looked at, so the picker is a
  // choice between frames already held; a neighbour is the single file it will itself be
  // shown from (`frameOf`), which is what makes stepping onto it a change of opacity. The
  // reader's choice does not travel with them - it is per photo (`beginDetail`) - so there
  // is no second rendition to hold one at.
  const strip: StagePicture[] = (run.includes(photoId) ? run : [photoId]).map((id) =>
    id === photoId ?
      {
        key: id,
        sources,
        frame: sources[held.indexOf(showing)],
        alt: (source) => {
          // A retiring frame (an older version's URL) is none of these, and naming it after the
          // rendition asked for would announce a picture it is not.
          const rendition = held[sources.indexOf(source)];
          return rendition == null ? nameOf(store, id) : PhotoDetailStrings.frameName(nameOf(store, id), renditionLabel(rendition));
        },
      }
    : {
        key: id,
        sources: [store.frameOf(id).source],
        alt: PhotoDetailStrings.frameName(nameOf(store, id), renditionLabel(store.frameOf(id).rendition)),
      },
  );

  // Which photo and which rendition each mounted frame is, for every picture on the stage
  // rather than only the open one: a 404 anywhere in the strip has to name what to build.
  // A neighbour's is a categorical promise (`shown_rendition`) and not a stat, so a photo
  // mid-import is held at a render that has not finished, and the 404 is what finishes it.
  const owning = new Map<string, { photoId: string; rendition: ViewerRendition }>(
    strip.flatMap((picture) =>
      picture.key === photoId ?
        held.map((each, i) => [sources[i]!, { photoId, rendition: each }] as const)
      : [[picture.sources[0]!, { photoId: picture.key, rendition: store.frameOf(picture.key).rendition }] as const],
    ),
  );

  const filename = nameOf(store, photoId);

  // Which rendition is up, said once and then gone: the picker is three keys and a menu
  // buried in the bar, so a reader who has just pressed one wants to be told what they got
  // without a label sitting over the photograph for the rest of the session. A build says
  // so for as long as it takes instead, which is the one wait the viewer has.
  const named = useNamedRendition(store.rendition);

  const status =
    store.buildingRendition ? { label: PhotoStageStrings.rendering(), busy: true }
    : named ? { label: renditionLabel(showing), busy: false }
    : null;

  return (
    /* Keyed off the route, not the loaded detail, so the photo on screen is
       always the one the URL asks for. */
    <PhotoStage
      photoKey={photoId}
      step={store.stepTo(photoId)}
      // Which edge the panels take is decided from this photo's shape and the
      // box the page has, so until both are known the stage is not the size it
      // will be.
      hold={store.photoFor(photoId) == null || store.detailWidth === 0}
      status={status}
      retryEpoch={store.retryEpoch}
      pictures={strip}
      showing={strip.findIndex((each) => each.key === photoId)}
      alt={filename}
      filename={filename}
      toolsInto={toolsInto}
      zoomInto={zoomInto}
      fullscreenRef={fullscreenRef}
      proof={proof}
      // No arrow keys on a phone, so the frame itself is the control: the same
      // step the bar's buttons take, taken by dragging the picture aside.
      onSwipe={step}
      // Which frame decoded, not which one is being asked for: several are
      // mounted, and switching away while one is still in flight would otherwise
      // file its size under the rendition that replaced it - and leave the one
      // that actually arrived unrecorded, so it would be dropped and fetched
      // again on the way back.
      // The open photograph's own frames only: `shownImages` describes what is on screen,
      // and it drops every entry for another photo - so recording a neighbour's decode
      // would throw away the renditions this one is holding, which is what makes going back
      // to one of them free.
      onImageLoad={(source, width, height) => {
        const arrived = owning.get(source);
        if (arrived?.photoId === photoId) photos.imageShown(photoId, arrived.rendition, width, height);
      }}
      // Only a copy this row builds: one served whole comes out of a file it already has, so a
      // 404 there means that file is gone, which building cannot fix (`store.servedWhole`). Any
      // picture in the strip may be the one that 404d - the open photo or either neighbour -
      // since `shown_rendition` is a promise every one of them was held against, not a stat.
      // The open photo's own frame is the one exception: at a rendition the reader explicitly
      // chose, it was built before it was shown, so a 404 there is a real fault rather than a
      // gap still being filled.
      onImageMissing={(source) => {
        const gone = owning.get(source);
        if (gone == null || store.servedWhole(gone.photoId, gone.rendition)) return;
        if (store.overrideFor(gone.photoId) != null) return;
        void photos.buildMissingRendition(gone.photoId, gone.rendition);
      }}
    />
  );
});
