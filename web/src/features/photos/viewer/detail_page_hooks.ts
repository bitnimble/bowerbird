import { useEffect, useState } from 'react';
import {
  useListingStore,
  usePresenters,
  useStacksStore,
  useViewerStore,
} from '../../../app/stores_context';
import type { StripView } from './detail_filmstrip';
import { StripViewPresenter } from './strip_view_presenter';
import { StripViewStore } from './strip_view_store';

export function useDetailBox(box: HTMLDivElement | null): void {
  const { photos } = usePresenters();
  useEffect(() => {
    if (box == null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry == null) return;
      photos.setDetailBox(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [box, photos]);
}

export function useStripView(): StripView {
  const listing = useListingStore();
  const stacks = useStacksStore();
  const viewer = useViewerStore();
  const { photos } = usePresenters();
  const [strip] = useState<StripView>(() => {
    const view = new StripViewStore(listing, stacks, viewer);
    return { view, presenter: new StripViewPresenter(view, photos) };
  });
  return strip;
}
