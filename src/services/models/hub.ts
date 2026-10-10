// The project's models on Hugging Face, which publishes commits rather than releases: a model is
// the files at a commit, each listed with its git blob id and, for a file kept in LFS, its sha256.
// `BOWERBIRD_MODELS_HUB` stands in for Hugging Face.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ModelVersion } from '../../schemas/models';

const REPOSITORY = 'bitnimble/bowerbird';
const TIMEOUT_MS = 10_000;

export interface HubFile {
  name: string;
  size: number;
  git_oid: string;
  /** Null for a file kept in git rather than LFS, which is checked by its git blob id. */
  sha256: string | null;
}

export interface HubModel {
  version: ModelVersion;
  files: HubFile[];
}

// A commit id and nothing else, since it names a directory on disk.
const RevisionSchema = z.object({
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  lastModified: z.string(),
});
const TreeSchema = z.array(
  z.object({
    path: z.string(),
    oid: z.string(),
    size: z.number(),
    lfs: z.object({ oid: z.string() }).optional(),
  }),
);

export function fileUrl(revision: string, name: string): string {
  return `${hub()}/${REPOSITORY}/resolve/${revision}/${name}`;
}

/** These files as `main` has them. */
export async function latest(names: readonly string[]): Promise<HubModel> {
  const main = RevisionSchema.parse(await api('revision/main'));
  const tree = TreeSchema.parse(await api(`tree/${main.sha}`));
  const files = names.map((name): HubFile => {
    const entry = tree.find((candidate) => candidate.path === name);
    if (entry == null) throw new Error(`${REPOSITORY} has no ${name} at ${main.sha}`);
    return { name, size: entry.size, git_oid: entry.oid, sha256: entry.lfs?.oid ?? null };
  });
  return { version: { revision: main.sha, committed_at: main.lastModified }, files };
}

/** Whether `bytes` are the file the hub listed. */
export function matches(file: HubFile, bytes: Uint8Array): boolean {
  if (file.sha256 != null) return createHash('sha256').update(bytes).digest('hex') === file.sha256;
  const blob = createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes);
  return blob.digest('hex') === file.git_oid;
}

function hub(): string {
  return process.env.BOWERBIRD_MODELS_HUB || 'https://huggingface.co';
}

async function api(path: string): Promise<unknown> {
  const url = `${hub()}/api/models/${REPOSITORY}/${path}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}
