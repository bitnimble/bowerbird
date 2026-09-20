import * as stylex from '@stylexjs/stylex';
import { reaction } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { useListingStore, useMarksStore, useStacksStore } from '../../../app/stores_context';
import { focusRing } from '../../../ui/focus_ring';
import { Slider } from '../../../ui/slider';
import { stripMarker } from './grid.stylex';
import { GRID_GAP } from './grid_layout';
import { PhotoGridStrings } from './photo_grid.strings';
import {
  STRIP_MAX_THICKNESS,
  STRIP_MIN_THICKNESS,
  STRIP_SPINE,
  type StripViewStore,
} from '../viewer/strip_view_store';
import type { StripViewPresenter } from '../viewer/strip_view_presenter';
import { band, bandColourOf, cells, strip, viewport } from './photo_grid_styles';
import { BandMember, InStrip } from './photo_tile';
import { sectionStyle, tilesFor } from './photo_bands';
import { GridScrollbar } from './grid_scrollbar';

// The scrollers' ids, so each drawn scrollbar can name what it controls.
const STRIP_ID = 'filmstrip-scroller';

// How big the strip's own cells are, in the corner of the strip. Its own component
// so a drag re-renders the track and the cells it sizes, and not the viewer around
// them.
const StripZoom = observer(function StripZoom({
  view,
  presenter,
}: {
  view: StripViewStore;
  presenter: StripViewPresenter;
}): JSX.Element {
  return (
    <div {...stylex.props(strip.zoom, view.axis === 'y' && strip.zoomY)}>
      <Slider
        value={view.thickness}
        min={STRIP_MIN_THICKNESS}
        max={STRIP_MAX_THICKNESS}
        step={4}
        label={PhotoGridStrings.filmstripSize()}
        onChange={presenter.setThickness}
        shortGrab
        style={strip.slider}
      />
    </div>
  );
});

/**
 * The whole collection as one row, along whichever edge leaves the photograph
 * biggest: the viewer's filmstrip.
 *
 * The gallery's own machinery at a column count of one - the same rail, the same
 * band arithmetic, the same tiles, so a photograph is picked, selected and stacked
 * here exactly as it is in the grid, and none of that has a second implementation
 * to drift from (`StripViewStore`).
 */
export const PhotoStrip = observer(function PhotoStrip({
  view,
  presenter,
}: {
  view: StripViewStore;
  presenter: StripViewPresenter;
}): JSX.Element {
  const store = useListingStore();
  const marks = useMarksStore();
  const stacks = useStacksStore();
  const scroller = useRef<HTMLDivElement>(null);
  // What the scroller last reported, so a write can be told from a sample. Exactly
  // as the gallery's does, and for the reasons written there.
  const sampled = useRef(0);
  const along = view.axis;
  // The element's own offset along whichever way the strip runs. Read and written
  // through these so the rail below is the same code on either axis.
  const offsetOf = (element: HTMLElement): number => (along === 'x' ? element.scrollLeft : element.scrollTop);
  const putOffset = (element: HTMLElement, at: number): void => {
    if (along === 'x') element.scrollLeft = at;
    else element.scrollTop = at;
  };

  useEffect(() => {
    const element = scroller.current;
    if (element == null) return;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry?.contentRect;
      if (box != null) presenter.setViewport(box.width, box.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [presenter]);

  useEffect(
    () =>
      reaction(
        () => view.rail.top,
        (top) => {
          const element = scroller.current;
          if (element == null || top === sampled.current) return;
          putOffset(element, top);
          sampled.current = offsetOf(element);
        },
      ),
    // `along` because the two reads above close over it, and the strip changes
    // edge under the reader whenever the photograph's shape asks it to.
    [view, along],
  );

  // The element scrolls on the other axis now, so what was last sampled on the old
  // one says nothing about where it is - and the layout effect below would take it
  // as already there and leave the strip parked at nothing.
  useEffect(() => {
    sampled.current = -1;
  }, [along]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element == null) return;
    if (view.rail.top === sampled.current && view.rail.top <= view.rail.reach) return;
    putOffset(element, view.rail.top);
    sampled.current = offsetOf(element);
    if (offsetOf(element) !== view.rail.top) presenter.rail.setTop(offsetOf(element));
  });

  return (
    <InStrip.Provider value={along}>
      <div
        // The gutter the bar sits in is only there when there is a bar: a
        // collection the strip shows whole has nothing to seek, and a reserved
        // 12px beside the cells reads as a gap where a photograph is missing.
        {...stylex.props(
          strip.viewport,
          view.rail.fraction < 1 && strip.seekable,
          along === 'y' && strip.viewportY,
          strip.thickness(view.thickness),
          stripMarker,
        )}
      >
        {/* At the edge of the strip that faces away from the photograph, and in
            that order in the DOM as well as on screen: a control drawn under the
            cells but reached before them is a tab stop in the wrong place. */}
        {along === 'x' && <StripZoom view={view} presenter={presenter} />}

        <div {...stylex.props(strip.track, along === 'x' ? strip.trackX : strip.trackY)}>
          {/* The one way to reach a photograph ten thousand frames away in a
              gesture: the native bar describes the rail, which is a few hundred
              cells of a collection that may be a hundred thousand. */}
          <GridScrollbar
            rail={view.rail}
            axis={along}
            total={store.total}
            controls={STRIP_ID}
            viewport={view.viewportLength}
            wheelStep={view.pitch}
            onDragged={presenter.rail.scrollToProgress}
            onWheeled={(delta) => scroller.current?.scrollBy(along === 'x' ? { left: delta } : { top: delta })}
          />
          <div
            {...stylex.props(strip.scroller, along === 'x' ? strip.scrollerX : strip.scrollerY, focusRing.ring)}
            id={STRIP_ID}
            ref={scroller}
            // The phone drawer's swipe leaves a drag along a sideways strip to the strip (`drawer_swipe.ts`).
            data-owns-sideways={along === 'x' || undefined}
            role="list"
            aria-label={PhotoGridStrings.gridLabel(store.total)}
            // Focusable and labelled for the reason the gallery's scroller is: it
            // holds a hundred thousand cells and mounts a few dozen, so tabbing the
            // tiles reaches only what is already on screen and Home, End and the
            // page keys have nothing to act on.
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.metaKey || e.ctrlKey || e.altKey) return;
              // Home and End go to the ends of the *rail*, which is somewhere in the
              // middle of the collection; the page keys are relative and need nothing.
              if (e.key !== 'Home' && e.key !== 'End') return;
              presenter.rail.scrollToProgress(e.key === 'Home' ? 0 : 1);
              e.preventDefault();
            }}
            onScroll={(e) => {
              const at = offsetOf(e.currentTarget);
              sampled.current = at;
              presenter.rail.setTop(at);
            }}
            // A wheel over a strip scrolls the strip, whichever way it runs and
            // whichever way the wheel does. A vertical notch over a row that only
            // scrolls sideways is left to the browser by Firefox, which is a wheel
            // that does nothing over the one thing under the pointer that moves.
            onWheel={(e) => {
              const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
              const step = e.deltaMode === 1 ? view.pitch : e.deltaMode === 2 ? view.viewportLength : 1;
              e.currentTarget.scrollBy(along === 'x' ? { left: delta * step } : { top: delta * step });
            }}
          >
            <div
              {...stylex.props(
                viewport.content,
                viewport.stripContent,
                along === 'x' ? viewport.railWidth(view.rail.length) : [viewport.stripContentY, viewport.railHeight(view.rail.length)],
              )}
              role="presentation"
            >
              {view.sections.map((section) => (
                <div
                  key={section.key}
                  {...stylex.props(
                    sectionStyle(along, 1),
                    cells.window,
                    along === 'x' ? cells.windowX : cells.windowY,
                    cells.along(along, view.rail.positionOf(section.top)),
                    cells.stripCells(view.pitch - GRID_GAP, STRIP_SPINE),
                    section.kind === 'band' && [band.band, bandColourOf(store.bandColours.get(section.stackId))],
                  )}
                  // A band is a group with a name, as it is in the gallery: its
                  // members are not cells of the collection, and flattened into the
                  // list they are announced with positions its own rows contradict.
                  role={section.kind === 'band' ? 'group' : 'presentation'}
                  aria-label={
                    section.kind !== 'band'
                      ? undefined
                      : section.composite != null
                        ? PhotoGridStrings.frameBandLabel(section.photos.length, section.composite)
                        : PhotoGridStrings.bandLabel(section.photos.length)
                  }
                >
                  {section.kind === 'grid'
                    ? tilesFor(store, marks, stacks, section.from, section.to, along)
                    : section.photos.map((photo) => <BandMember key={photo.id} photo={photo} />)}
                </div>
              ))}
            </div>
          </div>
        </div>

        {along === 'y' && <StripZoom view={view} presenter={presenter} />}
      </div>
    </InStrip.Provider>
  );
});
