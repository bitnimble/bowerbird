# samsung-frame-art

Upload, select and manage art on a Samsung The Frame over the TV's local `com.samsung.art-app`
channel. Bun only: it relies on Bun's WebSocket and `fetch` accepting the TV's self-signed
certificate.

```ts
import { FrameArt } from 'samsung-frame-art';

const art = new FrameArt({ host: '192.168.1.40', token: saved, onToken: save });
const contentId = await art.upload(await Bun.file('photo.jpg').bytes(), { fileType: 'jpg', matte: 'none' });
await art.selectImage(contentId);
art.close();
```

The first connection on port 8002 without a token shows a pairing prompt on the TV. `onToken`
receives the token it issues; pass it back as `token` next time.

## Origin

A TypeScript port of the art API in [samsungtvws](https://github.com/NickWaterton/samsung-tv-ws-api)
(`samsungtvws/async_art.py` and the connection, helper, event and exception modules it uses), at
upstream commit `fe95ef1d784cd32f49bf9a07ec479576574eea07`.

Changes from upstream:

- Art API only: no remote-control keys, app launching or shortcuts.
- `upload` takes the image's bytes rather than a path or URL, and rejects when the TV does not
  confirm it rather than returning nothing.
- Tokens are handed to an `onToken` callback rather than written to a token file.
- No cached art-mode state; `inArtMode()` asks the TV.

## Licence

LGPL-3.0-only, as upstream: see `COPYING.LESSER`, and `COPYING` for the GPL-3.0 it extends.
This licence covers this directory only.

- Copyright (C) 2019 DSR! <xchwarze@gmail.com>
- Copyright (C) 2021 Matthew Garrett <mjg59@srcf.ucam.org>
- Copyright (C) 2024, 2025 Nick Waterton <n.waterton@outlook.com>
- Copyright (C) 2026 bitnimble (the TypeScript port)
