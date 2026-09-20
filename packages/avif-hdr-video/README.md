# avif-hdr-video

Show HDR AVIF stills in HDR on Firefox.

```sh
npm install avif-hdr-video
```

```js
import { install } from 'avif-hdr-video';

install();
```

That is the whole integration. On Firefox, every HDR AVIF on the page is swapped for a
`<video>` showing the same frame; on every other browser nothing happens at all.

## Why

Firefox composites HDR for video and only video ([bug 1889288][bug]). Hand it a PQ AVIF
and it decodes the file, ignores the transfer curve, and paints the code values as if
they were sRGB — a washed-out picture rather than a refusal, so nothing in the page can
observe that it went wrong. Chrome and Safari render the same file correctly.

An AVIF *is* an AV1 frame, and an MP4 is another box format to put one in. So the frame
can go down the video path instead, and Firefox composites it: same bytes, same decoder,
different container.

Nothing is decoded or re-encoded here. The OBUs come out of the AVIF's item data, go into
an `mdat`, and about 800 bytes of boxes are written around them — around a millisecond
for a 4K frame, in a few hundred lines of dependency-free TypeScript.

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

Images are fetched before anything is swapped, and left alone unless they turn out to be
an HDR AVIF, so a selector that over-matches costs a cache hit rather than a broken
picture. URLs without a `.avif` extension — a content-negotiated route, say — need the
`data-hdr` attribute or a selector of your own.

The `<video>` takes the `<img>`'s `id`, `class`, `style`, `width`, `height` and `alt`, so
CSS written for the image keeps applying. Two things to know: rules that select `img` by
element name will not match, and a framework that owns the DOM node may object to it
being replaced. In that case use `hdrVideoUrl` and render the `<video>` yourself.

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

Whether this browser needs any of the above. A user-agent sniff, which is normally the
wrong tool and is the only one available: the failure is that Gecko renders a PQ still
*wrongly* rather than refusing it, so there is nothing for a feature test to catch.

## Limits

- **Firefox needs 4:2:0.** A 4:4:4 AVIF is AV1 Profile 1, which Firefox decodes and then
  composites SDR anyway — the remux is correct, the browser still will not show it in
  HDR. Encode HDR stills 4:2:0 if Firefox matters to you.
- **Grid images are refused.** Several coded tiles cannot be one video sample. Encoders
  produce these past a size threshold (libavif's default is 8192px), so a very large
  still may need re-encoding with tiling off.
- **Autoplay.** The video is muted, which is enough for every autoplay policy in Firefox
  today, but a `prefers-reduced-motion` user agent stylesheet or an extension can still
  stop a single unchanging frame from painting. There is no still-image fallback that
  would be any better; the `<img>` was the broken one.

## License

MIT
