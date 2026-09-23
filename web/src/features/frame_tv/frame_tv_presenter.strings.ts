import { plural } from '../photos/photos_presenter.strings';

export const FrameTvPresenterStrings = {
  sending: (tv: string, count: number) => `Sending ${plural(count, 'photo', 'photos')} to ${tv}…`,
  sent: (tv: string, count: number) => `Sent ${plural(count, 'photo', 'photos')} to ${tv}.`,
  couldNotSend: (tv: string, count: number) => `We couldn't send ${plural(count, 'photo', 'photos')} to ${tv}. Try again.`,
  couldNotSendSelection: (tv: string) => `We couldn't send the selection to ${tv}. Try again.`,
};
