import { z } from 'zod';

// Which build of Bowerbird an install is, and the key a release names its files by.
// `docker` is a platform here rather than an operating system: the same Linux kernel
// runs both, and what they install is not the same file.
export const PLATFORMS = [
  'linux-x86_64',
  'linux-aarch64',
  'macos-aarch64',
  'macos-x86_64',
  'windows-x86_64',
  'android-aarch64',
  'docker-x86_64',
] as const;
export const PlatformSchema = z.enum(PLATFORMS);
export type Platform = z.infer<typeof PlatformSchema>;

// One platform's files in a release. Every field is optional because a platform can
// offer either half on its own: Android has an installer and can never self-update,
// and a payload with no installer is a build only an existing install can reach.
export const ReleaseAssetSchema = z.object({
  installer: z.string().optional(),
  /** The tarball a supervised install unpacks over itself (DESIGN §23.3). */
  payload: z.string().optional(),
  payload_sha256: z.string().optional(),
  /** Docker's installer, which is a tag rather than a file. */
  image: z.string().optional(),
});
export type ReleaseAsset = z.infer<typeof ReleaseAssetSchema>;

// `release.yml`, attached to every GitHub release. The point of it is that a client
// never has to guess a filename: the binaries carry versions and bundler-chosen
// suffixes, and this maps a platform to whatever they ended up called.
export const ReleaseManifestSchema = z.object({
  version: z.string(),
  tag: z.string(),
  // Partial, because a release is free to leave a platform out - a build that failed,
  // or one that was never asked for. An exhaustive record would refuse the manifest
  // outright and take every other platform's update down with it.
  assets: z.partialRecord(PlatformSchema, ReleaseAssetSchema),
});
export type ReleaseManifest = z.infer<typeof ReleaseManifestSchema>;

/** One release, as the what's-new dialog reads it. */
export const ReleaseNoteSchema = z.object({
  version: z.string(),
  tag: z.string(),
  name: z.string(),
  /** The release description, as markdown. This is the changelog (DESIGN §23.1). */
  notes: z.string(),
  published_at: z.string().nullable(),
  url: z.string(),
});
export type ReleaseNote = z.infer<typeof ReleaseNoteSchema>;

export const UpdateStatusSchema = z.object({
  current: z.string(),
  /** Everything newer than `current`, newest first, so the dialog is cumulative. */
  newer: z.array(ReleaseNoteSchema),
  /** Whether this install can apply an update to itself, rather than only point at one. */
  can_install: z.boolean(),
  /** Where to get it by hand: the installer's download URL, or a docker image tag. */
  install_hint: z.string().nullable(),
  checked_at: z.string().nullable(),
  error: z.string().nullable(),
});
export type UpdateStatus = z.infer<typeof UpdateStatusSchema>;
