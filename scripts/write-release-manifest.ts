// `release.yml`, which is the only thing a client has to read to find its own download.
//
// An installer's name ends in whichever bundle its platform ships - `.dmg`, `-setup.exe` -
// so a client that built the name itself would 404 the day a platform changed bundler. This
// maps the platform to whatever they actually came out called, and is generated from the
// files that are about to be uploaded rather than from a list somebody maintains.
//
//   bun run scripts/write-release-manifest.ts --dist dist [--image-repo ghcr.io/…]
//
// `--dist` holds one directory per platform: the payload tarball, and whatever installer
// that platform ships.
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PlatformSchema, type ReleaseAsset, type ReleaseManifest } from '../src/schemas/updates';
import { writeReleaseManifest } from '../src/services/updates/release_manifest';
import { GITHUB_REPO } from '../src/services/updates/update_source';
import { VERSION as version } from '../src/version';

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

const dist = resolve(flag('dist') ?? 'dist');
const tag = `v${version}`;

// What a reader downloads and runs, in the order a platform prefers them. An AppImage
// before a deb because it needs no package manager; the NSIS installer before a bare
// exe because it is the one that registers the app.
const INSTALLERS = ['.AppImage', '.dmg', '-setup.exe', '.msi', '.apk', '.deb', '.rpm'];

function installerIn(files: string[]): string | undefined {
  for (const extension of INSTALLERS) {
    const found = files.find((file) => file.endsWith(extension));
    if (found != null) return found;
  }
  return undefined;
}

const assets: Record<string, ReleaseAsset> = {};
for (const entry of readdirSync(dist, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const platform = PlatformSchema.parse(entry.name);
  const dir = join(dist, entry.name);
  const files = readdirSync(dir).filter((file) => statSync(join(dir, file)).isFile());
  const payload = files.find((file) => file.startsWith('bowerbird-payload-'));
  const asset: ReleaseAsset = {};

  const installer = installerIn(files);
  if (installer != null) asset.installer = installer;
  if (payload != null) {
    asset.payload = payload;
    // Streamed rather than read in: a payload is hundreds of megabytes, and the reader on
    // the other end of this hashes it the same way for the same reason.
    const hasher = new Bun.CryptoHasher('sha256');
    for await (const chunk of Bun.file(join(dir, payload)).stream()) hasher.update(chunk);
    asset.payload_sha256 = hasher.digest('hex');
  }
  // The image is the container's installer: there is no file to download, and `docker
  // pull` is what somebody does by hand when the in-place update is not on offer.
  //
  // The repository is named and the tag is not: `docker/metadata-action`'s `{{version}}`
  // strips the `v` off a tag push, so the image is `…:0.2.0` - `…:v0.2.0` is a tag that
  // was never pushed and a `docker pull` that 404s.
  if (platform === 'docker-x86_64') asset.image = `${flag('image-repo') ?? `ghcr.io/${GITHUB_REPO}`}:${version}`;

  if (Object.keys(asset).length > 0) assets[platform] = asset;
}

if (Object.keys(assets).length === 0) throw new Error(`${dist} holds no platform directories, so there is nothing to release`);

const manifest: ReleaseManifest = { version, tag, assets };
const path = join(dist, 'release.yml');
const text = writeReleaseManifest(manifest);
writeFileSync(path, text);
console.log(text);
console.log(`release manifest: ${path}`);
