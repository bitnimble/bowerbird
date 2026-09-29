// One of the AVIF decoder's threads (`avif_pool.ts`).

import { serveSlot, type PoolStart } from './avif_pool';
import { pageLog } from '../features/logs/page_log';

pageLog.follow('worker');

self.onmessage = (event: MessageEvent<PoolStart>) => {
  void serveSlot(event.data, () => self.postMessage('ready'));
};
