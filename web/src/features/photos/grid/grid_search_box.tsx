import { Search } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState } from 'react';
import { useListingStore, usePresenters } from '../../../app/stores_context';
import { ICON } from '../../../ui/icon';
import { TextField } from '../../../ui/text_field';
import { GridControlsStrings } from './grid_controls.strings';

export const GridSearchBox = observer(function GridSearchBox(): JSX.Element {
  const store = useListingStore();
  const { photos } = usePresenters();
  const storeSearch = store.filters.search ?? '';
  const [search, setSearch] = useState(storeSearch);
  // The last value this box wrote to the store. Anything else arriving in the
  // store came from elsewhere (a filter chip, opening another collection), and
  // the box has to follow it.
  const pushed = useRef(storeSearch);

  useEffect(() => {
    if (storeSearch === pushed.current) return;
    // An external change wins over whatever is typed here. Without this the
    // pending debounce below compared a stale local value against the freshly
    // emptied store and wrote the old search straight back.
    pushed.current = storeSearch;
    setSearch(storeSearch);
  }, [storeSearch]);

  // Debounced so typing a filename doesn't fire a request per keystroke.
  useEffect(() => {
    if (search === storeSearch) return;
    const timer = setTimeout(() => {
      pushed.current = search;
      // Read filters at fire time rather than closing over them, so a chip
      // clicked mid-debounce isn't reverted by a stale spread.
      void photos.setFilters({ ...store.filters, search });
    }, 250);
    return () => clearTimeout(timer);
  }, [search, storeSearch, photos, store]);

  return (
    <TextField
      label={GridControlsStrings.findByFilename()}
      placeholder={GridControlsStrings.filenamePlaceholder()}
      icon={<Search size={ICON} />}
      value={search}
      onChange={setSearch}
    />
  );
});
