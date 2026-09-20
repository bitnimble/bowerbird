/**
 * Where update checks are made, which is GitHub unless a deployment says otherwise.
 *
 * Two URLs, not one: the list of releases, and the files each release carries. Pointing
 * only the first somewhere else would leave every download still going to github.com,
 * which is a mirror that mirrors nothing.
 *
 * So the second is **answered by the first**. A release in the list carries its own
 * `assets[].browser_download_url`, and that is what a download uses when it is there -
 * so an alternate endpoint decides where its own files live and needs no second setting.
 */
export interface UpdateSource {
  /** The releases list, or null where checking is turned off. */
  readonly releases: string | null;
  /**
   * Where a release's file lives when the release itself did not say, or null where there
   * is nothing safe to guess.
   */
  assetUrl(tag: string, file: string): string | null;
}

/**
 * This project, and the one place it is written down.
 *
 * It is here rather than anywhere more obvious because what it *is* is the default for
 * `BOWERBIRD_UPDATE_REPO` - everything else that needs to name the repository (the GHCR
 * image a release manifest points at, §23.2) derives it from this, so a fork changes one
 * line and an environment variable rather than hunting for the string.
 */
export const GITHUB_REPO = 'bitnimble/bowerbird';

/**
 * Where a release said its own file is, or the constructed URL for one that did not.
 *
 * The scheme test is not a privilege boundary - whatever serves the list also publishes
 * the checksum the payload is held to, so it is trusted either way - but Bun's `fetch`
 * follows `file://`, and a field that quietly turned a download into a local read is the
 * kind of thing nobody goes looking for. Anything that is not http(s) falls back.
 */
export function downloadUrl(reported: string | undefined, fallback: string | null): string | null {
  return reported != null && /^https?:\/\//i.test(reported) ? reported : fallback;
}

/**
 * `BOWERBIRD_UPDATE_URL` is the whole endpoint and wins outright; `BOWERBIRD_UPDATE_REPO`
 * names a repository on github.com. Either set to empty turns checking off, for a
 * deployment that must make no outbound request at all - "no endpoint" and "no repository
 * to ask" being the same statement, and neither needing a flag of its own.
 *
 * The endpoint has to answer in GitHub's shape: a list of objects with `tag_name`, `body`,
 * `published_at`, `html_url`, and - for an endpoint that is not github.com - `assets`.
 */
export function updateSource(env: Record<string, string | undefined> = process.env): UpdateSource {
  const repo = (env.BOWERBIRD_UPDATE_REPO ?? GITHUB_REPO).trim();
  const named = env.BOWERBIRD_UPDATE_URL?.trim();
  const releases =
    named != null ? (named === '' ? null : named)
    : repo === '' ? null
    : `https://api.github.com/repos/${repo}/releases?per_page=30`;

  // **Only where github.com is where the list came from.** An endpoint somewhere else has
  // no relationship to any repository - so guessing a github.com URL for a release of its
  // that named no assets would send an air-gapped deployment, configured precisely never
  // to talk to github.com, off to fetch a checksum and a payload from the public repo.
  // Nothing to fall back to is the honest answer, and the caller turns it into one.
  const custom = named != null && named !== '';
  return {
    releases,
    assetUrl: (tag, file) =>
      custom ? null : `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(file)}`,
  };
}
