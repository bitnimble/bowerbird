Bowerbird is a free, fast RAW photo triage tool with light editing, built for getting through
thousands of photos after a trip.

## stability

Bowerbird is _not_ stable. Decide which risks matter to your workflow:

| Level              | Description                                               | Is it stable?                                                                                                                                                                                     |
| ------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data-stable        | Photos on disk                                            | Yes. Bowerbird moves files but never deletes them. Read-only mode needs no write access to your photo folder.                                                                                     |
| Catalogue-stable   | Libraries, settings, picks/rejects, edits, stacks, albums | No. Schema changes may require a catalogue reset and re-import after an update. Migrations are best-effort; work finished before updating is unaffected by that risk.                             |
| Renderer-stable    | Existing edits look identical after updates               | No. Pipeline changes will likely alter existing renders, usually to fix bugs or improve quality. Rendering will be locked at some point after a stable release, with some consistency guarantees. |
| Application-stable | No crashes                                                | No software can guarantee this.                                                                                                                                                                   |
| Device-stable      | Consistent operation across devices                       | Tested on a Windows PC, Macbook Pro with M5 Pro, and Samsung Galaxy Fold 7. Other devices depend on bug reports.                                                                                  |

## features

- Imports around 50 photos per second from a spinning hard drive or SD card: catalogued,
  thumbnailed, visible in the grid, ready to open at full resolution in viewer or editor.
- Displays the next photo within a single frame.
- HDR-first triage: prerenders RAWs as HDR so exposure headroom is visible before editing.
  Saturated highlights retain colours that regular JPEGs clip to white, especially useful for urban night photos.
- Matches the camera body's colour rendering automatically, including profiles switched between shots.
- Finds lens distortion correction automatically, even without a lens profile; external profiles can be loaded manually.
- Runs on a NAS, keeping photos on bulk storage.
  - View, triage and edit remotely through the web UI. This is the default setup and my main test environment.
  - Run the full app on a travel laptop, import/edit offline, then sync home to the NAS. Multi-way device sync supported.
- Groups similar photos into stacks, tolerating exposure, focus, composition and orientation changes.
- King-of-the-hill stack triage: pairwise comparisons make choosing from a 15-shot burst easier than flicking through all 15.
- Photo merging:
  - Stitches 20 RAWs into panoramas in seconds.
  - Takes best parts from similar frames: replace a blink in a group photo or remove an object using another shot.
- Removes dust and spots automatically at small apertures.
  - Checks multiple library frames to reduce false positives; enabled by default.
- Organises photos into shoots (real folders, one per photo) and albums (collections, many per photo).
- Read-only mode retains ~95% of features without write access to photo folders; it cannot move or delete originals.
- GPU acceleration throughout, with WebGPU-compatible processing for browser RAW editing, including mobile.
- Runs on Mac, Linux, Windows, iPhone and Android. Full editing needs a recent browser (other than Firefox*)
  and graphics support. Viewing/triage needs only a browser that displays JPEGs, potentially even a TV,
  Nintendo 3DS, Apple watch or Samsung fridge.

## coming soon

- Automatic backup to SMB shares without a NAS Docker container. Keep recent and actively edited content
  on the client's SSD, move bulk storage to NAS automatically.
- ML denoise, sharpen and inpainting. Current deterministic processing is fast; ML detail recovery costs
  performance, so this work is deferred.
- Soft proofing in a 3D scene, showing print appearance as its position and lighting change.
- Custom colour mapping and editing.
- Smart grading profiles targeting a consistent look across changes in exposure, colour temperature,
  shading, tint and blur, applicable to individual photos or whole shoots.
- Better Fujifilm / X-Trans support; currently supported but barely tested.
- Scheduled Instagram posts, where 95% of my edited photos go.
- Photo merging:
  - Exposure and focus brackets.
  - Sony pixel shift x4 and x16.
- Collaborative triage/editing, with others' work visible in the same library. Intended for trips
  with partners, family or friends.

## requirements

- Viewing: web browser or installed app.
- Rendering/editing: GPU, integrated graphics sufficient.
  - Docker server renders photos and needs GPU access.
  - Editing uses the client device's GPU.
  - Modern phones can edit, but stability is not guaranteed, especially for high-resolution RAWs.
- About 2-4GB system memory and 2-4GB VRAM per parallel worker.

## who is this for?

I build Bowerbird for my own workflow and share it freely. I don't currently intend to accept many
PRs or feature requests. Fork, modify and redistribute under the MIT licence.

Designed for photographers who:

- Capture large sessions, say 1000 photos.
- Review all of them to keep 10-30%, or 100-300 photos.
- Lightly edit most keepers, say 80% of 300 photos:
  - Spend < 2 minutes per photo.
  - Adjust exposure, colour, denoise, sharpen and geometry (straighten, keystone, crop).
  - Remove small dust spots.
  - Mostly use global edits, without masks or local adjustments.
- Heavily edit a handful, perhaps 10 favourites:
  - Inspect every detail.
  - Use local masks/adjustments, colour mapping and tone curves.

Examples:

- Casual traveller with 1000 holiday photos, many bad (me).
- Event photographer with 1000 expo photos.
- Wedding team with 1000 wedding photos.
- Portrait photographer with 1000 shoot photos.
- Sports photographer with 1000 or more meet photos.
- Bird photographer with 1000 shots of one bird (also me).

These workflows capture many frames under time pressure and triage later. 1000 is illustrative;
my trips often produce 2000, 3000 or 5000 photos.

Less suited to photographers who:

- Compose each shot as carefully as on film.
- Shoot deliberate street photography.
- Use a tripod for every shot, such as landscape work.
- Need a mature RAW processor's full editing tools.
- Need guaranteed identical results when reopening edits in 10 years.

Bowerbird may still help, but those workflows aren't its focus.

## why?

Most of my editing time goes into looking through thousands of photos. Waiting multiple seconds
for each next image wastes hours, especially with originals on my NAS. Copying to SSD first,
then manually back to NAS, adds another chore.

Bowerbird aims to make every second spent triaging and editing useful: fast navigation, clear
images and fewer manual steps. Speed cannot come at the cost of detail needed to judge a photo.

> After years in my backlog, several overseas trips and a growing photo pile finally prompted
> me to build this with Claude. Building a triage tool is, apparently, another way to procrastinate triaging.

## is Bowerbird free?

Yes. Desktop, mobile and self-hosted features stay 100% free, with no paid "pro" mode or ads.

Only possible future monetisation: optional end-to-end encrypted cloud storage/backup, priced near
storage plus egress costs with a small margin. Illustrative price: $10 USD/mo for 1TB, holding
20,000 compressed RAWs at about 50MB each. I'd use it for relatives who won't run Docker.
It would also be open source in this repo, so you could run it on your own blob-storage provider.

## ew, vibe coded junk

Bowerbird wouldn't exist without Claude. Major technical and product decisions are mine;
I don't have full visibility into every line and parts need another audit. Product mistakes
are my responsibility.

I've wanted this for 5 to 10 years but lacked time to build it. Two Claude Max 20x plans let me
build a usable product in spare time over ~2 months, work I estimate would otherwise take years
full-time, or $1-2 million AUD at my previous salary or an experienced engineer's cost.
Usage was roughly 50-100B tokens, equivalent to $40k-$85k AUD at API pricing. Subscriptions cost
$600/mo, $1200 AUD total.

## who are you?

Someone who worked at Canva for a while.

## what does the name mean?

I like birds. Australian bowerbirds collect and arrange bright, shiny things.

## development setup on Windows

`scripts\setup-windows.ps1` installs the build tools with winget, skipping any already there, then
fetches the pinned toolchains and dependencies. Run outside a checkout, it clones the repository
first.

```
powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1
bun run build:app
```

## development formatting

Install Prettier with `bun install` and rustfmt with `rustup component add rustfmt`.

Repository-wide formatting is deferred until the pending branches merge. For now, format only
selected files. See [Formatting in AGENTS.md](AGENTS.md#formatting) for the working rules.

Run `bun run format` to format project files, or `bun run format:check` to check them without writing.
Use `format:prettier` or `format:rust` to run either formatter separately. Their `:check` variants only check.
Rust formatting covers the owned crates, including the desktop shell and local `parking_lot` shim.
Vendored dependencies and generated files are excluded.

To format selected files, run `bunx --no-install prettier --write path/to/file.ts` or
`rustfmt --edition 2024 --config-path rustfmt.toml path/to/file.rs`. To format one Rust crate,
run `bun run scripts/cargo.ts fmt --manifest-path native/heif/Cargo.toml`.
Use the Rust edition declared in the crate's `Cargo.toml` when formatting individual files.
