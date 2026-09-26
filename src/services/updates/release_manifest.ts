import { ReleaseManifestSchema, type ReleaseManifest } from '../../schemas/updates';

/**
 * `release.yml`, written and read here and nowhere else.
 *
 * ponytail: a hand-rolled reader for two levels of mapping, rather than a YAML
 * dependency, because the only YAML this ever meets is what `write` a few lines below
 * produced. `round_trips` pins the pair together; anything richer than
 * `key: value` under `assets: <platform>:` is not a document this format has.
 */
export function parseReleaseManifest(text: string): ReleaseManifest {
  const top: Record<string, unknown> = {};
  const assets: Record<string, Record<string, string>> = {};
  let platform: string | null = null;

  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const [key, ...rest] = line.trim().split(':');
    const value = unquote(rest.join(':').trim());

    if (indent === 0) {
      if (key === 'assets') {
        top.assets = assets;
        platform = null;
        continue;
      }
      top[key!] = value;
      continue;
    }
    if (indent === 2) {
      platform = key!;
      assets[platform] = {};
      continue;
    }
    if (platform == null) throw new Error(`release.yml: "${line.trim()}" is indented under nothing`);
    assets[platform]![key!] = value;
  }

  return ReleaseManifestSchema.parse(top);
}

export function writeReleaseManifest(manifest: ReleaseManifest): string {
  const lines = [`version: ${quote(manifest.version)}`, `tag: ${quote(manifest.tag)}`, 'assets:'];
  for (const [platform, asset] of Object.entries(manifest.assets)) {
    lines.push(`  ${platform}:`);
    for (const [field, value] of Object.entries(asset)) {
      if (value != null) lines.push(`    ${field}: ${quote(value)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

// A version is the one value here a bare YAML scalar would read back as a number.
const BARE = /^[A-Za-z][A-Za-z0-9._/:+-]*$/;

function quote(value: string): string {
  return BARE.test(value) ? value : `"${value.replaceAll('"', '\\"')}"`;
}

function unquote(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"') || value.length < 2) return value;
  return value.slice(1, -1).replaceAll('\\"', '"');
}

/**
 * Newest first, by dotted numeric parts, with anything after the numbers ignored.
 *
 * Deliberately not a semver implementation: a prerelease suffix sorting *below* its
 * own release is the one rule that matters, and every version this compares is one
 * written in `VERSION`.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string): number[] => v.replace(/^v/, '').split(/[.+-]/).map((p) => Number.parseInt(p, 10));
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    // A part that is not there reads as 0, so 1.2 and 1.2.0 are the same version. A
    // part that is there and is not a number reads as -1, which is what puts
    // 1.2.0-rc1 below 1.2.0 rather than level with it.
    const lv = rank(left[i]);
    const rv = rank(right[i]);
    if (lv !== rv) return lv - rv;
  }
  return 0;
}

function rank(part: number | undefined): number {
  if (part == null) return 0;
  return Number.isNaN(part) ? -1 : part;
}

export function isNewer(candidate: string, than: string): boolean {
  return compareVersions(candidate, than) > 0;
}
