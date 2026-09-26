import { mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { deleteUpdateStaging } from '../../utils/deletions';
import { Logger } from '../../logger';
import { VERSION } from '../../version';
import {
  PlatformSchema,
  type Platform,
  type ReleaseManifest,
  type ReleaseNote,
  type UpdateStatus,
} from '../../schemas/updates';
import { isNewer, parseReleaseManifest } from './release_manifest';
import { downloadUrl, updateSource } from './update_source';

const log = new Logger('updates');

/**
 * What the app exits with to ask its supervisor to restart it (DESIGN §23.3).
 *
 * `launcher::RESTART` in `native/launcher/src/lib.rs` is the same number, and the two
 * have no way to share it. A change on one side alone is an update that unpacks, stages,
 * and then exits for good instead of coming back on the new version.
 */
const RESTART_EXIT_CODE = 75;

/** The release the manifest is attached to, so nothing has to guess a filename. */
const MANIFEST_ASSET = 'release.yml';

const CHECK_CACHE_MS = 10 * 60 * 1000;
const CHECK_TIMEOUT_MS = 10_000;

/** How long a payload download may go without a byte arriving before it is abandoned. */
const DOWNLOAD_IDLE_MS = 60_000;

const GithubReleaseSchema = z.object({
  tag_name: z.string(),
  // Optional past GitHub's own shape: a `BOWERBIRD_UPDATE_URL` endpoint owes only what `updateSource` names.
  name: z.string().nullish(),
  body: z.string().nullish(),
  draft: z.boolean().default(false),
  prerelease: z.boolean().default(false),
  published_at: z.string().nullable(),
  html_url: z.string(),
  /**
   * Where this release's files actually live, which only the endpoint serving it knows.
   *
   * Optional because the fallback is the github.com path shape, and on github.com the two
   * agree exactly - it is an endpoint somewhere else that needs to be believed rather than
   * have a URL built for it (`update_source.ts`).
   */
  assets: z.array(z.object({ name: z.string(), browser_download_url: z.string() })).optional(),
});
type GithubRelease = z.infer<typeof GithubReleaseSchema>;

/**
 * Whether this install can replace itself, and where it keeps the versions if it can.
 *
 * Set by `native/launcher`, and by nothing else: an install with no supervisor in front
 * of it has nowhere to put a new payload and nothing to restart it, so it is told to
 * download the installer instead of being offered a button that could only half work.
 */
function supervisorHome(): string | null {
  const home = process.env.BOWERBIRD_HOME;
  if (home == null || home.trim() === '' || process.env.BOWERBIRD_SUPERVISED !== '1') return null;
  // Absolute or nothing. A relative one resolves against this process's working directory
  // rather than against anything the supervisor made, so every path downstream would be
  // somewhere else entirely - and "no supervisor" is a better answer than an update that
  // unpacks into the wrong place and is then never found.
  return path.isAbsolute(home) ? home : null;
}

function detectPlatform(): Platform {
  // The Dockerfile says so outright rather than being sniffed for: the image runs the
  // same Linux as a desktop build and installs an entirely different file.
  const declared = process.env.BOWERBIRD_PLATFORM;
  if (declared != null && declared !== '') return PlatformSchema.parse(declared);
  const arm = process.arch === 'arm64';
  if (process.platform === 'darwin') return arm ? 'macos-arm64' : 'macos-x86_64';
  if (process.platform === 'win32') return 'windows-x86_64';
  // `linux-arm64` is a platform no release builds for, which is the point: a NAS on
  // ARM reports what it is and is offered nothing, rather than being handed x86 bytes.
  return arm ? 'linux-arm64' : 'linux-x86_64';
}

/** What is on GitHub, what this install is, and how to get from one to the other (§23.5). */
export class UpdateService {
  private readonly source = updateSource();
  private readonly platform = detectPlatform();

  /** Guards `apply` against a second press while the first is still fetching. */
  private downloading = false;
  private error: string | null = null;
  private checkedAt: number | null = null;
  private releases: GithubRelease[] = [];
  private inFlight: Promise<void> | null = null;
  private readonly manifests = new Map<string, ReleaseManifest>();

  /** Cached, so a page that checks hourly on three devices is not three calls an hour. */
  async check(force = false): Promise<UpdateStatus> {
    const endpoint = this.source.releases;
    if (endpoint == null) return this.status();
    const fresh = this.checkedAt != null && Date.now() - this.checkedAt < CHECK_CACHE_MS;
    if (!force && fresh) return this.status();
    // A manifest is cached by tag and a tag can be republished - a bad release fixed and
    // re-uploaded under the same name is an ordinary thing for CI to do. Held for the life
    // of the process, the corrected payload would then fail its checksum for ever, and
    // "go and look again" is exactly when somebody is asking about that.
    if (force) this.manifests.clear();
    this.inFlight ??= this.fetchReleases(endpoint).finally(() => (this.inFlight = null));
    await this.inFlight;
    return this.status();
  }

  status(): UpdateStatus {
    const newer = this.newerReleases();
    return {
      current: VERSION,
      newer,
      can_install: supervisorHome() != null && newer.length > 0,
      install_hint: this.installHint(newer[0]),
      checked_at: this.checkedAt == null ? null : new Date(this.checkedAt).toISOString(),
      error: this.error,
    };
  }

  /**
   * Downloads the newest release's payload, checks it, and unpacks it beside the running
   * one - then exits so the supervisor can swap them in and start the new version.
   *
   * The exit is the last thing and it is deliberate: nothing on disk is replaced by this
   * process, so a failure anywhere above leaves the install exactly as it was.
   */
  async apply(): Promise<void> {
    const home = supervisorHome();
    if (home == null) throw new Error('this install has no supervisor to restart it, so it cannot update itself');
    const release = this.newerReleases()[0];
    if (release == null) throw new Error('there is nothing newer than this version to install');
    if (this.downloading) throw new Error('an update is already being downloaded');

    // Never cleared on success, only on failure: what follows a successful stage is this
    // process exiting, and the quarter second it waits to do that is a window a second
    // press would otherwise unpack a second payload into.
    this.downloading = true;
    this.error = null;
    try {
      const manifest = await this.manifestFor(release.tag);
      const asset = manifest.assets[this.platform];
      if (asset?.payload == null || asset.payload_sha256 == null) {
        throw new Error(`release ${manifest.version} carries no payload for ${this.platform}`);
      }
      await stagePayload(home, {
        url: this.assetUrl(release.tag, asset.payload),
        filename: asset.payload,
        sha256: asset.payload_sha256,
        version: manifest.version,
      });
    } catch (err) {
      this.downloading = false;
      this.error = err instanceof Error ? err.message : String(err);
      throw err;
    }

    log.info('an update is staged; exiting for the supervisor to apply it', { version: release.version });
    // After the response has gone out. The caller is a route handler, and a process that
    // exits inside one answers nothing at all.
    setTimeout(() => process.exit(RESTART_EXIT_CODE), 250);
  }

  private newerReleases(): ReleaseNote[] {
    return this.releases
      .filter((release) => isNewer(release.tag_name.replace(/^v/, ''), VERSION))
      .map((release) => ({
        version: release.tag_name.replace(/^v/, ''),
        tag: release.tag_name,
        name: release.name ?? release.tag_name,
        notes: release.body ?? '',
        published_at: release.published_at,
        url: release.html_url,
      }));
  }

  private installHint(newest: ReleaseNote | undefined): string | null {
    if (newest == null) return null;
    const asset = this.manifests.get(newest.tag)?.assets[this.platform];
    if (asset?.image != null) return asset.image;
    // The nullable one, because this runs inside `status()` and so on every `GET
    // /api/updates`: an endpoint that named no assets would otherwise turn the route that
    // reports there is an update into a 500. The release page is the honest hint there.
    if (asset?.installer != null) return this.maybeAssetUrl(newest.tag, asset.installer) ?? newest.url;
    return newest.url;
  }

  /** What the release itself says, or the github.com shape where that is where it came from. */
  private maybeAssetUrl(tag: string, file: string): string | null {
    const named = this.releases
      .find((release) => release.tag_name === tag)
      ?.assets?.find((candidate) => candidate.name === file);
    return downloadUrl(named?.browser_download_url, this.source.assetUrl(tag, file));
  }

  /** The same, where having nowhere to fetch from is the end of whatever asked. */
  private assetUrl(tag: string, file: string): string {
    const url = this.maybeAssetUrl(tag, file);
    if (url == null) {
      throw new Error(
        `release ${tag} names no download for ${file}, and BOWERBIRD_UPDATE_URL is not github.com ` +
          'so there is nowhere to guess: the endpoint has to report an `assets` list',
      );
    }
    return url;
  }

  private async manifestFor(tag: string): Promise<ReleaseManifest> {
    const held = this.manifests.get(tag);
    if (held != null) return held;
    const response = await fetch(this.assetUrl(tag, MANIFEST_ASSET), {
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`release ${tag} publishes no ${MANIFEST_ASSET} (the server answered ${response.status})`);
    const manifest = parseReleaseManifest(await response.text());
    this.manifests.set(tag, manifest);
    return manifest;
  }

  // Handed the endpoint rather than reading it back off `source`, so that "checking is
  // turned off" is settled by the one caller that can act on it rather than asserted here.
  private async fetchReleases(endpoint: string): Promise<void> {
    try {
      const response = await fetch(endpoint, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `bowerbird/${VERSION}` },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`${endpoint} answered ${response.status}`);
      const body = z.array(GithubReleaseSchema).parse(await response.json());
      this.releases = body.filter((release) => !release.draft && !release.prerelease);
      this.checkedAt = Date.now();
      this.error = null;
      // The newest release's manifest, so `install_hint` has a filename to point at
      // without a second round trip when the dialog opens.
      const newest = this.newerReleases()[0];
      if (newest != null) await this.manifestFor(newest.tag).catch(() => undefined);
    } catch (err) {
      // `debug`, not `warn`: this runs hourly whether or not anybody asked, and a machine
      // with no route to the internet would otherwise fill its log with it (§23.5).
      this.error = err instanceof Error ? err.message : String(err);
      log.debug('could not ask GitHub what the newest release is', { err: this.error });
    }
  }
}

export interface Payload {
  url: string;
  /** As the release published it; only its basename reaches the filesystem. */
  filename: string;
  sha256: string;
  version: string;
}

/**
 * Downloads a payload and leaves it where the supervisor will find it (DESIGN §23.3).
 *
 * Exported so it can be driven against a local server and a real tarball: this is the one
 * function here that writes to disk, and the order it writes in is what makes a kill at
 * any point survivable.
 */
export async function stagePayload(home: string, payload: Payload): Promise<void> {
  const download = path.join(home, 'download');
  await deleteUpdateStaging(home, 'download');
  await deleteUpdateStaging(home, 'staged');
  mkdirSync(download, { recursive: true });

  // `basename`, because the name is read out of a file fetched over the network: joined
  // as it stands, a payload called `../../something` writes outside the scratch directory
  // this is allowed to touch.
  const tarball = path.join(download, path.basename(payload.filename));
  // Idle rather than overall, and that is the whole reason this is not `AbortSignal.timeout`
  // like the checks are: a payload is hundreds of megabytes and a slow line can legitimately
  // spend an hour on one, so any deadline long enough not to cut that off is too long to be
  // a guard. What must not happen is a connection that accepts and then says nothing -
  // unbounded, that wedges the service's `downloading` true for the life of the process and
  // every later press is refused with "an update is already being downloaded".
  const stalled = new AbortController();
  let idle = setTimeout(() => stalled.abort(), DOWNLOAD_IDLE_MS);
  try {
    const response = await fetch(payload.url, { signal: stalled.signal });
    if (!response.ok || response.body == null) {
      throw new Error(`could not download ${payload.filename}: the server answered ${response.status}`);
    }
    // Streamed to disk and hashed on the way past, rather than held: a payload is hundreds
    // of megabytes, and this runs on machines whose whole job is to have room for photographs.
    const hasher = new Bun.CryptoHasher('sha256');
    const sink = Bun.file(tarball).writer();
    for await (const chunk of response.body) {
      clearTimeout(idle);
      idle = setTimeout(() => stalled.abort(), DOWNLOAD_IDLE_MS);
      hasher.update(chunk);
      sink.write(chunk);
    }
    await sink.end();
    if (hasher.digest('hex') !== payload.sha256) {
      throw new Error(`${payload.filename} does not match the checksum the release published`);
    }
  } finally {
    clearTimeout(idle);
  }

  // Unpacked into a directory of its own, then named at the end. A tar interrupted
  // half way would otherwise leave a `staged` the supervisor would happily install.
  const unpacking = path.join(download, 'unpacking');
  mkdirSync(unpacking, { recursive: true });
  await untar(tarball, unpacking);
  renameSync(unpacking, path.join(home, 'staged'));
  // Last, because this file is what the supervisor reads to decide there is anything
  // to apply: written before the directory is complete, a kill mid-unpack installs it.
  await Bun.write(path.join(home, 'staged.version'), `${payload.version}\n`);
  await deleteUpdateStaging(home, 'download');
}

/**
 * ponytail: the system's `tar`, rather than an archive dependency. It is on every
 * platform this ships to - Windows has carried bsdtar as `tar.exe` since 1803 - and the
 * only tarball it ever opens is one this repo's release workflow wrote.
 *
 * **No `-P`, and nothing that relaxes what tar refuses by default.** Measured against GNU
 * tar: a `../` member is refused outright and exits 2, an absolute member has its leading
 * `/` stripped and lands inside `into`, and a symlink pointing out of the tree is replaced
 * rather than followed, which also exits 2. Two of those three only stay contained because
 * the non-zero exit below is treated as a failure - so a caller that learned to ignore it,
 * or a `-P` added to make some archive "work", is what turns this into a write anywhere on
 * the disk. The checksum above is the real control; this is what stands behind it.
 */
async function untar(tarball: string, into: string): Promise<void> {
  const proc = Bun.spawn(['tar', '-xzf', tarball, '-C', into], { stdout: 'pipe', stderr: 'pipe' });
  const [status, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (status !== 0) throw new Error(`could not unpack ${path.basename(tarball)}: ${stderr.trim() || `tar exited ${status}`}`);
}
