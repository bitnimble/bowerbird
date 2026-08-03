# Tauri + CEF evaluation

Date: 2026-08-03  
Reviewed: 2026-08-03 (claims re-checked against live GitHub/API, Tauri docs, and this repo)

Whether Bowerbird’s desktop shell should be **Tauri with a bundled Chromium
(CEF)** rather than Electron or stock Tauri (system webview). Product constraint:
UI is bundled into the app; the frontend talks only to the in-app Tauri Rust
backend; NAS traffic is proxied through that Rust layer.

## 1. Verdict

Tauri + CEF is a reasonable fit. Nothing in the current codebase is a hard
blocker. The load-bearing checks are Chromium feature parity for the HDR editor
(`MediaStreamTrackGenerator`, 10-bit PQ) and cross-origin isolation for
`SharedArrayBuffer` — both look solvable under CEF with the right config, and
both need a smoke test on a real pin of CEF, not a paper review.

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
- FabianLars (2026-02-17 on #14963): the branch is “currently more like **source
  available than open source** since most of the development happens at work.”
  Also: “you're on your own when you want to try it.”
- Production apps already ship CEF-backed Tauri: **Kabegame** (own
  `tauri-runtime-cef`, cited on #14963) and **OpenHuman** (vendored `tauri-cef`
  fork of `feat/cef`).
- Timeline: maintainers have said CEF won’t be in v2; earliest hoped landing is
  **v3 or v4**, as an opt-in — not a firm promise and not `tauri create` default.
- Size: CEF upstream cites installer sizes **>100MB** and install sizes
  **>300MB** ([chromiumembedded/cef#3836](https://github.com/chromiumembedded/cef/issues/3836)).
  Real CEF desktop installers (Kabegame / OpenHuman releases) often land
  **~180–340MB**.
- CEF version is pinned (`feat/cef` was on `cef = "=150.0.0"` at check time);
  FabianLars: each CEF update is “technically a breaking change.” Apps ship their
  own CEF; shared system CEF is not available yet (same #14963 / cef#3836).

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

### 4.1 HDR editor (Chromium path)

The blessed live-HDR route on Chromium uses `MediaStreamTrackGenerator` and
10-bit PQ `VideoFrame` (`web/src/features/raw_edit/`, route `track` via
`supportsTenBit()` in `raw_edit_route.ts`).

Silent SDR failure modes in this product are mostly **wrong depth / missing
cICP / wrong route** (`DESIGN.md` §21.2, §21.5) — engines accept a picture that
is ordinary SDR without refusing. Absence of the Chromium track APIs selects a
different route (`still` / `rewrap`), which is a different failure class. Either
way: CEF must be new enough for `I444P10` + PQ compositing, and HDR must be
checked on real hardware.

### 4.2 SharedArrayBuffer / COOP / COEP

The wasm editor needs `SharedArrayBuffer` for wasm-bindgen-rayon
(`native/rawshim` + `raw_edit_worker.ts`). Without cross-origin isolation,
`DESIGN.md` §21.5: failure is a **silent fall back to one thread**. E2e asserts
`crossOriginIsolated` in `web/e2e/raw_editing.spec.ts`.

Today isolation headers are only on the Vite HTTP server:

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

## 5. Decisions already made

- Prefer Tauri + CEF over Electron for the desktop shell.
- Bundle the frontend; do not load the NAS UI via `WebviewUrl::External`.
- Frontend ↔ Tauri Rust only; NAS I/O proxied through Rust.
- Keep Vite COOP/COEP semantics in the Tauri `security.headers` config.

## 6. Smoke tests before committing to a CEF pin

Product / isolation:

1. `window.crossOriginIsolated === true` with bundled assets + Tauri headers
   (confirm CEF serves assets through the configured-headers path).
2. wasm rayon pool is multi-threaded (not the silent single-thread fallback).
3. HDR track route lights a real HDR display (10-bit PQ, not washed SDR).
4. Google Fonts still render under COEP (or switch to self-hosted).

Generic Tauri/CEF packaging (not evidenced in this repo — drawn from
`feat/cef` bundler / Kabegame notes):

5. Dev + release CEF profile / cache dirs isolated so Chromium’s ProcessSingleton
   does not attach the second launch to the first.
6. Windows: CEF app-manifest present so the GPU layered child window works
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
