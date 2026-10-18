# Tauri + CEF evaluation

Date: 2026-08-03  
Reviewed: 2026-08-03 (claims re-checked against live GitHub/API, Tauri docs, and this repo)

> **Status: §2 and §4.4 are current; §3 and §4.1–§4.2, §5 and §6 are historical.** Written
> for a wasm editor before `src-tauri` existed. The shell now registers `bowerbird://` and
> answers `invoke`; the editor decodes natively and grades each tick through page-side WGSL.
>
> §4.1's premise no longer applies; §4.2's wasm-bindgen-rayon threads are gone, and
> cross-origin isolation is kept for the WASI modules' threads (`src/schemas/isolation.ts`). §5's native Rust streaming into `<video>` was considered and **not**
> taken; `docs/raw-edit-gpu.md` §0 and §6.2 explain the current architecture. §6 tests that
> unbuilt editor.
>
> **Linux runs CEF.** `src-tauri/Cargo.toml` takes `tauri` from the `feat/cef` branch and
> depends on `tauri-runtime-cef` on `target_os = "linux"`, `tauri-runtime-wry` elsewhere; Linux
> cannot reach WebKitGTK. §2 describes the branch, §4.4 the shipped switch, not an option still
> under consideration.

Whether Bowerbird’s desktop shell should be **Tauri with a bundled Chromium
(CEF)** rather than Electron or stock Tauri (system webview). Product constraint:
UI is bundled into the app; the frontend talks only to the in-app Tauri Rust
backend; NAS traffic is proxied through that Rust layer.

## 1. Verdict

Tauri + CEF is what Linux ships. Nothing in the codebase was a hard blocker, and
§4.4 is now the build rather than a proposal.

The original checks were HDR Chromium parity and cross-origin isolation for
`SharedArrayBuffer`. The editor's own module holds none; Safari's AV1 decoder and
Firefox's VP9 encoder do, so isolation stays. §4.1 proposed Rust grading; the shipped editor grades in page-side
WGSL. **Chromium parity is why Linux takes CEF**: WebKitGTK builds with
`ENABLE_WEBGPU` off and cannot run the tick.
See `docs/raw-edit-gpu.md` §0 and §6.2.

Stock Tauri (WebView2 / WKWebView / WebKitGTK) is the wrong default: Linux
WebKitGTK is a known QA sink (maintainers have said as much on
[tauri#14963](https://github.com/tauri-apps/tauri/issues/14963)).

`e2e-tauri/api.desktop.ts` asserts the consequence - `navigator.gpu` and a real
adapter in the shell's own webview - so a Linux build that lost CEF fails there
rather than in an editor that quietly draws a different picture.

## 2. What Tauri CEF is today

Stable Tauri uses the OS webview via wry (WKWebView / WebView2 / WebKitGTK). That
is the documented default (`v2.tauri.app` architecture / start pages; `dev`
`Cargo.toml` defaults to `wry`). Bundled Chromium is the **CEF** path:

- Lives on branch [`feat/cef`](https://github.com/tauri-apps/tauri/tree/feat/cef);
  the shell pins `9d1a5b1` (**2026-10-07**).
- Opt-in on that branch: depend on `tauri-runtime-cef` rather than
  `tauri-runtime-wry` (§4.4), and pin deps / CLI to the branch. Not on stable
  crates.io as a turnkey default.
- FabianLars (2026-04-03 on #14963): “the branch is mostly usable but like I said
  above, **you're on your own when you want to try it**. We cannot yet offer much
  help (please do report issues though if you do try it).”
- Production apps already ship CEF-backed Tauri: **Kabegame** (own
  `tauri-runtime-cef`, cited on #14963) and **OpenHuman** (vendored `tauri-cef`
  fork of `feat/cef` on CEF 146.4.1 as of 2026-08-03; each app carries its own
  pin).
- Timeline: simonhyll (2024-06-03 on #14963) on CEF: “can't be done for v2 both from
  an amount of work point of view and a security audit point of view. Earliest it
  can possibly happen is in Tauri version 3.” Opt-in when it lands, not a firm
  promise, and not the `tauri create` default.
- Size: CEF upstream cites installer sizes **>100MB** and install sizes
  **>300MB** ([chromiumembedded/cef#3836](https://github.com/chromiumembedded/cef/issues/3836)).
  Kabegame v4.3.0’s own desktop artifacts: **177MB** Windows setup `.exe`,
  **205MB** macOS `.dmg`, **240MB** `.deb`.
- CEF version is pinned (`tauri-runtime-cef` takes `cef = "=151.8.1"` at `9d1a5b1`);
  FabianLars (2024-05-06): “each cef update by itself is technically a breaking
  change.” Apps ship their own CEF; shared system CEF is not available yet (same
  #14963 / cef#3836).

Useful trackers: [tauri#14963](https://github.com/tauri-apps/tauri/issues/14963)
(“Bundle chromium renderer”), branch
[`feat/cef`](https://github.com/tauri-apps/tauri/tree/feat/cef).

### 2.1 Known CEF gaps (general)

Checked open on GitHub as of 2026-08-03 unless noted.

| Gap                                                                                                                                                                                                        | Severity for us                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IPC Origin missing on `WebviewUrl::External` ([#15190](https://github.com/tauri-apps/tauri/issues/15190), still open)                                                                                      | **N/A** — we bundle (`WebviewUrl::App`), not remote UI. Note: `ae1528a` / later Origin repair may mitigate; issue was opened after that commit and never closed — retest External only if we ever use it.                              |
| Custom-protocol URL mapping ≠ wry ([#15748](https://github.com/tauri-apps/tauri/issues/15748))                                                                                                             | Low if assets stay on the Tauri protocol                                                                                                                                                                                               |
| Linux DevTools breaking IPC ([#15764](https://github.com/tauri-apps/tauri/issues/15764))                                                                                                                   | Dev-only annoyance                                                                                                                                                                                                                     |
| Transparency → black screen / GPU crash on Linux ([#15718](https://github.com/tauri-apps/tauri/issues/15718))                                                                                              | N/A — no transparent OS window                                                                                                                                                                                                         |
| Custom toolbar drag crash on Linux ([#14936](https://github.com/tauri-apps/tauri/issues/14936))                                                                                                            | Only if we add frameless chrome + drag regions                                                                                                                                                                                         |
| Official CEF builds lack H.264/AAC ([chromium.org audio-video](https://www.chromium.org/audio-video/); [cef#3559](https://github.com/chromiumembedded/cef/issues/3559))                                    | Low — product media is AVIF / PQ stills / AV1-in-MP4, not H.264                                                                                                                                                                        |
| Windowing model differs by pin                                                                                                                                                                             | Watch HDR compositor empirically. Kabegame’s fork uses CEF Views owning the top-level window; current upstream `feat/cef` (post winit work) uses winit-owned window + Alloy child browser — don’t assume Views ownership on every pin. |
| CLI/bundler gotchas: helper apps, `Chromium Embedded Framework.framework`, Windows CEF app-manifest (`windows-cef-app-manifest.xml` when runtime is cef), Chromium ProcessSingleton on shared profile dirs | Packaging cost (see §6), not product logic                                                                                                                                                                                             |

`WebviewUrl::External` means “load an http(s) URL **inside** the app webview”
(Tauri config: “An URL to open on a Tauri webview window”), not “open in the
system browser.” Irrelevant once the UI is bundled.

## 3. What Bowerbird is today

Not Electron or Tauri (no `electron` / `@tauri-apps/*` deps, no `src-tauri`).
Bun + Hono API on a NAS/server (`DESIGN.md` §2), plus a separate Vite/React
client (`DESIGN.md` §1, §18). Client is HTTP `fetch`
(`web/src/api/client.ts`) + `EventSource`
(`web/src/features/events/events_presenter.ts`); no `invoke`, tray, updater, or
custom protocols in app code.

A desktop shell would:

1. Bundle the web client as Tauri assets.
2. Expose OS/local concerns via Tauri Rust (`invoke` / plugins).
3. Proxy NAS API and image traffic through that Rust layer (same-origin from the
   webview’s point of view).

## 4. Product-shaped risks

### 4.1 The editor stops being a wasm problem

The three editor routes (`track` / `still` / `rewrap`, `DESIGN.md` §21.2 at `v0.1.19`) handle
arbitrary browser engines and their in-page graded-frame limits. The proposed
shell avoids both: CEF pins Chromium; native grading builds no page-side frames.
Either would retire the shell's routes.

`hdr::prepare` and `hdr::grade_prepared` (`native/rawshim/src/hdr.rs:267`, `:342`)
carry no `cfg(target_arch)` and are already the functions the server's renditions
grade through, so the native backend grades a tick on real rayon threads and
pushes the result into a live 10-bit PQ stream the webview is already holding
open.

Deleted outright, not mitigated:

- **`routeFor()` and all three arms.** With them go the Chromium arm's
  machinery (`MediaStreamTrackGenerator`, `VideoFrame`, the `I444P10` probe) and
  the two fallbacks that only ever existed for other engines.
- The wasm module in the shell: 6.72MB, 3.85MB of it the libaom encoder and its
  build (§21.3 at `v0.1.19`: wasi-sdk, `setjmp`/`longjmp` lowering, the libsharpyuv
  host-archive trap), plus the `+simd128` landmine sitting on `fit::blur`.
- `SharedArrayBuffer`, and with it §4.2 entirely.

**One stream, one element, no per-tick URL.** Open a static live-stream URL;
the backend pushes graded frames, the element's `src` stays fixed. CEF's
`response_length` of -1 keeps reading until the handler stops; `Read` can return
zero bytes and invoke a callback when the next frame arrives
([`cef_resource_handler.h`](https://github.com/chromiumembedded/cef/blob/master/include/cef_resource_handler.h)).

This removes both blob-per-tick costs:

- **The decode cache.** `cc::ImageDecodeCache` is keyed by URL, which is why a
  six-second drag adds ~500MB that no page-side lever returns (§21.2 at `v0.1.19`,
  `raw_edit_presenter.ts:250`). One URL for the session, so nothing accumulates.
- **The drag limiter.** §21.3 at `v0.1.19` measured that "the encode is therefore _not_ what
  limits the drag on either route; swapping a fresh blob into an element each
  tick is". No swap, so that ceiling goes with it.

**Measure latency on the pin.** Media buffering smooths jitter, but sliders
need the newest frame immediately: hold the live edge without accumulating delay.
Reuse the rewrap route's `<video>` stage
(`raw_edit_presenter.ts:244`).

**Two transports, one grade.** Unless browser editing is dropped, shell and web
reach the same `hdr::` core through IPC versus a worker and `MessagePort`.
Only transport diverges (§21.1); dropping browser editing would unify it, a
product decision.

### 4.2 SharedArrayBuffer / COOP / COEP

Moot in the shell once §4.1 lands. Live while the shell still ships the wasm
editor, and live for the browser client either way.

The wasm editor needs `SharedArrayBuffer` for wasm-bindgen-rayon
(`native/rawshim` + `raw_edit_worker.ts`). Without cross-origin isolation,
`DESIGN.md` §21.5 at `v0.1.19`: failure is a **silent fall back to one thread**. E2e asserts
`crossOriginIsolated` in `web/e2e/editor/raw_editing.spec.ts`.

Today isolation headers exist only on Vite’s `server` and `preview` (`web/`); the
Bun/Hono API never serves the client bundle, so there is no second place they are
set:

```ts
// web/vite.config.ts
'Cross-Origin-Embedder-Policy': 'require-corp',
'Cross-Origin-Opener-Policy': 'same-origin',
```

Bundled Tauri does not go through Vite. Set the same headers on the Tauri asset
protocol via `app.security.headers` ([Tauri 2 HTTP headers docs](https://v2.tauri.app/security/http-headers/),
which call out SharedArrayBuffer). Stock Tauri applies them in
`crates/tauri/src/protocol/tauri.rs` via `add_configured_headers` on asset
responses — confirm the CEF pin still hits that path (§6).

```json
{
  "app": {
    "security": {
      "headers": {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp"
      }
    }
  }
}
```

CEF should support Chrome's COOP/COEP → `crossOriginIsolated` → SAB path once
document headers stick. This is inference, not a CEF smoke result: verify the pin.
WKWebView/custom-scheme isolation has failed despite headers (scheme,
secure-context, scheme-handler quirks); those distinct failures do not waive CEF checks.

NAS proxying through Rust keeps API/image responses same-origin (or under our
control for CORP), which is what `require-corp` wants.

### 4.3 Google Fonts under COEP

Checked 2026-08-03 against the fonts in `web/index.html` (IBM Plex Sans/Mono,
Space Grotesk):

| Resource                      | `Cross-Origin-Resource-Policy` | `Access-Control-Allow-Origin` |
| ----------------------------- | ------------------------------ | ----------------------------- |
| `fonts.googleapis.com/css2?…` | `cross-origin`                 | `*`                           |
| `fonts.gstatic.com/…/*.woff2` | `cross-origin`                 | `*`                           |

Under `COEP: require-corp`, MDN allows cross-origin loads via no-cors **if** the
response has a permissive CORP (or via CORS). Google’s CORP covers the
stylesheet `<link>` (no `crossorigin` required for the no-cors path) and the
`@font-face` woff2 fetches. Still network-dependent; self-host for offline /
no-network installs. Optional: add `crossorigin` on the stylesheet link for the
CORS path (`ACAO: *` already permits it).

### 4.4 CEF on Linux, wry on Windows/macOS

**This is the build.** `tauri` carries no runtime; the app depends on one runtime
crate per target, and everything downstream follows which one is linked:

- `tauri-runtime-cef` declares `links = "tauri_runtime_cef"`, which `tauri-build`
  reads back to swap `windows-app-manifest.xml` for
  `windows-cef-app-manifest.xml` and, on `unknown-linux-gnu`, add
  `-Wl,-rpath,$ORIGIN` so the binary finds `libcef.so` beside it.
- The CLI's bundler reads the target tables of `src-tauri/Cargo.toml` to decide
  whether the app is a CEF app, and only then copies `libcef.so`, the pak files and
  the locales into a deb or rpm, and assembles an AppImage with `sharun`.

`src-tauri/Cargo.toml` pins `rev`, not `branch`: the branch is absent from
crates.io and its tip moves.

```toml
[dependencies]
tauri = { git = "...", rev = "..." }

[target.'cfg(target_os = "linux")'.dependencies]
tauri-runtime-cef = { git = "...", rev = "..." }

[target.'cfg(not(target_os = "linux"))'.dependencies]
tauri-runtime-wry = { git = "...", rev = "..." }
```

Keep `tauri` itself to one entry. The CLI rewrites its feature list before every
build and passes one feature set across every `tauri` entry it finds, so a
feature on one target's entry lands on all of them.

In app code, `src-tauri/src/lib.rs` exports a `Runtime` alias, `CefRuntime` on
Linux and `WryRuntime` elsewhere, builds with `Builder::<Runtime>::new()`, and the
handlers take `AppHandle<crate::Runtime>`. On Linux `main` carries
`#[tauri_runtime_cef::cef_entry_point]`, which runs CEF's helper processes out of
the same binary.

**Only Linux pays for CEF.** The editor grades in page-side WGSL
(`docs/raw-edit-gpu.md` §10.1), which needs a webview with WebGPU and no
open-ended response, so wry's one-shot custom protocol serves it on Windows and
macOS. CEF adds ~180-240MB to the Linux bundles alone.

## 5. Decisions already made

- Prefer Tauri + CEF over Electron for the desktop shell.
- Bundle the frontend; do not load the NAS UI via `WebviewUrl::External`.
- Frontend ↔ Tauri Rust only; NAS I/O proxied through Rust.
- **Grade in the native Rust backend, not in wasm.** The backend pushes graded
  frames down one open-ended custom-protocol response, opened at editor load,
  into one `<video>` whose `src` never changes. No in-page frame generation, so
  no per-engine routes; no URL per tick, so no per-tick decode (§4.1).
- Keep Vite COOP/COEP semantics in the Tauri `security.headers` config only for
  as long as the shell still runs the wasm editor.

Open:

- Whether the browser client keeps its wasm editor at all, or browser-side
  editing is dropped and `hdr::` is reached natively only.
- CEF on every platform, or Linux only (§4.4). Not independent of the above: the
  native streaming editor requires CEF everywhere, since wry cannot hold a
  response open.

## 6. Smoke tests before committing to a CEF pin

Product, with the native editor of §4.1:

1. A natively graded 10-bit PQ stream, pushed down one open-ended custom-protocol
   response into one `<video>`, lights a real HDR display (not washed SDR).
2. Drag latency: the element holds at the live edge over a long scrub rather than
   accumulating buffer delay behind the pointer.
3. Google Fonts still render under COEP, if COEP survives at all (or self-host).

Only while the shell still ships the wasm editor:

4. `window.crossOriginIsolated === true` with bundled assets + Tauri headers
   (confirm CEF serves assets through the configured-headers path).
5. wasm rayon pool is multi-threaded (not the silent single-thread fallback).
6. `typeof MediaStreamTrackGenerator !== 'undefined'` on the pin: `routeFor()`
   probes only `new VideoFrame({ format: 'I444P10' })`, so a pin that builds the
   frame without the generator stays on `track` with no fallback,
   `RawEditPresenter` leaves `writer` null, and `await this.writer?.write(frame)`
   drops every graded frame (`raw_edit_presenter.ts:53`, `:221`). Blank stage,
   nothing reported.

Generic Tauri/CEF packaging (not evidenced in this repo — drawn from
`feat/cef` bundler / Kabegame notes):

7. Dev + release CEF profile / cache dirs isolated so Chromium’s ProcessSingleton
   does not attach the second launch to the first.
8. Windows: CEF app-manifest present so the GPU layered child window works
   (`tauri-build` injects `windows-cef-app-manifest.xml` when the runtime is cef;
   Kabegame documents this as mandatory — CEF #3765 class of failure).

## 7. References

- [Bundle chromium renderer — tauri#14963](https://github.com/tauri-apps/tauri/issues/14963)
- [feat/cef branch](https://github.com/tauri-apps/tauri/tree/feat/cef)
- [External IPC Origin — tauri#15190](https://github.com/tauri-apps/tauri/issues/15190)
- [Tauri HTTP headers / SharedArrayBuffer](https://v2.tauri.app/security/http-headers/)
- [CEF shared install / size — cef#3836](https://github.com/chromiumembedded/cef/issues/3836)
- [CEF proprietary codecs — cef#3559](https://github.com/chromiumembedded/cef/issues/3559)
- `DESIGN.md` §1–§2, §18 (client), §21 (RAW editor / HDR routes)
- `web/vite.config.ts`, `web/e2e/editor/raw_editing.spec.ts`, `web/src/features/raw_edit/`
