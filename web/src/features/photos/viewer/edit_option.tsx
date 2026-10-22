import * as stylex from '@stylexjs/stylex';
import { HardDriveDownload, RefreshCw, SlidersHorizontal } from 'lucide-react';
import { Link } from 'react-router-dom';
import { ICON } from '../../../ui/icon';
import { menuStyles } from '../../../ui/menu_styles';
import type { Option } from '../../../ui/option';
import type { ReplicationPresenter } from '../../replication/replication_presenter';
import { fetchOriginalRefusal } from './detail_labels';
import { PhotoDetailStrings } from './photo_detail_page.strings';

/**
 * Edit, as a link, where the editor can open the photo; otherwise Fetch original and edit, which
 * `fetchOriginalThenEdit` answers.
 */
export function editOption({
  editable,
  fetchingOriginal,
  readOnly,
  unreachable,
  editHref,
  replace,
}: {
  editable: boolean;
  fetchingOriginal: boolean;
  /** A library that cannot take the original, which a photo that is not editable has to fetch. */
  readOnly: boolean;
  unreachable: boolean;
  editHref: string;
  replace: boolean;
}): Option<'edit'> {
  if (editable) {
    return {
      value: 'edit',
      label: PhotoDetailStrings.edit(),
      icon: <SlidersHorizontal size={ICON} />,
      link: <Link to={editHref} replace={replace} />,
    };
  }
  const refusal = fetchOriginalRefusal(readOnly, unreachable);
  return {
    value: 'edit',
    label: fetchingOriginal
      ? PhotoDetailStrings.fetchingOriginal()
      : PhotoDetailStrings.fetchOriginalAndEdit(),
    icon: fetchingOriginal ? (
      <RefreshCw size={ICON} {...stylex.props(menuStyles.spin)} />
    ) : (
      <HardDriveDownload size={ICON} />
    ),
    disabled: fetchingOriginal || refusal != null,
    keepsMenuOpen: true,
    ...(refusal == null ? {} : { tooltip: refusal }),
  };
}

/** Opens the editor once the original has landed, where `edit` still wants it to. */
export function fetchOriginalThenEdit(
  replication: ReplicationPresenter,
  photoId: string,
  edit: () => void,
): void {
  void replication.fetchOriginalAndWait(photoId).then((fetched) => {
    if (fetched) edit();
  });
}
