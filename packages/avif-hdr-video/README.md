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

Firefox composites HDR only for video ([bug 1889288][bug]). It decodes PQ AVIF but renders
it wrongly: washed out on Windows, dark on macOS, where it fits 10,000 nits into SDR white.
Neither exposes a detectable failure. Chrome and Safari render correctly.

AVIF holds an AV1 frame; wrapping it in MP4 sends identical bytes through Firefox's HDR video path.

No decode or re-encode. OBUs move from AVIF item data into `mdat` with about 800 bytes of
boxes: around a millisecond for 4K, in dependency-free TypeScript.

[bug]: https://bugzilla.mozilla.org/show_bug.cgi?id=1889288

## API

### `install(options?): () => void`

Swaps matching images for videos, and watches for ones added later. Returns a function
that undoes both.

| option         | default                            |                                         |
| -------------- | ---------------------------------- | --------------------------------------- |
| `selector`     | `img[data-hdr], img[src$=".avif"]` | which images to consider                |
| `root`         | `document`                         | where to look, and what to watch        |
| `fetchOptions` | –                                  | passed to `fetch`, e.g. for credentials |

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

### `hdrMp4(avif: Uint8Array): Uint8Array | null`

Returns the MP4 twin of AVIF bytes you already have, or `null` where the file is not HDR.

### `avifToMp4(avif: Uint8Array): Uint8Array`

The remux on its own, for bytes you already have. Works on any AVIF, HDR or not. Throws
on a file it cannot carry as one video sample: a grid (tiled) image, an item stored
outside the file, or anything that is not AV1.

### `orientationOfAvif(avif: Uint8Array): 0 | 90 | 180 | 270`

Returns primary image's display rotation in clockwise degrees. Reads irot metadata;
returns 0 when absent.

### `contentLightOfAvif(avif: Uint8Array): { maxCll, maxFall } | null`

Returns the primary image's content light level (`clli`), or null when absent or zero.

### `vp9FrameToMp4(frame: Uint8Array, width: number, height: number): Uint8Array`

Wraps one VP9 profile 2 keyframe (10-bit 4:2:0, PQ, BT.2020, limited range) as a
one-sample MP4, for a frame you encoded yourself.

### `needsHdrVideo(): boolean`

Uses user-agent sniffing: Gecko's incorrect PQ rendering succeeds, so feature detection cannot catch it.

### `hdrVideoSdrMatch(): 'still' | 'mac-video'`

Returns how this platform shows a PQ video's SDR range: `mac-video` on macOS, where SDR white
sits at 100 nits and the SDR under it reads through a 2.2 power, and `still` elsewhere.

## Limits

- **Firefox needs 10-bit 4:2:0.** A 4:4:4 AVIF is AV1 Profile 1 and a 12-bit one Profile 2;
  Firefox decodes both and then shows them washed out, with no transfer applied. The remux
  is correct and the browser still will not show them in HDR. Encode HDR stills 10-bit
  4:2:0 if Firefox matters to you, or pass `hdrVideoUrl` a 10-bit 4:2:0 copy.
- **Grid images are refused.** Several coded tiles cannot be one video sample. Encoders
  produce these past a size threshold (libavif's default is 8192px), so a very large
  still may need re-encoding with tiling off.
- **Autoplay.** Muting satisfies Firefox's autoplay policies, but a `prefers-reduced-motion`
  user agent stylesheet or extension can prevent painting. Falling back to `<img>` restores the HDR bug.

## License

MIT
