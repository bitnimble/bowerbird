import { observer } from 'mobx-react-lite';
import { ArrowLeft } from 'lucide-react';
import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { PathSegment, route } from '../../../../src/schemas/route';
import { ShootNameSchema } from '../../../../src/schemas/shoots';
import { CollectionListStrings } from '../../app/collection_list.strings';
import { useLibrariesStore, usePresenters, useShootsStore } from '../../app/stores_context';
import { Button } from '../../ui/button';
import { EditableHeading } from '../../ui/editable_heading';
import { ICON } from '../../ui/icon';
import { Page, PageHead } from '../../ui/page';
import { Text } from '../../ui/text';
import { BulkBar } from '../photos/grid/bulk_bar';
import { BulkBarStrings } from '../photos/grid/bulk_bar.strings';
import { GridControls } from '../photos/grid/grid_controls';
import { PhotoGrid } from '../photos/grid/photo_grid';
import { PhotoGridStrings } from '../photos/grid/photo_grid.strings';
import { ShootPhotosStrings } from './shoot_photos_page.strings';
import { ShootsPageStrings } from './shoots_page.strings';

export const ShootPhotosPage = observer(function ShootPhotosPage(): JSX.Element {
  const { shootId = '' } = useParams();
  const shootsStore = useShootsStore();
  const librariesStore = useLibrariesStore();
  const { photos, shoots } = usePresenters();
  const shoot = shootsStore.byId.get(shootId);
  const library = shoot == null ? undefined : librariesStore.byId.get(shoot.library_id);
  // The folder read from the library root down. Empty parts dropped, so a library
  // that has not landed yet leaves the path alone and a shoot on the root itself is
  // the library's name rather than a name with a trailing separator.
  const folder = [library?.name, shoot?.folder_path].filter((part) => part != null && part !== '').join('/');

  useEffect(() => {
    void photos.open({ kind: 'shoot', shootId });
    void shoots.openShoot(shootId);
  }, [shootId, photos, shoots]);

  return (
    <Page fill>
      <PageHead withSidebarButton>
        {shoot != null && (
          // A link rather than history: a deep link arrives here with nothing to go
          // back to, and a shoot names the library whose list it belongs to.
          <Button render={<Link to={route(PathSegment.libraries(), shoot.library_id, PathSegment.shoots())} />}>
            <ArrowLeft size={ICON} />
            {ShootsPageStrings.shoots()}
          </Button>
        )}
        <EditableHeading
          value={shoot?.name ?? ShootPhotosStrings.shoot()}
          label={CollectionListStrings.renameField(shoot?.name ?? '')}
          editable={shoot != null && library != null && !library.read_only}
          refusal={library?.read_only === true ? BulkBarStrings.notOnReadOnlyLibrary() : undefined}
          validate={(name) => (ShootNameSchema.safeParse(name).success ? null : ShootPhotosStrings.folderNameOnly())}
          onRename={(name) => {
            if (shoot != null) void shoots.rename(shoot.id, name);
          }}
        />
        <Text variant="mono">{folder === '' ? shootId : folder}</Text>
      </PageHead>

      <GridControls />
      <BulkBar collection={shoot == null ? undefined : { kind: 'shoot', id: shoot.id, name: shoot.name }} />
      <PhotoGrid emptyHint={PhotoGridStrings.addFromLibraryHint()} />
    </Page>
  );
});
