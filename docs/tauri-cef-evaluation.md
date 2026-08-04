# Tauri + CEF evaluation

Date: 2026-08-03  
Reviewed: 2026-08-03 (claims re-checked against live GitHub/API, Tauri docs, and this repo)

Whether Bowerbird’s desktop shell should be **Tauri with a bundled Chromium
(CEF)** rather than Electron or stock Tauri (system webview). Product constraint:
UI is bundled into the app; the frontend talks only to the in-app Tauri Rust
backend; NAS traffic is proxied through that Rust layer.

## 1. Verdict

Tauri + CEF is a reasonable fit. Nothing in the current codebase is a hard
blocker.

The two checks this doc first called load-bearing (Chromium feature parity for
the HDR editor, cross-origin isolation for `SharedArrayBuffer`) are load-bearing
only while the shell grades in wasm. It should not. Under Tauri the grade belongs
in the native Rust backend, which **deletes** both risks rather than mitigating
them (§4.1). What is left to check on a real pin is packaging (§6), not product
logic.

Stock Tauri (WebView2 / WKWebView / WebKitGTK) is the wrong default: Linux
WebKitGTK is a known QA sink (maintainers have said as much on
[tauri#14963](https://github.com/tauri-apps/tauri/issues/14963)), and we want a
pinned Chromium everywhere.

## 2. What Tauri CEF is today

Stable Tauri uses the OS webview via wry (WKWebView / WebView2 / WebKitGTK). That
is the documented default (`v2.tauri.app` architecture / start pages; `dev`
`Cargo.toml` defaults to `wry`). Bundled Chromium is the **CEF** path:

- Lives on branch [`feat/cef`](https://github.com/tauri-apps/tauri/tree/feat/cef)
  (tip at check time: `4af26a3`, **2026-07-31**).
- Opt-in on that branch: enable the **`cef` Cargo feature**, which pulls in
  `tauri-runtime-cef`, and pin deps / CLI to the branch. Not on stable crates.io
  as a turnkey default.
- FabianLars (2026-04-03 on #14963): “the branch is mostly usable but like I said
  above, **you're on your own when you want to try it**. We cannot yet offer much
  help (please do report issues though if you do try it).”
- Production apps already ship CEF-backed Tauri: **Kabegame** (own
  `tauri-runtime-cef`, cited on #14963) and **OpenHuman** (vendored `tauri-cef`
  fork of `feat/cef`, still on CEF 146.4.1 while the branch pins 150; each app
  carries its own pin).
- Timeline: simonhyll (2024-06-03 on #14963) on CEF: “can't be done for v2 both from
  an amount of work point of view and a security audit point of view. Earliest it
  can possibly happen is in Tauri version 3.” Opt-in when it lands, not a firm
  promise, and not the `tauri create` default.
- Size: CEF upstream cites installer sizes **>100MB** and install sizes
  **>300MB** ([chromiumembedded/cef#3836](https://github.com/chromiumembedded/cef/issues/3836)).
  Kabegame v4.3.0’s own desktop artifacts: **177MB** Windows setup `.exe`,
  **205MB** macOS `.dmg`, **240MB** `.deb`.
- CEF version is pinned (`feat/cef` was on `cef = "=150.0.0"` at check time);
  FabianLars (2024-05-06): “each cef update by itself is technically a breaking
  change.” Apps ship their own CEF; shared system CEF is not available yet (same
  #14963 / cef#3836).

Useful trackers: [tauri#14963](https://github.com/tauri-apps/tauri/issues/14963)
(“Bundle chromium renderer”), branch
[`feat/cef`](https://github.com/tauri-apps/tauri/tree/feat/cef).

### 2.1 Known CEF gaps (general)

Checked open on GitHub as of 2026-08-03 unless noted.

| Gap | Severity for us |
|---|---|
| IPC Origin missing on `WebviewUrl::External` ([#15190](https://github.com/tauri-apps/tauri/issues/15190), still open) | **N/A** — we bundle (`WebviewUrl::App`), not remote UI. Note: `ae1528a` / later Origin repair may mitigate; issue was opened after that commit and never closed — retest External only if we ever use it. |
| Custom-protocol URL mapping ≠ wry ([#15748](https://github.com/tauri-apps/tauri/issues/15748)) | Low if assets stay on the Tauri protocol |
| Linux DevTools breaking IPC ([#15764](https://github.com/tauri-apps/tauri/issues/15764)) | Dev-only annoyance |
| Transparency → black screen / GPU crash on Linux ([#15718](https://github.com/tauri-apps/tauri/issues/15718)) | N/A — no transparent OS window |
| Custom toolbar drag crash on Linux ([#14936](https://github.com/tauri-apps/tauri/issues/14936)) | Only if we add frameless chrome + drag regions |
| Official CEF builds lack H.264/AAC ([chromium.org audio-video](https://www.chromium.org/audio-video/); [cef#3559](https://github.com/chromiumembedded/cef/issues/3559)) | Low — product media is AVIF / PQ stills / AV1-in-MP4, not H.264 |
| Windowing model differs by pin | Watch HDR compositor empirically. Kabegame’s fork uses CEF Views owning the top-level window; current upstream `feat/cef` (post winit work) uses winit-owned window + Alloy child browser — don’t assume Views ownership on every pin. |
| CLI/bundler gotchas: helper apps, `Chromium Embedded Framework.framework`, Windows CEF app-manifest (`windows-cef-app-manifest.xml` when runtime is cef), Chromium ProcessSingleton on shared profile dirs | Packaging cost (see §6), not product logic |

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

The three editor routes (`track` / `still` / `rewrap`, `DESIGN.md` §21.2) exist
because two constraints stack: the browser client has to run on whatever engine
the user brought, **and** the editor generates graded frames in the page, so each
engine's in-page frame types become the wall. The shell has neither constraint.
CEF means one pinned Chromium, so there is no engine to branch on; native grading
means the page builds no frames, so there is no capability wall to hit. Either
alone would retire the routes for the shell.

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
  build (§21.3: wasi-sdk, `setjmp`/`longjmp` lowering, the libsharpyuv
  host-archive trap), plus the `+simd128` landmine sitting on `fit::blur`.
- `SharedArrayBuffer`, and with it §4.2 entirely.

**One stream, one element, no per-tick URL.** The webview gets a single static
URL at editor open, pointed at a live stream the backend pushes graded frames
into. The element's `src` never changes. CEF's resource handler is shaped for
exactly that: a `response_length` of -1 marks the body open-ended and CEF keeps
reading until the handler stops, and `Read` may return zero bytes now and fire a
callback when the next frame exists
([`cef_resource_handler.h`](https://github.com/chromiumembedded/cef/blob/master/include/cef_resource_handler.h)).

That removes both costs that make today's still route expensive, and both were
artifacts of the blob-per-tick hand-off rather than of serving pixels at all:

- **The decode cache.** `cc::ImageDecodeCache` is keyed by URL, which is why a
  six-second drag adds ~500MB that no page-side lever returns (§21.2,
  `raw_edit_presenter.ts:250`). One URL for the session, so nothing accumulates.
- **The drag limiter.** §21.3 measured that "the encode is therefore *not* what
  limits the drag on either route; swapping a fresh blob into an element each
  tick is". No swap, so that ceiling goes with it.

**The risk moves to latency.** A media pipeline buffers to smooth jitter, and a
slider wants the newest frame now, so the drag has to hold at the live edge
instead of accumulating delay. That is what to measure on the pin, and it
replaces the memory question rather than relabelling it. The stage element is not
new work: the rewrap route already hands a `<video>` its frames
(`raw_edit_presenter.ts:244`).

**The cost is two transports, not two grades.** The browser client keeps the wasm
editor unless browser-side editing is dropped, so shell and web client would
reach the same `hdr::` core through different plumbing (IPC versus a worker and a
`MessagePort`). That is the tolerable half of the divergence §21.1 warns about:
the picture stays one implementation and only the transport forks. Dropping
browser-side editing collapses it to one, and that is a product call.

### 4.2 SharedArrayBuffer / COOP / COEP

Moot in the shell once §4.1 lands. Live while the shell still ships the wasm
editor, and live for the browser client either way.

The wasm editor needs `SharedArrayBuffer` for wasm-bindgen-rayon
(`native/rawshim` + `raw_edit_worker.ts`). Without cross-origin isolation,
`DESIGN.md` §21.5: failure is a **silent fall back to one thread**. E2e asserts
`crossOriginIsolated` in `web/e2e/raw_editing.spec.ts`.

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

CEF embeds Chromium, so the usual Chrome COOP/COEP → `crossOriginIsolated` →
SAB path should apply once headers stick on the document; that is an inference,
not a CEF-specific smoke result — verify on the pin. Stock WKWebView /
custom-scheme apps have historically had cases where COOP/COEP were set but
isolation still failed (scheme / secure-context / scheme-handler quirks); that
is a different failure class from Chromium, and not a reason to skip the CEF
check.

NAS proxying through Rust keeps API/image responses same-origin (or under our
control for CORP), which is what `require-corp` wants.

### 4.3 Google Fonts under COEP

Checked 2026-08-03 against the fonts in `web/index.html` (IBM Plex Sans/Mono,
Space Grotesk):

| Resource | `Cross-Origin-Resource-Policy` | `Access-Control-Allow-Origin` |
|---|---|---|
| `fonts.googleapis.com/css2?…` | `cross-origin` | `*` |
| `fonts.gstatic.com/…/*.woff2` | `cross-origin` | `*` |

Under `COEP: require-corp`, MDN allows cross-origin loads via no-cors **if** the
response has a permissive CORP (or via CORS). Google’s CORP covers the
stylesheet `<link>` (no `crossorigin` required for the no-cors path) and the
`@font-face` woff2 fetches. Still network-dependent; self-host for offline /
no-network installs. Optional: add `crossorigin` on the stylesheet link for the
CORS path (`ACAO: *` already permits it).

### 4.4 CEF on Linux only, wry on Windows/macOS?

**As a build switch: yes, near enough free.** The runtime is a Cargo feature, and
everything downstream follows it:

- `crates/tauri/build.rs` emits
  `println!("cargo:runtime={}", if has_feature("cef") { "cef" } else { "wry" })`.
- `tauri-build` reads that back as `DEP_TAURI_RUNTIME` and swaps
  `windows-app-manifest.xml` for `windows-cef-app-manifest.xml`, and on
  `unknown-linux-gnu` adds `cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN` so the
  binary finds `libcef.so` beside it.
- App code is untouched: `app.rs` carries
  `#[cfg(feature = "cef")] impl Default for Builder<crate::Cef>` alongside the
  wry one, so `tauri::Builder::default()` resolves to `Builder<Cef>` on a
  cef-only build.

So a per-target dependency table is the whole switch:

```toml
[target.'cfg(not(target_os = "linux"))'.dependencies]
tauri = { version = "2", features = ["..."] }

[target.'cfg(target_os = "linux")'.dependencies]
tauri = { version = "2", default-features = false, features = ["cef", "..."] }
```

`default-features = false` is load-bearing. Nothing emits a `compile_error!` when
both features are on: `build.rs` would report `cef` (so the build takes the CEF
manifest and rpath) while `Builder::default()` still resolves to `Builder<Wry>`,
because `#[default_runtime(crate::Wry, wry)]` keeps defaulting the generic to
`Wry` whenever the `wry` feature is present. A silently mismatched build.

**As a product decision: it forks the editor, and that is the real cost.** The
§4.1 design needs an open-ended response the backend pushes into, and only CEF
has one. wry's custom protocol is one-shot:

```rust
Fn(WebViewId, Request<Vec<u8>>) -> Response<Cow<'static, [u8]>>
```

and the async form's `RequestAsyncResponder::respond(self, ...)` takes `self` by
value, so it answers exactly once with a finished buffer. No incremental push, no
open body.

That leaves two coherent positions and no halfway:

- **CEF everywhere.** Native grading, one pushed stream, `routeFor()` and the
  wasm module deleted from the shell (§4.1). Every platform pays CEF's ~180-240MB.
- **CEF on Linux only.** CEF is purely an escape from WebKitGTK, and the editor
  stays as it is today: wasm, `SharedArrayBuffer`, COOP/COEP, and `routeFor()`
  picking between WebView2 (Chromium, so `track`) and WKWebView (so `still`).
  Windows and macOS bundles stay small.

The trap is taking the native editor *and* the mixed build, which puts two grade
transports in one product: a pushed stream on Linux and the wasm routes
everywhere else, with the wasm module shipped in two of three bundles anyway. The
per-engine branching §4.1 deletes would come straight back, one layer up.

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
- `web/vite.config.ts`, `web/e2e/raw_editing.spec.ts`, `web/src/features/raw_edit/`
