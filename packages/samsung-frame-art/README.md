# samsung-frame-art

Upload, select and manage Samsung The Frame art over local `com.samsung.art-app`.
Bun only: WebSocket and `fetch` must accept the TV's self-signed certificate.

```ts
import { FrameArt } from 'samsung-frame-art';

const art = new FrameArt({ host: '192.168.1.40', token: saved, onToken: save });
const contentId = await art.upload(await Bun.file('photo.jpg').bytes(), { fileType: 'jpg', matte: 'none' });
await art.selectImage(contentId);
art.close();
```

First tokenless connection on port 8002 prompts TV pairing. Save `onToken`'s result;
pass it as `token` on later connections.

## Origin

A TypeScript port of the art API in [samsungtvws](https://github.com/NickWaterton/samsung-tv-ws-api)
(`samsungtvws/async_art.py` and the connection, helper, event and exception modules it uses), at
upstream commit `fe95ef1d784cd32f49bf9a07ec479576574eea07`.

Changes from upstream:

- Art API only: no remote-control keys, app launching or shortcuts.
- `upload` takes image bytes, not a path/URL; rejects without TV confirmation.
- `onToken` receives tokens; no token file writes.
- No cached art-mode state; `inArtMode()` asks the TV.

## Licence

LGPL-3.0-only, as upstream: see `COPYING.LESSER`, and `COPYING` for the GPL-3.0 it extends.
This licence covers this directory only.

- Copyright (C) 2019 DSR! <xchwarze@gmail.com>
- Copyright (C) 2021 Matthew Garrett <mjg59@srcf.ucam.org>
- Copyright (C) 2024, 2025 Nick Waterton <n.waterton@outlook.com>
- Copyright (C) 2026 bitnimble (the TypeScript port)
