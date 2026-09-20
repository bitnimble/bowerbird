# Bowerbird design: Releasing, and updating in place

A chapter of [`DESIGN.md`](../../DESIGN.md). The chapters are numbered as one document, so
`DESIGN §N` anywhere in the repo, and a `§N` cited here that is not below, both mean the
section the index in `DESIGN.md` maps §N to.

---

## 23. Releases and updates

A release is a git tag. `.github/workflows/release.yml` builds every platform from it,
attaches the binaries to a GitHub release, publishes the container to GHCR, and writes
one small file - `release.yml` - that says which of those binaries belongs to which
machine. An installed Bowerbird reads that file, decides whether there is anything newer
than itself, downloads the payload for its own platform, and restarts into it.

### 23.1 The changelog is the release description

There is no separate changelog. The release's body on GitHub
is what the app shows, rendered from markdown in `release_notes.tsx`, and the workflow
asks GitHub to generate it from the commits in the tag.

The dialog is **cumulative**: every release newer than the one running, newest first,
rather than only the newest. Somebody who has not opened the app for three months is owed
the three months - a changelog that only ever describes one release is a changelog that is
wrong for everybody who skipped one.

Nothing about that reaches the shipped bundle, which is why it can be this cheap: the notes
are fetched when the dialog is opened, not compiled in, so a typo in a release note is
fixed by editing the release.

### 23.2 `release.yml`: a platform, and what it is called there

The binaries carry versions and bundler-chosen suffixes - `Bowerbird_0.2.0_amd64.deb`,
`Bowerbird_0.2.0_x64-setup.exe` - so a client that built the filename itself would be one
bundler upgrade away from 404ing every platform at once. The manifest maps the platform to
whatever they actually came out called:

```yaml
version: 0.2.0
tag: v0.2.0
assets:
  linux-x86_64:
    installer: Bowerbird_0.2.0_amd64.AppImage
    payload: bowerbird-payload-linux-x86_64.tar.gz
    payload_sha256: 9f2…
  android-aarch64:
    installer: Bowerbird_0.2.0.apk
  docker-x86_64:
    image: ghcr.io/bitnimble/bowerbird:0.2.0
    payload: bowerbird-payload-docker-x86_64.tar.gz
    payload_sha256: 1a3…
```

`installer` is what a person downloads and runs; `payload` is what an installed copy
unpacks over itself. A platform may have either on its own - Android can never replace
itself in place, and a payload with no installer is a build only an existing install can
reach. A platform whose build failed is simply absent, and an install of that platform is
told there is nothing for it rather than handed a 404.

It is **generated from the files about to be uploaded** (`scripts/write-release-manifest.ts`),
not from a list somebody maintains, and read by a reader and a writer that live in one
module with a round-trip test holding them together (`release_manifest.ts`). The format has
no library behind it; that test is the only thing stopping a change to one half from being
a release every installed copy silently cannot read.

### 23.3 The supervisor, and why the app does not update itself

**What the operating system starts is never what an update replaces.**

```
<home>/
  versions/<version>/   payloads, unpacked
  current               which of them to run, or empty for the one that was installed
  previous              what to fall back to when a new one will not start
  staged/               a payload the app has just unpacked
  staged.version        written last, and what says `staged/` is complete
```

`native/launcher` owns that directory and nothing else: it applies whatever is staged,
starts the app out of the version `current` names, and starts it again when the app exits
`75`. It knows nothing about GitHub, releases, or downloads - the app does all of that,
unpacks into `staged/`, and exits.

That division is the whole design. An update never rewrites a file that is currently open,
which Windows refuses outright and which, half done, leaves nothing that can finish the job.
It is also why neither `/Applications` nor `C:\Program Files` is touched: the versions live
in the app-data folder, which is writable without an administrator.

**One implementation, two entry points.** The container's PID 1 is the crate's own binary.
The desktop app is the crate's *library*, called from `src-tauri/src/main.rs` before Tauri
starts: one executable in two roles, told apart by `BOWERBIRD_PAYLOAD`, which only the
supervisor sets. Doing it that way keeps the bundlers out of it - a dmg, an AppImage, a deb
and an NSIS installer package exactly what they packaged before, and the thing the reader
double-clicks is still the thing Tauri built.

Things it does that are worth naming:

- **One place decides a path, one function deletes.** `Slot` names everything the
  supervisor keeps under `home`, `path_of` is the only thing that turns one into a path,
  and `remove` is the only thing in the crate that deletes - so what is deletable is that
  list, and reviewing the list is reviewing all of it. No caller ever holds a path it could
  get wrong, and `versions/` itself is not reachable through it.
  `remove` then checks anyway: the directory it is about to unlink from is resolved and
  has to be inside `home`. `Slot` and `sanitise` between them bound the leaf, and nothing
  bounds the root - `--home` and `BOWERBIRD_HOME` are taken as given. The *parent* is
  resolved rather than the target, deliberately: `canonicalize` follows symlinks, so
  resolving the target would read a planted `versions/x -> /etc` as a request to delete
  `/etc`, refuse, and leave the link there for ever, when unlinking it is both safe and
  the whole job.
- **Rollback.** A version that exits non-zero within thirty seconds of starting - or that
  cannot be started at all - is taken as a bad update rather than a crash, and `previous`
  is put back; failing that, the version the app was installed with. Each step is taken
  once, so a bad version whose predecessor is also bad ends rather than flipping between
  the two for ever. A payload that runs for an hour and *then* crashes is a crash, and
  rolling back would throw away whatever the reader did in that hour.
  `previous` is *emptied* rather than removed as it is used: the guard against going round
  again is that it and `current` agree, and a removal that failed and was ignored used to
  leave it naming the version just stepped over. `current` is written before `previous`,
  because those are two writes and a kill can land between them: selecting the target first
  leaves `previous` stale at a value that now equals `current`, which reads as a re-install
  and steps past, so the target is still tried. The other order leaves the version that just
  failed selected with its predecessor already erased - started once more for nothing, and
  then the rung between skipped.
- **A restart is only a restart when something was staged.** 75 is BSD's `EX_TEMPFAIL` and
  nothing stops an app exiting it for some other reason; taken on trust, that is a crash
  loop with no rollback, since the restart is checked before the rollback is. So the
  supervisor looks for `staged.version` before believing it.
- **Falling back rather than failing.** With no `current`, or one naming a directory that
  is not there, it runs the version that was installed. Deleting the versions directory is
  therefore a supported way back.
- **Signals.** PID 1 has no default disposition for SIGTERM, so the supervisor forwards it.
  Without that, `docker stop` is discarded, the app never hears it, and every stop takes the
  full ten seconds and ends in SIGKILL.

### 23.4 What a payload is

Everything a release changes and nothing a release cannot replace. Not the installer's own
work - the desktop entry, the registry keys, the icon the launcher was registered under -
because none of that is what an update is for, and rewriting it is what needs an
administrator.

| Platform | Payload |
|---|---|
| linux, windows | `bowerbird-app`, `bowerbird-server`, `resources/` |
| macOS | a whole `Bowerbird.app` |
| docker | the image's `/app/payload`: the server, `node_modules`, the three rawshim variants, `web/dist` |

macOS keeps the bundle rather than a bare binary, and that is not tidiness: a window, a menu
bar and a dock icon come from being inside one, so an executable run loose out of
Application Support is a different application to look at.

The container's payload is **taken out of the image** rather than assembled beside it
(`docker cp`), so the tarball and the image cannot be built from different trees - which is
the one way an in-place update could land a container on something `docker pull` would never
produce. It lands on the data volume rather than in the container's writable layer, which is
the difference between an update that survives `docker compose up` and one that is silently
rolled back by the next recreate.

### 23.5 Where the check runs

On the server, in `UpdateService`, and not in the page. The thing being updated is the
install rather than the browser looking at it, so the install is what asks: a phone opening a
NAS is offered the NAS's update, and one call an hour covers however many devices are
watching the same library. The answer is cached for ten minutes, so a page that checks on
launch and hourly costs GitHub at most six calls an hour.

It fails **quietly**. A library on a machine with no route to the internet works perfectly,
and an hourly error toast about a feature nobody asked for is the kind of thing people turn
an app off over. Settings shows the reason; the sidebar simply has no badge.

`can_install` is the server reporting whether it has a supervisor in front of it
(`BOWERBIRD_SUPERVISED`) - without one there is nowhere to unpack a payload and nothing to
restart it, and the dialog offers the installer's download instead of a button that could
only half work.

**Where it looks is a setting, and it is two URLs rather than one** (`update_source.ts`).
`BOWERBIRD_UPDATE_REPO` names a repository on github.com; `BOWERBIRD_UPDATE_URL` replaces
the endpoint outright, for a mirror, an air-gapped release server, or a fork that does not
live on GitHub at all. Either set empty turns checking off.

The second URL - where a release's *files* live - is deliberately not a third setting:
every release in the list carries its own `assets[].browser_download_url`, and that is what
a download uses when it is there. An endpoint therefore says where its own files are. The
constructed `github.com/<repo>/releases/download/<tag>/<file>` is the fallback for a
response that names no assets; on github.com the two agree exactly, which is why this went
unnoticed as dead code until there was somewhere else to point at.

**That fallback applies only when github.com is where the list came from.** An endpoint
somewhere else has no relationship to any repository, so guessing a github.com URL for a
release of its that named no assets would send an air-gapped deployment - configured
precisely never to talk to github.com - off to fetch a checksum and a payload from the
public repo. Having nowhere to fall back to is the honest answer, and a download that
reaches it fails naming the missing `assets`. `install_hint`, which is computed on every
`GET /api/updates`, degrades to the release page instead: a status route is no place to
raise this.

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

Pressing the button downloads the payload, checks it against the manifest's SHA-256, unpacks
it beside the running version and exits. The page then polls until the version answering is
the new one, and reloads. It cannot reload at the click: the server is down between exiting
and being started again, and a page reloaded into that is a blank screen with no way to tell
it was ever working.

### 23.7 What the platforms can and cannot do

| Platform | Ships | Local server | In-place update |
|---|---|---|---|
| linux-x86_64 | AppImage, deb | yes | yes |
| macos-aarch64, macos-x86_64 | dmg | yes | yes |
| windows-x86_64 | NSIS installer | **no** | yes |
| android-aarch64 | apk | no | **no** |
| docker-x86_64 | ghcr image | yes | yes |

**Windows ships shell-only, and lensfun is why.** The server's half of `rawshim` links
lensfun, the pinned libavif and the pinned libjxl (§2), none of which has an MSVC story worth
the week it would cost - so that build carries no server and points at a hosted Bowerbird
(`transport.ts`). Everything the editor does is the browser's GPU and needs none of them.

That is what `src-tauri/tauri.windows.conf.json` is for, and it is not an optimisation:
`externalBin` and `resources` are checked by `build.rs`, so with them left in, a Windows
build fails on a missing sidecar before it compiles a line - which is a confusing way to
discover a platform that was never going to have one.

**Android cannot replace itself at all.** An APK is read-only and the platform will not run
code loaded from the data directory, so the dialog offers the download and the system
installer takes it from there.

**A client pointed at a hosted Bowerbird is offered that server's update, not its own.**
That follows from where the check runs (§23.5) and it is the right answer for the common
case - the server is what holds the library, and a shell talking to one is a transport. It
does mean a desktop app pointed elsewhere has no in-place update of its own; when that
matters, it is a version the shell would have to report and a command of its own, rather
than anything this arrangement is in the way of.

### 23.8 Versions

**The tag is the version, and `scripts/set-version.ts` is what makes the four manifests
agree with it** - `package.json`, `web/package.json`, `tauri.conf.json` and `src-tauri`'s
`Cargo.toml`. Every release job runs it before it builds anything, so a tagged build cannot
ship calling itself something else, which is the failure that leaves an update check
offering a version that is already installed, forever. What is committed in those files is
a placeholder between releases, and `src/version.ts` - `package.json`'s, imported, which is
what the server reports - is a placeholder with it.

Comparison is dotted-numeric with a suffix ranked below its own release, so `1.2.0` beats
`1.2.0-rc1` and shipping `1.2.0` does not leave every release candidate thinking it is
current. It is deliberately not a semver implementation: every version it compares is one
`set-version.ts` wrote.
