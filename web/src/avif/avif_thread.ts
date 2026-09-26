// One of the AVIF decoder's threads (`avif_pool.ts`).

import { serveSlot, type PoolStart } from './avif_pool';

self.onmessage = (event: MessageEvent<PoolStart>) => {
  void serveSlot(event.data, () => self.postMessage('ready'));
};
