import * as stylex from '@stylexjs/stylex';
import { Aperture, Camera, FileImage, Filter, Search } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { useImportStore, usePresenters } from '../../app/stores_context';
import { Button } from '../../ui/button';
import { ICON } from '../../ui/icon';
import { menuStyles } from '../../ui/menu_styles';
import { PopoverButton } from '../../ui/popover_button';
import { Section, Sections } from '../../ui/section';
import { TextField } from '../../ui/text_field';
import { DateRangeFilter } from '../photos/grid/grid_calendar';
import { GridControlsStrings } from '../photos/grid/grid_controls.strings';
import { styles } from '../photos/grid/grid_controls.stylex';
import { openedList, SideListFilter } from '../photos/grid/side_list_filter';
import { ImportPageStrings } from './import_page.strings';

type SideList = 'format' | 'camera' | 'lens';

function toggled<T>(list: readonly T[], value: T, on: boolean): T[] {
  return on ? [...list, value] : list.filter((item) => item !== value);
}

export const ImportFilterMenu = observer(function ImportFilterMenu(): JSX.Element {
  const store = useImportStore();
  const { imports } = usePresenters();
  const [openList, setOpenList] = useState<SideList | null>(null);
  const f = store.filters;
  const count = store.activeFilterCount;
  const onOpen =
    (row: SideList) =>
    (open: boolean): void =>
      setOpenList((current) => openedList(row, open, current));
  const hasModels = store.cameraModelOptions.length > 0 || store.lensModelOptions.length > 0;

  return (
    <PopoverButton
      active={count > 0}
      iconOnly
      label={
        count > 0 ? GridControlsStrings.filtersWithCount(count) : GridControlsStrings.filters()
      }
      trigger={<Filter size={ICON} />}
      badge={count > 0 ? count : undefined}
    >
      <div {...stylex.props(styles.filters)}>
        <TextField
          label={GridControlsStrings.findByFilename()}
          placeholder={GridControlsStrings.filenamePlaceholder()}
          icon={<Search size={ICON} />}
          value={f.search}
          onChange={(search) => imports.setFilters({ search })}
        />
        <Sections>
          <Section>
            <label {...stylex.props(menuStyles.item, styles.check)}>
              <input
                type="checkbox"
                checked={f.hideInLibrary}
                onChange={(event) => imports.setFilters({ hideInLibrary: event.target.checked })}
              />
              {ImportPageStrings.hideAlreadyInLibrary()}
            </label>
            {store.formatOptions.length > 1 && (
              <SideListFilter
                label={GridControlsStrings.filterFileFormat()}
                icon={<FileImage size={ICON} />}
                open={openList === 'format'}
                onOpen={onOpen('format')}
                options={store.formatOptions.map((format) => ({
                  value: format,
                  label: GridControlsStrings.fileFormat(format),
                }))}
                selected={f.formats}
                onToggle={(format, on) =>
                  imports.setFilters({ formats: toggled(f.formats, format, on) })
                }
              />
            )}
          </Section>
          {hasModels && (
            <Section label={GridControlsStrings.sectionCamera()}>
              {store.cameraModelOptions.length > 0 && (
                <SideListFilter
                  label={GridControlsStrings.filterCameraBody()}
                  icon={<Camera size={ICON} />}
                  open={openList === 'camera'}
                  onOpen={onOpen('camera')}
                  options={store.cameraModelOptions.map((model) => ({
                    value: model,
                    label: model,
                  }))}
                  selected={f.cameraModels}
                  onToggle={(model, on) =>
                    imports.setFilters({ cameraModels: toggled(f.cameraModels, model, on) })
                  }
                />
              )}
              {store.lensModelOptions.length > 0 && (
                <SideListFilter
                  label={GridControlsStrings.filterLens()}
                  icon={<Aperture size={ICON} />}
                  open={openList === 'lens'}
                  onOpen={onOpen('lens')}
                  options={store.lensModelOptions.map((model) => ({
                    value: model,
                    label: model,
                  }))}
                  selected={f.lensModels}
                  onToggle={(model, on) =>
                    imports.setFilters({ lensModels: toggled(f.lensModels, model, on) })
                  }
                />
              )}
            </Section>
          )}
          <Section label={GridControlsStrings.sectionShotDate()}>
            <DateRangeFilter
              from={f.takenFrom}
              to={f.takenTo}
              firstDay={store.days[0]}
              lastDay={store.days[store.days.length - 1]}
              density={store.dayDensity}
              onChange={(takenFrom, takenTo) => imports.setFilters({ takenFrom, takenTo })}
            />
          </Section>
        </Sections>
        <div {...stylex.props(styles.foot)}>
          <Button variant="ghost" disabled={count === 0} onClick={imports.resetFilters}>
            {GridControlsStrings.resetFilters()}
          </Button>
        </div>
      </div>
    </PopoverButton>
  );
});
