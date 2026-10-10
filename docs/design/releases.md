# Bowerbird design: Releasing, and updating in place

A chapter of [`DESIGN.md`](../../DESIGN.md). The chapters are numbered as one document, so
`DESIGN §N` anywhere in the repo, and a `§N` cited here that is not below, both mean the
section the index in `DESIGN.md` maps §N to.

---

## 23. Releases and updates

A release is a git tag. `.github/workflows/release.yml` builds every platform, attaches
binaries to a GitHub release, publishes the container to GHCR, and writes `release.yml`
mapping binaries to platforms. Installed Bowerbird reads it, downloads a newer payload
for its platform, and hands off to an updater that swaps it in and restarts.

### 23.1 The changelog is the release description

The GitHub release body is the changelog, rendered from markdown in `release_notes.tsx`.
`bun run release` writes it into `changelog.json` under the new tag, in the same commit as
`VERSION`: `scripts/changelog.ts` has `claude -p` sort the commits since the last tag into
New, Improved and Fixed, keeping only what a user would notice. Without claude, or when the
call fails, the entry is "Bug fixes and performance improvements". The workflow publishes the
tag's entry as the release description.

The dialog is **cumulative**: every release newer than the running version, newest first,
including all three months if the reader skipped three months.

Notes are fetched when the dialog opens, not compiled in; correct typos by editing the release.

### 23.2 `release.yml`: a platform, and what it is called there

The workflow names every installer `Bowerbird_<version>_<platform><kind>` -
`Bowerbird_0.2.0_macos-arm64.dmg`, `Bowerbird_0.2.0_windows-x86_64-setup.exe` - but the kind
is whichever bundle a platform ships, so a client that built the filename itself would 404
the day a platform changed bundler. The manifest maps the platform to whatever they actually
came out called:

```yaml
version: 0.2.0
tag: v0.2.0
assets:
  macos-arm64:
    installer: Bowerbird_0.2.0_macos-arm64.dmg
    payload: bowerbird-payload-macos-arm64.tar.gz
    payload_sha256: 9f2…
  android-arm64:
    installer: Bowerbird_0.2.0_android-arm64.apk
  docker-x86_64:
    image: ghcr.io/bitnimble/bowerbird:0.2.0
```

`installer` is the user download; `image` is the container; `payload` replaces an existing
install. Either may appear alone: Android and containers cannot replace themselves;
a payload without an installer is reachable only by existing installs. Failed platforms
are absent, so their installs report no available build instead of a 404.
The image is named only when the container job pushed it
(`write-release-manifest.ts --image-repo`).

It is **generated from upload files** (`scripts/write-release-manifest.ts`). Reader and
writer share a module and round-trip test (`release_manifest.ts`); no format library
protects their agreement, so that test prevents unreadable releases.

### 23.3 The updater, and why the app does not replace itself

**What replaces an install is never a process running out of it.** The server downloads and
checks a payload, unpacks it into `<home>/staged`, writes `staged.version` last, and exits
`75`. The desktop app sees that exit, copies `bowerbird-updater` out of its install into
`<home>`, starts the copy and exits. The updater waits for the app's process to be gone,
swaps the payload's entries into the install, and starts the app again - the way Sparkle and
Tauri's own updater replace a `.app`.

```
<home>/                          the app-data folder's `updates/`
  staged/                        the payload, unpacked
  staged.version                 written last, and what says `staged/` is complete
  updater.log                    what the updater did, since it runs with nowhere to print
  bowerbird-updater              the copy that runs
<install>/                       the folder holding the `.app`, or the NSIS install directory
  <entry>                        live
  .<entry>.bowerbird-incoming    the payload's copy, moved in before anything is swapped
  .<entry>.bowerbird-previous    the copy it replaced, until the new version has started
```

`native/updater` is the logic, with its own suite, and `src-tauri/src/bin/bowerbird-updater.rs`
is the binary. Tauri bundles every binary in the crate beside the shell - `Contents/MacOS/` in
the `.app`, the install directory on Windows - so the installers carry it with nothing added to
them. It knows nothing about GitHub, releases or downloads.

Updater guarantees:

- **A copy runs, not the installed binary**, because the updater in the install is one of the
  entries a payload replaces.
- **Every entry is moved in before any is swapped.** A rename, or a copy where `<home>` and the
  install are on different volumes, so the slow part happens while the install is still whole.
  Then each live entry is renamed aside and its replacement renamed in, and a failure part way
  puts back every one already swapped and starts the version that was there.
- **Only the payload's entries.** NSIS's `uninstall.exe`, or the other apps beside a bundle in
  `/Applications`, are left alone. The shell is renamed on the way in: the payload calls it
  `Bowerbird.app` or `bowerbird-app.exe`, and the install calls it whatever the installer or
  the reader did, which `update.rs` passes as `--rename`.
- **Rollback.** A version that exits non-zero within thirty seconds, or cannot be started, is a
  bad update rather than a crash: every `.bowerbird-previous` is put back and the old version
  started. One that runs for an hour and then crashes is a crash, and rolling back would throw
  away whatever the reader did in that hour. Past the thirty seconds, or closed cleanly inside
  them, the previous entries are deleted.
- **An administrator only where the install needs one.** On Windows an install the updater
  cannot write to - one under Program Files - is handed to an elevated copy of the updater
  through UAC one phase at a time, the swap, the restore and the cleanup, so the app it starts
  runs as the reader rather than as an administrator. On macOS such an install is never offered
  an in-place update: a standard user's `/Applications`, or a bundle started from its disk image
  or from Downloads, which macOS runs from a read-only copy. `update.rs` leaves
  `BOWERBIRD_UPDATES` unset there, and the dialog offers the installer.
- **On Windows every rename and delete is retried for ten seconds**, because a file stays locked
  for a moment after the process that held it exits, and a virus scanner opens every new
  executable it sees.
- **macOS's App Management** (from macOS 13) stops one app changing another signed by a
  different team. The updater and the bundle are signed together, so a Developer ID build is
  inside the documented rule. An ad-hoc build has no team at all; one replacing its own bundle
  was measured elsewhere to go through on macOS 26.2 with no prompt, which Apple documents
  neither way.

**The container is not updated in place.** It is updated the way containers are, by pulling
the new image (`docker compose pull`), which the manifest names and the dialog says.

### 23.4 What a payload is

Payloads contain release files, excluding installer-owned Start menu entries and registry
keys, whose replacement would need an administrator.

| Platform | Payload                                                                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| windows  | `bowerbird-app.exe`, `bowerbird-server.exe`, `bowerbird-updater.exe`, `resources/`, and the DLLs the shell resolves out of its own directory (§23.7.1) |
| macOS    | a whole `Bowerbird.app`, the server and the updater inside it                                                                                          |

### 23.5 Where the check runs

`UpdateService` checks on the server: a browser opening a NAS is offered the NAS's update.
One hourly call covers every tab watching that library. Answers are cached for ten
minutes, limiting launch and hourly checks to six GitHub calls an hour.

Failure is **quiet**: offline libraries still work. Settings shows the reason; the sidebar
has no badge and no hourly error toast.

`can_install` is the server reporting that there is something newer and that the desktop app
told it where to stage an update (`BOWERBIRD_UPDATES`), which the app does only where it can
replace itself (§23.3).
Anywhere else - the container, Android, a macOS install it cannot write to - the dialog
offers the installer or the image instead of a button that could only half work.

**Where it looks is a setting, and it is two URLs rather than one** (`update_source.ts`).
`BOWERBIRD_UPDATE_REPO` names a repository on github.com; `BOWERBIRD_UPDATE_URL` replaces
the endpoint outright, for a mirror, an air-gapped release server, or a fork that does not
live on GitHub at all. Either set empty turns checking off.

Release file locations need no third setting: downloads use each release's
`assets[].browser_download_url` when present. For responses without assets,
`github.com/<repo>/releases/download/<tag>/<file>` is the fallback; on github.com they agree.

**Fallback applies only to lists from github.com.** Other endpoints have no implied
repository; guessing would send air-gapped deployments to the public repo. Downloads
instead fail naming missing `assets`. `install_hint`, computed on every
`GET /api/updates`, falls back to the release page so status requests do not fail.

So an endpoint has to answer in GitHub's shape - a list of objects with `tag_name`, `body`,
`published_at`, `html_url`, and, for anything that is not github.com, `assets`. That is a
small enough contract to serve from a static file, and is most of why `release.yml` (§23.2)
carries everything else.

### 23.6 What the reader sees

- **The sidebar**, one row, and only when there is something newer: an arrow and the version.
  Same reasoning as the conflicts and replication rows beside it - a reader with nothing to
  decide should not carry a permanent reminder that updates exist.
- **The dialog** it opens: what is running, what it would become, the cumulative notes, and
  one button.
- **Settings**, for the two moments hourly is not enough: a reader who has just been told a
  fix is out, and one wondering whether the silence means "up to date" or "cannot reach
  GitHub".

The button downloads the payload, verifies the manifest's SHA-256, unpacks it and exits
to the updater. The page polls until the new version answers, then reloads; reloading
earlier would show a blank screen while the server restarts.

### 23.7 What the platforms can and cannot do

| Platform       | Ships           | Local server | In-place update           |
| -------------- | --------------- | ------------ | ------------------------- |
| linux-x86_64   | nothing, paused | -            | -                         |
| macos-arm64    | dmg             | yes          | yes                       |
| windows-x86_64 | NSIS installer  | yes          | yes                       |
| android-arm64  | apk, Play aab   | yes          | **no**                    |
| docker-x86_64  | ghcr image      | yes          | no, `docker compose pull` |

**The Linux desktop is paused, and the container is not.** A server reaches Linux through the
image above, which is where every Linux reader is; the desktop arm was built for completeness and
has nobody on it. What paused it is the runtime: the shell draws with CEF on Linux and with Wry
elsewhere, and the Tauri CLI rewrites `src-tauri/Cargo.toml` on every build, unioning a
dependency's features across target tables - so `cef` is hoisted off the Linux `tauri` and written
onto the other one, which still has `wry`. Both runtimes at once is the mismatch that manifest
warns about, and it lands on macOS and Windows rather than on Linux. The row in `release.yml` is
commented out with the same reasoning beside it; uncommenting it is the whole of turning this back
on, once the shell draws with one runtime everywhere or the manifest can state two without the CLI
merging them.

**Every platform is one triple**, Windows included: `x86_64-pc-windows-msvc` builds the shell,
`rawshim` and the Bun runtime beside them, exactly as the other two rows build theirs. No
compiler forces otherwise, and that is worth stating because the reverse is easy to assume:
libjxl builds under `cl.exe` and under `clang-cl`, and libavif always did.

**The codecs are vcpkg's, built static on every platform.** `bun run get:codecs` installs libavif
and libjxl and the six libraries under them - aom, dav1d and sharpyuv under libavif; highway,
brotli and lcms2 under libjxl - on `arm64-osx`, `x64-windows-static-md` and `x64-linux`, and
`--target aarch64-linux-android` cross-builds them for `arm64-android` into a tree of its own,
`.codecs-aarch64-linux-android`, which `build.rs` links when cargo builds for the phone. On
Windows `-static-md` is the load-bearing half of the name: static archives against the _dynamic_
C runtime, which is the runtime Rust's MSVC target links.

**Every version is written down once, in one vcpkg commit** (`scripts/get-codecs.ts`), which fixes
each port and the vcpkg tool alike. The tree in `~/.cache/bowerbird` is named for the hash of that
commit and of `native/rawshim/vcpkg/` (`scripts/pinned.ts`), so moving the commit or editing an
overlay rebuilds rather than reusing. So the aom that encodes a rendition is the same on every
machine that builds the app, and the `encode` rows of `bench.budget.json` are recorded against it.

Two things in `native/rawshim/vcpkg/` are ours rather than vcpkg's. An overlay libavif builds
against sharpyuv instead of libyuv: without the first every 4:2:0 encode answers
`NOT_IMPLEMENTED`, and with the second libavif converts RGB with libyuv's rounding and moves
every rendition's pixels. And the triplets skip the debug builds nothing links, and pin macOS's
deployment target to 11.0, Rust's own floor for Apple silicon, rather than whichever macOS the
build machine runs.

### 23.7.1 The app carries every library it opens

**What an installed Bowerbird asks a machine for is a C library, a C++ runtime, a loader and a
Vulkan driver (§2.1).** Every codec is inside `librawshim` (§23.7), so a reader's machine can
neither substitute a different aom nor lack one - which it could when they were shared libraries,
since nothing declared the dependency and nothing could: Tauri's deb bundler writes its own control
file and never runs `dpkg-shlibdeps`, and the library is a resource rather than the executable, out
of reach of a packager that did look.

**On macOS the C++ runtime is the OS's, so there is nothing to carry, and that is checked.**
`build-sidecar.ts` fails the build on anything `otool -L` names outside `/usr/lib` and `/System`:
a Homebrew library links on the build machine and is missing on a reader's Mac.

**Linux carries its C++ runtime.** A distribution's libstdc++ is whichever that distribution
shipped, so `build-sidecar.ts` walks what `librawshim` resolved and ships libstdc++ and libgcc_s
into `resources/native` beside it - never the C library itself, since two of those in one process
is not a mismatch that degrades, it is two allocators and two `errno`. Every copy gets `$ORIGIN`,
not just the library the server opens, a search path not reaching a dependency's own dependencies.
It is a `DT_RPATH` rather than the `DT_RUNPATH` patchelf writes by default, because the loader
consults a runpath _after_ `LD_LIBRARY_PATH`: an app launched from a shell that names an older
libstdc++ would otherwise get that one and fail in the way carrying a copy exists to prevent. After
relocating, every object is walked again and anything still naming a path outside the tree fails
the build.

**What the Linux artefacts then ask of a machine is glibc, and the runner decides which.** The
deb and the AppImage are built on Ubuntu 24.04, so `librawshim.so` and the libstdc++ beside it
want `GLIBC_2.38` and neither will start on Ubuntu 22.04 or Debian 12. That floor follows the
runner rather than being chosen, and raising it is what moving off a retired image costs.

**Windows has nothing to carry** of `rawshim.dll`'s own, the MSVC C++ runtime being the C runtime
the shell already asks for. What still goes beside the executables is whatever the _shell_ imports, Tauri's
`WebView2Loader.dll` among them: `build-payload.ts` copies every DLL cargo left in the release
directory into the tarball's root, which the updater swaps into the install directory beside
the executables, so a fresh install and an in-place update resolve alike.

**Android carries its server as the desktop does, but executes only what is in `jniLibs`.**
The platform maps code only from the native library directory its package installer fills, and
only from files named `lib*.so`, so Bun's own Android build ships as `libbun.so`, beside
`librawshim.so` and the two native addons, `libsql` (compiled from its tag, since it publishes no
Android build) and Parcel's watcher (compiled from the installed package's source, since its
Android build is linked for 4 KB pages), both by `get:android-runtime`. Play refuses a library a
16 KB page device cannot map, so every one links with `ANDROID_PAGE_SIZE_LINK_ARG` and
`android-build.ts` fails a build whose APK or AAB holds one aligned to less. The Gradle project is patched to
extract them on install and to allow cleartext to `127.0.0.1` alone (`android-build.ts`), and
`build-sidecar.ts` fails the build on any of them needing a library outside the NDK's stable set
and what ships beside them: the codecs' libc++ is the NDK's static one, and Parcel's watcher
wants the shared one, which ships as `libc++_shared.so`. The bundle and the page are only read,
so they travel as the app's assets and `android.rs` unpacks them into the data directory once per
build, keyed by the `payload-id` hash `build-sidecar.ts` writes beside them. The bundle loads each
addon through a loader that opens it from `BOWERBIRD_ADDON_DIR`.

**The mobile app holds synced libraries only.** Its server can read nothing in the phone's shared
storage, so the app offers no local library to add, only a connection to another Bowerbird. The
request names no folder and the server puts the library under `BOWERBIRD_LIBRARIES_DIR`, which
the shell sets inside the app's own storage. It keeps no originals and sends or fetches none
automatically. The page treats it as a thin shell (`isThinShell`):
a library's path, folder rules, scanning, watching, stacks and backups are hidden, having nothing
on this device to act on, and the server starts with watching and the daily scan off (`BOWERBIRD_DEFAULT_SETTINGS`).

**Android cannot replace itself at all.** An APK is read-only and the platform will not run
code loaded from the data directory, so the dialog offers the download and the system
installer takes it from there.

**The Play build checks for no updates.** Play forbids an app updating itself any other way, so
`android-build.ts --play` compiles its AAB with `BOWERBIRD_UPDATE_URL` empty, which the shell
hands the server, and Settings shows the version without a check button. Both are signed with one
key, given to the Play Console as the app signing key, so either install updates the other. `release.yml`'s
`play` job uploads the AAB to the internal track, behind the `play` environment's reviewer, with a
token from Google's workload identity federation rather than a stored key.

### 23.8 Versions

**Root `VERSION` is the sole version source.** `src/version.ts` imports it for server
reports and update comparisons. `bundle-app.ts`, `android-build.ts` and `mac-build.ts`
pass it to Tauri as `--config`; manifests carry no separate version.
`write-release-manifest.ts` and the APK use it in their names.

**`bun run release` cuts one**: on a clean tree on `main` it writes the next patch version into
`VERSION` - or the semver version it is given, or `0.0.0-<hash>` for a commit hash - commits it,
and tags the commit `v<VERSION>`; `git push --follow-tags` then starts the workflow, which runs
on a push to `main` that changes `VERSION`. That push must carry the tag: a ruleset lets only
the repository's admin create `v*` tags, so the workflow cannot make one and `plan` fails without
it. GitHub restores caches from the current ref and
`main`; distinct release tags cannot share entries they save. Running on `main` lets each
release reuse caches saved by earlier releases.

**Nothing third-party is fetched twice at one pin.** Bun, Rust and the NDK are pinned once each,
by `.bun-version`, `rust-toolchain.toml` and `.android-ndk-version`, which the workflow, both
Dockerfiles and `android-build.ts` all read. Every download sits behind a cache: the toolchains,
both lockfiles' packages, crates, the pinned trees, vcpkg's port builds, Gradle, the Windows
bundler's NSIS, wasm-pack and wasm-bindgen, and the one LFS file a job reads. A cache holding
several pins (packages, crates, pinned trees, Gradle) restores its last save when its key misses,
so a moved pin fetches what moved and nothing else. The image's cache mounts travel through the
same cache (`buildkit-cache-dance`), apt's downloads among them.

The workflow's first job refuses a `v<VERSION>` tag on any commit but the one it built, because a build that
ships calling itself something other than its tag is the failure that leaves an update check
offering a version that is already installed, forever; with no tag pushed, `publish` makes one.

**`bun run release:check` builds the release artifacts locally.** It builds HEAD in a
detached worktree, since a tag releases the commit and an uncommitted edit would otherwise decide
the answer. The container is `docker build` on the `Dockerfile` the workflow builds, and the apps
are the `android`, `macos` and `windows` stages of `cross.Dockerfile`, which run the workflow's
own scripts and write each platform's installer and payload under `dist/installer/<platform>/`
and `dist/payload/<platform>/`.

The desktop stages cross-build from Linux, so they test the scripts and the Rust for those
targets rather than reproducing the release: macOS goes through osxcross and yields the `.app`
without a `.dmg`, from an SDK packaged out of Xcode that Apple does not let anyone redistribute
(`BOWERBIRD_MACOS_SDK` names it, and `release:check` leaves macOS out without one); Windows goes
through cargo-xwin and NSIS. Both build the server's native library without `renditions`,
vcpkg building the codecs only for the machine it runs on. `release:check:remote` is the faithful
check for those two: it pushes HEAD to the `release-check` branch and runs the workflow there,
which builds without releasing.

Comparison is dotted-numeric, suffixes ranked below their release: `1.2.0` beats
`1.2.0-rc1`, so candidates see the shipped `1.2.0` update. This is not full semver;
every compared version comes from `VERSION`.

### 23.9 Models update apart from the app

**The upscaler's model is downloaded by the running app, without an app update.** Our models
live on Hugging Face (`bitnimble/bowerbird`), which publishes commits rather than releases: a
model is its files at a commit. A build carries the model `bundled_upscaler.json` pins, so the
"Best" denoiser works offline and on first launch; `ModelsService` checks `main` beside the app's
own check (§23.5, same ten-minute cache, same quiet failure) and offers a commit that is newer
than the model in use and changed one of its files. A commit that only adds another model offers
nothing.

The reader sees it where they see an app update (§23.6): a sidebar row and a Settings row. Both
ask first, since every photo the upscaler denoises, by its own edit or its library's default, is
then rendered again (`queueDenoisedWith`), so the editor and the renditions agree.

The download is checked against the hub's listing (an LFS file's SHA-256, a git file's blob id),
written beside the catalogue under `models/upscaler/<commit>/`, and recorded in `installed.json`
last, so a kill leaves the model that was in use. The server hands it to every worker's rawshim
(`bb_hold_upscaler_model`), which builds it on the next frame; the editor's page asks which model
is in use before it renders and fetches the downloaded files by commit. At startup a download no
newer than the build's own model is deleted, since an app update may carry a newer one.
