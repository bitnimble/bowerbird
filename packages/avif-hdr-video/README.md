# avif-hdr-video

Show HDR AVIF stills in HDR on Firefox.

```sh
npm install avif-hdr-video
```

```js
import { install } from 'avif-hdr-video';

install();
```

On Firefox, replaces each HDR AVIF with a `<video>` of the same frame. Other browsers unchanged.

## Why

Firefox composites HDR only for video ([bug 1889288][bug]). It decodes PQ AVIF but paints
codes as sRGB, ignoring the transfer curve. This washed-out result exposes no detectable
failure. Chrome and Safari render correctly.

AVIF holds an AV1 frame; wrapping it in MP4 sends identical bytes through Firefox's HDR video path.

No decode or re-encode. OBUs move from AVIF item data into `mdat` with about 800 bytes of
boxes: around a millisecond for 4K, in dependency-free TypeScript.

[bug]: https://bugzilla.mozilla.org/show_bug.cgi?id=1889288

## API

### `install(options?): () => void`

Swaps matching images for videos, and watches for ones added later. Returns a function
that undoes both.

| option | default | |
| --- | --- | --- |
| `selector` | `img[data-hdr], img[src$=".avif"]` | which images to consider |
| `root` | `document` | where to look, and what to watch |
| `fetchOptions` | – | passed to `fetch`, e.g. for credentials |

Fetches before swapping; leaves non-HDR-AVIF images intact. Over-matching costs a cache hit.
URLs without `.avif` need `data-hdr` or a custom selector.

The `<video>` inherits `<img>`'s `id`, `class`, `style`, `width`, `height` and `alt`.
Element selectors targeting `img` stop matching. For framework-owned DOM nodes, use
`hdrVideoUrl` and render `<video>` yourself.

### `hdrVideoUrl(src, fetchOptions?): Promise<string | null>`

Fetches one image and returns an object URL for its MP4 twin, or `null` where the file is
not HDR and the `<img>` should be left as it is. The caller owns the URL and should
`URL.revokeObjectURL` it once nothing is showing it.

```jsx
const [src, setSrc] = useState(null);
useEffect(() => {
  if (!needsHdrVideo()) return;
  let url;
  void hdrVideoUrl(photo).then((it) => setSrc((url = it)));
  return () => url && URL.revokeObjectURL(url);
}, [photo]);

return src == null ? <img src={photo} /> : <video src={src} autoPlay loop muted playsInline />;
```

### `avifToMp4(avif: Uint8Array): Uint8Array`

The remux on its own, for bytes you already have. Works on any AVIF, HDR or not. Throws
on a file it cannot carry as one video sample: a grid (tiled) image, an item stored
outside the file, or anything that is not AV1.

### `orientationOfAvif(avif: Uint8Array): 0 | 90 | 180 | 270`

Returns primary image's display rotation in clockwise degrees. Reads irot metadata;
returns 0 when absent.

### `needsHdrVideo(): boolean`

Uses user-agent sniffing: Gecko's incorrect PQ rendering succeeds, so feature detection cannot catch it.

## Limits

- **Firefox needs 4:2:0.** A 4:4:4 AVIF is AV1 Profile 1, which Firefox decodes and then
  composites SDR anyway — the remux is correct, the browser still will not show it in
  HDR. Encode HDR stills 4:2:0 if Firefox matters to you.
- **Grid images are refused.** Several coded tiles cannot be one video sample. Encoders
  produce these past a size threshold (libavif's default is 8192px), so a very large
  still may need re-encoding with tiling off.
- **Autoplay.** Muting satisfies Firefox's autoplay policies, but a `prefers-reduced-motion`
  user agent stylesheet or extension can prevent painting. Falling back to `<img>` restores the HDR bug.

## License

MIT
