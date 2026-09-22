import * as stylex from '@stylexjs/stylex';
import { reaction } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { useListingStore, useMarksStore, useStacksStore } from '../../../app/stores_context';
import { focusRing } from '../../../ui/focus_ring';
import { GRID_GAP } from './grid_layout';
import { PhotoGridStrings } from './photo_grid.strings';
import { STRIP_MAX_THICKNESS, STRIP_MIN_THICKNESS, STRIP_SPINE, type StripViewStore } from '../viewer/strip_view_store';
import type { StripViewPresenter } from '../viewer/strip_view_presenter';
import { band, bandColourOf, cells, strip, viewport } from './photo_grid_styles';
import { BandMember, InStrip } from './photo_tile';
import { sectionStyle, tilesFor } from './photo_bands';
import { GridScrollbar } from './grid_scrollbar';

// The scrollers' ids, so each drawn scrollbar can name what it controls.
const STRIP_ID = 'filmstrip-scroller';

// The strip's own edge, dragged, on whichever side faces the photograph: how thick
// it is drawn is how big its cells are. A delta from where the drag started rather
// than the pointer's distance from the far edge, which would need the strip's box
// read back on every move.
export const StripResizer = observer(function StripResizer({
  view,
  presenter,
}: {
  view: StripViewStore;
  presenter: StripViewPresenter;
}): JSX.Element {
  const along = view.axis;
  const grabbed = useRef({ x: 0, y: 0, thickness: 0, along });
  const hold = (e: { clientX: number; clientY: number }): void => {
    grabbed.current = { x: e.clientX, y: e.clientY, thickness: view.thickness, along };
  };

  return (
    <div
      {...stylex.props(strip.handle, along === 'x' ? strip.handleX : strip.handleY)}
      role="separator"
      aria-orientation={along === 'x' ? 'horizontal' : 'vertical'}
      aria-label={PhotoGridStrings.resizeFilmstrip()}
      aria-valuenow={view.thickness}
      aria-valuemin={STRIP_MIN_THICKNESS}
      aria-valuemax={STRIP_MAX_THICKNESS}
      tabIndex={0}
      onPointerDown={(e) => {
        // Without this the drag selects the cells behind the edge instead of moving it.
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        hold(e);
      }}
      onPointerMove={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        // How thick the strip is is what decides which edge it takes, so a drag can swap its
        // own axis under itself (`stripEdge`). Taken from here on the new one, rather than
        // subtracting a distance down the screen from one across it.
        if (grabbed.current.along !== along) hold(e);
        const from = along === 'x' ? grabbed.current.y : grabbed.current.x;
        // The strip is past the photograph either way, so it grows towards the pointer's origin.
        const moved = from - (along === 'x' ? e.clientY : e.clientX);
        presenter.setThickness(grabbed.current.thickness + moved);
      }}
      onKeyDown={(e) => {
        const grow = along === 'x' ? e.key === 'ArrowUp' : e.key === 'ArrowLeft';
        const shrink = along === 'x' ? e.key === 'ArrowDown' : e.key === 'ArrowRight';
        if (!grow && !shrink) return;
        e.preventDefault();
        presenter.nudgeThickness(grow ? 1 : -1);
      }}
    />
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
          along === 'x' ? strip.gutterX : [strip.gutterY, strip.viewportY],
          strip.thickness(view.thickness),
        )}
      >
        <StripResizer view={view} presenter={presenter} />

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
      </div>
    </InStrip.Provider>
  );
});
