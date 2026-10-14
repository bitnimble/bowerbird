// One of a threaded module's threads (`thread_pool.ts`).

import { serveSlot, type PoolStart } from './thread_pool';
import { pageLog } from '../features/logs/page_log';

pageLog.follow('worker');

self.onmessage = (event: MessageEvent<PoolStart>) => {
  void serveSlot(event.data, () => self.postMessage('ready'));
};
